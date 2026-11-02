import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { encodeReceipt, verifyReceipt, decodeReceipt } from "@x402jp/delivery-receipt-verify";
import { createReceiptSeller, deriveKeyId, loadSigningKey, MemoryStore } from "../src/index.ts";
import { MockChain, RESOURCE, newSeed } from "./helpers.ts";

const base = () => ({ store: new MemoryStore(), chain: new MockChain() });

test("missing RECEIPT_SIGNING_KEY -> creation throws", () => {
  const saved = process.env.RECEIPT_SIGNING_KEY;
  delete process.env.RECEIPT_SIGNING_KEY;
  try {
    assert.throws(() => createReceiptSeller(base()), /RECEIPT_SIGNING_KEY is not set/);
    assert.throws(() => createReceiptSeller({ ...base(), signingKey: "" }), /RECEIPT_SIGNING_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.RECEIPT_SIGNING_KEY = saved;
  }
});

test("signing key from env, keyId from env or derived", () => {
  const seed = newSeed();
  const savedK = process.env.RECEIPT_SIGNING_KEY;
  const savedId = process.env.RECEIPT_KEY_ID;
  try {
    process.env.RECEIPT_SIGNING_KEY = seed;
    delete process.env.RECEIPT_KEY_ID;
    const s = createReceiptSeller(base());
    assert.equal(s.keyId, deriveKeyId(loadSigningKey(seed).publicKeyRaw));
    assert.match(s.keyId, /^[0-9a-f]{16}$/);
    process.env.RECEIPT_KEY_ID = "2026-10";
    assert.equal(createReceiptSeller(base()).keyId, "2026-10");
  } finally {
    if (savedK === undefined) delete process.env.RECEIPT_SIGNING_KEY;
    else process.env.RECEIPT_SIGNING_KEY = savedK;
    if (savedId === undefined) delete process.env.RECEIPT_KEY_ID;
    else process.env.RECEIPT_KEY_ID = savedId;
  }
});

test("accepts base64 (std) seed and PKCS8 PEM; rejects bad keys", () => {
  const seed = Buffer.from(newSeed(), "base64url");
  const a = loadSigningKey(seed.toString("base64"));
  const b = loadSigningKey(seed.toString("base64url"));
  assert.equal(a.publicKey, b.publicKey);
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const s = createReceiptSeller({ ...base(), signingKey: pem });
  assert.equal(s.publicKey.length, 43);
  assert.throws(() => loadSigningKey(Buffer.alloc(16).toString("base64")), /32-byte/);
  assert.throws(() => loadSigningKey("not a key!!"), /base64/);
});

test("refetchWindowS below 86400 is rejected; default is 604800", () => {
  assert.throws(() => createReceiptSeller({ ...base(), signingKey: newSeed(), refetchWindowS: 3600 }), /86400/);
  assert.equal(createReceiptSeller({ ...base(), signingKey: newSeed() }).wellKnown().refetch_window_s, 604800);
  assert.equal(createReceiptSeller({ ...base(), signingKey: newSeed(), refetchWindowS: 86400 }).refetchWindowS, 86400);
});

test("issued receipt verifies; 1-byte body change -> hash mismatch; field change -> bad signature", () => {
  const s = createReceiptSeller({ ...base(), signingKey: newSeed() });
  const body = new TextEncoder().encode("hello paid world");
  const { header, receipt } = s.issueReceipt({ payment_id: "0x" + "12".repeat(32), network: "base", resource: RESOURCE, body, delivery: "first" });
  assert.equal(receipt.network, "eip155:8453", "v1 network names are normalized to CAIP-2");
  assert.equal(verifyReceipt({ header, body, wellKnown: s.wellKnown() }).ok, true);

  const changed = body.slice();
  changed[0] ^= 0x20;
  const h = verifyReceipt({ header, body: changed, wellKnown: s.wellKnown() });
  assert.equal(!h.ok && h.reason, "receipt_hash_mismatch");

  const r = decodeReceipt(header);
  const f = verifyReceipt({ header: encodeReceipt({ ...r, content_length: r.content_length }), body, wellKnown: s.wellKnown() });
  assert.equal(f.ok, true);
  const g = verifyReceipt({ header: encodeReceipt({ ...r, resource: RESOURCE + "?x=1" }), body, wellKnown: s.wellKnown() });
  assert.equal(!g.ok && g.reason, "receipt_bad_signature");
});

test("key rotation: revoked previous key -> receipts after revoked_at are key_unknown, before are ok", () => {
  let now = new Date("2026-10-10T00:00:00.000Z");
  const oldSeed = newSeed();
  const oldSeller = createReceiptSeller({ ...base(), signingKey: oldSeed, keyId: "old", now: () => now });
  const body = new TextEncoder().encode("x");
  const early = oldSeller.issueReceipt({ payment_id: "a", network: "eip155:8453", resource: RESOURCE, body, delivery: "first" });
  now = new Date("2026-10-12T00:00:00.000Z");
  const late = oldSeller.issueReceipt({ payment_id: "b", network: "eip155:8453", resource: RESOURCE, body, delivery: "first" });

  const newSeller = createReceiptSeller({
    ...base(),
    signingKey: newSeed(),
    keyId: "new",
    previousKeys: [{ key_id: "old", public_key: oldSeller.publicKey, revoked_at: "2026-10-11T00:00:00.000Z" }],
  });
  const wk = newSeller.wellKnown();
  assert.deepEqual(wk.keys.map((k) => [k.key_id, k.revoked_at]), [["new", undefined], ["old", "2026-10-11T00:00:00.000Z"]]);
  assert.equal(verifyReceipt({ header: early.header, body, wellKnown: wk }).ok, true);
  const v = verifyReceipt({ header: late.header, body, wellKnown: wk });
  assert.equal(!v.ok && v.reason, "receipt_key_unknown");
});
