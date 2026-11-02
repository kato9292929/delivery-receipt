import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWellKnown, refetch, verifyReceipt, RECEIPT_HEADER } from "@x402jp/delivery-receipt-verify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildPaymentHeader } from "../src/mock.ts";
import { scenario402BeforeSettle, scenarioCutAfterSettle } from "../src/run.ts";
import { startLocalSeller } from "../src/server.ts";

const EXPECTED = JSON.stringify({
  title: "Tokyo office-rent index (demo)",
  period: "2026-Q3",
  values: [{ ward: "Chiyoda", yen_per_tsubo: 38120 }, { ward: "Minato", yen_per_tsubo: 35990 }],
});

test("normal purchase returns a receipt that verifies", async () => {
  const s = await startLocalSeller();
  try {
    const { header, nonce } = await buildPaymentHeader(privateKeyToAccount(generatePrivateKey()));
    const r = await fetch(s.url, { headers: { "PAYMENT-SIGNATURE": header } });
    assert.equal(r.status, 200);
    const body = new Uint8Array(await r.arrayBuffer());
    const wk = await fetchWellKnown(s.origin);
    const v = verifyReceipt({ header: r.headers.get(RECEIPT_HEADER), body, wellKnown: wk, expect: { payment_id: nonce, resource: s.url } });
    assert.equal(v.ok, true);
    // Replaying the same payment as a new purchase is rejected by the facilitator (nonce used)...
    const replay = await fetch(s.url, { headers: { "PAYMENT-SIGNATURE": header } });
    assert.equal(replay.status, 402);
    // ...but refetch works and does not settle again.
    const again = await refetch({ url: s.url, paymentHeaders: { "PAYMENT-SIGNATURE": header }, paymentId: nonce });
    assert.equal(again.ok, true);
    assert.equal(s.facilitator.settleCalls, 1);
  } finally {
    await s.close();
  }
});

test("scenario 1: settled, connection cut before body -> refetch delivers from the record", async () => {
  const s = await startLocalSeller();
  try {
    const r = await scenarioCutAfterSettle(s);
    assert.match(r.firstAttempt, /network error/, "buyer never received the first response");
    assert.equal(r.refetch.ok, true, JSON.stringify(r.refetch));
    assert.ok(r.refetch.ok);
    assert.equal(Buffer.from(r.refetch.body).toString(), EXPECTED);
    assert.equal(r.refetch.receipt.delivery, "refetch");
    assert.equal(r.settleCalls, 1, "refetch did not settle again");
    assert.equal(s.stats.handlerCalls, 1, "body came from the stored record");
    // refetch() only returns ok after verifyReceipt passed against /.well-known/x402-receipt.json.
    assert.equal(r.refetch.receipt.key_id, (await fetchWellKnown(s.origin)).keys[0].key_id);
  } finally {
    await s.close();
  }
});

test("scenario 2: 402 without waiting for /settle, settled on chain -> refetch via chain path", async () => {
  const s = await startLocalSeller();
  try {
    const r = await scenario402BeforeSettle(s);
    assert.match(r.firstAttempt, /^HTTP 402/);
    assert.equal(r.refetch.ok, true, JSON.stringify(r.refetch));
    assert.ok(r.refetch.ok);
    assert.equal(Buffer.from(r.refetch.body).toString(), EXPECTED);
    assert.equal(r.refetch.receipt.delivery, "refetch");
    assert.equal(r.settleCalls, 1);
    assert.equal(s.stats.handlerCalls, 2, "the real handler regenerated the body");
    assert.ok(await s.store.get(r.refetch.receipt.payment_id), "the chain path created a record");
  } finally {
    await s.close();
  }
});

test("refetch for an unpaid payment header is refused (402)", async () => {
  const s = await startLocalSeller();
  try {
    const { header, nonce } = await buildPaymentHeader(privateKeyToAccount(generatePrivateKey()));
    const r = await refetch({ url: s.url, paymentHeaders: { "PAYMENT-SIGNATURE": header }, paymentId: nonce });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "refetch_refused");
    assert.equal(s.facilitator.settleCalls, 0);
    assert.equal(s.facilitator.verifyCalls, 0);
  } finally {
    await s.close();
  }
});
