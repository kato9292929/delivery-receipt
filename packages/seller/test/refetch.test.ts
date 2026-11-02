import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReceipt, decodeReceipt, RECEIPT_HEADER, REFETCH_HEADER, type WellKnown } from "@x402jp/delivery-receipt-verify";
import {
  createReceiptSeller,
  MemoryStore,
  withDeliveryReceipts,
  wellKnownResponse,
  type PaymentRequirement,
} from "../src/index.ts";
import {
  MockChain,
  RESOURCE,
  b64json,
  baseRequirement,
  clock,
  evmPaymentHeader,
  fakeSolanaTxId,
  newBuyer,
  newSeed,
  solanaPaymentHeader,
  solanaRequirement,
} from "./helpers.ts";

const BODY = '{"report":"quarterly numbers","rows":[1,2,3]}';

/**
 * Harness: a fake x402 gate (`paywalled`) that "settles" by writing to the mock
 * chain and returns PAYMENT-RESPONSE, plus the real handler.
 */
function setup(requirement: PaymentRequirement, settleTx?: () => string) {
  const c = clock();
  const store = new MemoryStore(() => c.now().getTime());
  const chain = new MockChain();
  const seller = createReceiptSeller({ signingKey: newSeed(), store, chain, now: c.now });
  const calls = { paywalled: 0, handler: 0 };
  const handler = async (req: Request) => {
    calls.handler++;
    assert.equal(req.headers.get("payment-signature"), null, "handler must not see the payment header");
    return new Response(BODY, { headers: { "content-type": "application/json" } });
  };
  const paywalled = async (req: Request) => {
    calls.paywalled++;
    const res = await handler(req.headers.has("payment-signature") ? new Request(req.url) : req);
    const raw = JSON.parse(Buffer.from(req.headers.get("payment-signature")!, "base64").toString());
    const transaction = settleTx ? settleTx() : "0x" + "ee".repeat(32);
    const payer = raw.payload.authorization?.from ?? "buyer";
    const headers = new Headers(res.headers);
    headers.set("PAYMENT-RESPONSE", b64json({ success: true, transaction, network: requirement.network, payer }));
    return new Response(await res.arrayBuffer(), { status: 200, headers });
  };
  const app = withDeliveryReceipts(seller, { paywalled, handler, resource: RESOURCE, requirement });
  const get = (headers: Record<string, string>) => app(new Request(RESOURCE, { headers }));
  return { seller, store, chain, calls, app, get, clock: c, wellKnown: seller.wellKnown() };
}

test("first paid delivery carries a verifiable receipt and is recorded", async () => {
  const s = setup(baseRequirement);
  const buyer = newBuyer();
  const { header, nonce } = await evmPaymentHeader(buyer);
  const res = await s.get({ "PAYMENT-SIGNATURE": header });
  assert.equal(res.status, 200);
  const body = new Uint8Array(await res.arrayBuffer());
  const v = verifyReceipt({ header: res.headers.get(RECEIPT_HEADER), body, wellKnown: s.wellKnown, expect: { payment_id: nonce, resource: RESOURCE } });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.receipt.delivery, "first");
  assert.match(res.headers.get("access-control-expose-headers") ?? "", /X-Delivery-Receipt/);
  const rec = await s.store.get(nonce.toLowerCase());
  assert.equal(rec?.payer, buyer.address.toLowerCase());
  assert.equal(Buffer.from(rec!.body, "base64").toString(), BODY);
});

test("well-known document", async () => {
  const s = setup(baseRequirement);
  const doc = (await wellKnownResponse(s.seller).json()) as WellKnown;
  assert.equal(doc.refetch_window_s, 604800);
  assert.equal(doc.refetch_header, REFETCH_HEADER);
  assert.equal(doc.keys[0].alg, "Ed25519");
  assert.equal(doc.keys[0].key_id, s.seller.keyId);
});

test("EVM refetch: all five branches; /settle never called on refetch", async () => {
  const s = setup(baseRequirement);
  const buyer = newBuyer();
  const { header, nonce } = await evmPaymentHeader(buyer);
  const first = await s.get({ "PAYMENT-SIGNATURE": header });
  assert.equal(first.status, 200);
  assert.equal(s.calls.paywalled, 1);

  // (a) record exists, within window -> 200 stored body, delivery "refetch"
  const r1 = await s.get({ "PAYMENT-SIGNATURE": header, [REFETCH_HEADER]: nonce });
  assert.equal(r1.status, 200);
  const b1 = new Uint8Array(await r1.arrayBuffer());
  assert.equal(Buffer.from(b1).toString(), BODY);
  const v1 = verifyReceipt({ header: r1.headers.get(RECEIPT_HEADER), body: b1, wellKnown: s.wellKnown, expect: { payment_id: nonce } });
  assert.equal(v1.ok && v1.receipt.delivery, "refetch");
  assert.equal(s.calls.handler, 1, "record path does not call the handler");

  // v1 header name works too
  assert.equal((await s.get({ "X-PAYMENT": header, [REFETCH_HEADER]: nonce })).status, 200);

  // (b) signer mismatch
  const attacker = newBuyer();
  //   nonce in header != payment_id
  const other = await evmPaymentHeader(buyer);
  assert.equal((await s.get({ "PAYMENT-SIGNATURE": other.header, [REFETCH_HEADER]: nonce })).status, 402);
  //   attacker signs their own authorization with the victim's nonce: recovers fine, but != stored payer
  const forged = await evmPaymentHeader(attacker, baseRequirement, { nonce });
  assert.equal((await s.get({ "PAYMENT-SIGNATURE": forged.header, [REFETCH_HEADER]: nonce })).status, 402);
  //   claims from=victim but signed by attacker: does not recover to from
  const spoofed = await evmPaymentHeader(buyer, baseRequirement, { nonce, signer: attacker });
  assert.equal((await s.get({ "PAYMENT-SIGNATURE": spoofed.header, [REFETCH_HEADER]: nonce })).status, 402);
  //   no payment header at all
  assert.equal((await s.get({ [REFETCH_HEADER]: nonce })).status, 402);

  // (c) no record, but settled on chain -> handler generates body, record created
  const buyer2 = newBuyer();
  const p2 = await evmPaymentHeader(buyer2);
  s.chain.settle(p2.nonce, buyer2.address, s.clock.now());
  assert.equal(await s.store.get(p2.nonce), null);
  const r2 = await s.get({ "PAYMENT-SIGNATURE": p2.header, [REFETCH_HEADER]: p2.nonce });
  assert.equal(r2.status, 200);
  const b2 = new Uint8Array(await r2.arrayBuffer());
  assert.equal(Buffer.from(b2).toString(), BODY);
  assert.equal(verifyReceipt({ header: r2.headers.get(RECEIPT_HEADER), body: b2, wellKnown: s.wellKnown }).ok, true);
  assert.equal(s.calls.handler, 2);
  assert.ok(await s.store.get(p2.nonce));
  //   the chain path with a forged signer is still refused
  const forged2 = await evmPaymentHeader(attacker, baseRequirement, { nonce: p2.nonce });
  assert.equal((await s.get({ "PAYMENT-SIGNATURE": forged2.header, [REFETCH_HEADER]: p2.nonce })).status, 402);

  // (d) neither record nor on-chain payment -> 402
  const p3 = await evmPaymentHeader(newBuyer());
  const r3 = await s.get({ "PAYMENT-SIGNATURE": p3.header, [REFETCH_HEADER]: p3.nonce });
  assert.equal(r3.status, 402);
  assert.equal(((await r3.json()) as { error: string }).error, "refetch_refused");

  // (e) past the window -> 410 refetch_expired
  s.clock.advance(604800 + 1);
  const r4 = await s.get({ "PAYMENT-SIGNATURE": header, [REFETCH_HEADER]: nonce });
  assert.equal(r4.status, 410);
  assert.deepEqual(await r4.json(), { error: "refetch_expired" });

  assert.equal(s.calls.paywalled, 1, "the x402 gate (verify/settle) ran only for the original purchase");
});

test("window is anchored at the original issued_at, not at the last refetch", async () => {
  const s = setup(baseRequirement);
  const buyer = newBuyer();
  const { header, nonce } = await evmPaymentHeader(buyer);
  await s.get({ "PAYMENT-SIGNATURE": header });
  s.clock.advance(604800 - 10);
  assert.equal((await s.get({ "PAYMENT-SIGNATURE": header, [REFETCH_HEADER]: nonce })).status, 200);
  s.clock.advance(20);
  assert.equal((await s.get({ "PAYMENT-SIGNATURE": header, [REFETCH_HEADER]: nonce })).status, 410);
});

test("chain path: window measured from block time -> 410 when old", async () => {
  const s = setup(baseRequirement);
  const buyer = newBuyer();
  const p = await evmPaymentHeader(buyer);
  s.chain.settle(p.nonce, buyer.address, new Date(s.clock.now().getTime() - 8 * 86400 * 1000));
  const r = await s.get({ "PAYMENT-SIGNATURE": p.header, [REFETCH_HEADER]: p.nonce });
  assert.equal(r.status, 410);
  assert.equal(s.calls.handler, 0);
});

test("chain RPC failure -> 503, not a false 402", async () => {
  const s = setup(baseRequirement);
  s.chain.findPayment = async () => {
    throw new Error("rpc down");
  };
  const errors: unknown[] = [];
  const seller = createReceiptSeller({ signingKey: newSeed(), store: s.store, chain: s.chain, onError: (e) => errors.push(e) });
  const app = withDeliveryReceipts(seller, { paywalled: async () => new Response(null, { status: 402 }), handler: async () => new Response("x"), resource: RESOURCE, requirement: baseRequirement });
  const p = await evmPaymentHeader(newBuyer());
  const r = await app(new Request(RESOURCE, { headers: { "PAYMENT-SIGNATURE": p.header, [REFETCH_HEADER]: p.nonce } }));
  assert.equal(r.status, 503);
  assert.equal(errors.length, 1);
});

test("Solana refetch: record path, signer mismatch, chain path, not found", async () => {
  let nextTx = fakeSolanaTxId();
  const s = setup(solanaRequirement, () => nextTx);
  const buyer = solanaPaymentHeader();
  const first = await s.get({ "PAYMENT-SIGNATURE": buyer.header });
  assert.equal(first.status, 200);
  const firstBody = new Uint8Array(await first.arrayBuffer());
  const receipt = decodeReceipt(first.headers.get(RECEIPT_HEADER)!);
  assert.equal(receipt.payment_id, nextTx, "Solana payment_id is the settle response transaction");
  assert.equal(receipt.network, solanaRequirement.network);
  assert.equal(verifyReceipt({ header: first.headers.get(RECEIPT_HEADER), body: firstBody, wellKnown: s.wellKnown }).ok, true);
  assert.equal((await s.store.get(nextTx))?.payer, buyer.payerSig);

  // record path
  const r1 = await s.get({ "PAYMENT-SIGNATURE": buyer.header, [REFETCH_HEADER]: nextTx });
  assert.equal(r1.status, 200);
  assert.equal(await r1.text(), BODY);

  // another payer's tx header cannot claim this payment_id
  const other = solanaPaymentHeader();
  assert.equal((await s.get({ "PAYMENT-SIGNATURE": other.header, [REFETCH_HEADER]: nextTx })).status, 402);

  // a header whose signature does not verify against the message is refused
  const raw = JSON.parse(Buffer.from(buyer.header, "base64").toString());
  const wire = Buffer.from(raw.payload.transaction, "base64");
  wire[wire.length - 1] ^= 1;
  raw.payload.transaction = wire.toString("base64");
  assert.equal((await s.get({ "PAYMENT-SIGNATURE": b64json(raw), [REFETCH_HEADER]: nextTx })).status, 402);

  // chain path
  const b2 = solanaPaymentHeader();
  const tx2 = fakeSolanaTxId();
  s.chain.settle(tx2, b2.payerSig, s.clock.now());
  const r2 = await s.get({ "PAYMENT-SIGNATURE": b2.header, [REFETCH_HEADER]: tx2 });
  assert.equal(r2.status, 200);
  assert.equal(await r2.text(), BODY);
  assert.equal((await s.store.get(tx2))?.payer, b2.payerSig);

  // neither
  const b3 = solanaPaymentHeader();
  assert.equal((await s.get({ "PAYMENT-SIGNATURE": b3.header, [REFETCH_HEADER]: fakeSolanaTxId() })).status, 402);

  assert.equal(s.calls.paywalled, 1);
  nextTx = "";
});

test("unpaid / failed responses pass through without a receipt", async () => {
  const c = clock();
  const seller = createReceiptSeller({ signingKey: newSeed(), store: new MemoryStore(), chain: new MockChain(), now: c.now });
  const app = withDeliveryReceipts(seller, {
    paywalled: async () => new Response('{"error":"payment required"}', { status: 402 }),
    handler: async () => new Response("x"),
    resource: RESOURCE,
    requirement: baseRequirement,
  });
  const r = await app(new Request(RESOURCE));
  assert.equal(r.status, 402);
  assert.equal(r.headers.get(RECEIPT_HEADER), null);

  const failedSettle = withDeliveryReceipts(seller, {
    paywalled: async () => new Response("x", { headers: { "PAYMENT-RESPONSE": b64json({ success: false }) } }),
    handler: async () => new Response("x"),
    resource: RESOURCE,
    requirement: baseRequirement,
  });
  const r2 = await failedSettle(new Request(RESOURCE, { headers: { "PAYMENT-SIGNATURE": (await evmPaymentHeader(newBuyer())).header } }));
  assert.equal(r2.headers.get(RECEIPT_HEADER), null);
});
