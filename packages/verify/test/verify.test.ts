import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  base64urlDecode,
  base64urlEncode,
  canonicalJson,
  decodeReceipt,
  encodeReceipt,
  fetchWellKnown,
  receiptSigningBytes,
  refetch,
  sha256Hex,
  verifyReceipt,
  RECEIPT_HEADER,
  REFETCH_HEADER,
  type Receipt,
  type ReceiptPayload,
  type WellKnown,
} from "../src/index.ts";

function keypair(keyId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x as string;
  return { keyId, privateKey, entry: { key_id: keyId, alg: "Ed25519" as const, public_key: x } };
}

function makeReceipt(body: Uint8Array, kp: ReturnType<typeof keypair>, over: Partial<ReceiptPayload> = {}): Receipt {
  const payload: ReceiptPayload = {
    v: 1,
    payment_id: "0x" + "ab".repeat(32),
    network: "eip155:8453",
    resource: "https://seller.example/api/report",
    body_sha256: sha256Hex(body),
    content_length: body.byteLength,
    issued_at: "2026-10-01T00:00:00.000Z",
    delivery: "first",
    key_id: kp.keyId,
    ...over,
  };
  const sig = base64urlEncode(new Uint8Array(sign(null, receiptSigningBytes(payload), kp.privateKey)));
  return { ...payload, sig };
}

const wk = (...keys: WellKnown["keys"]): WellKnown => ({
  keys,
  refetch_window_s: 604800,
  refetch_header: REFETCH_HEADER,
});

test("canonicalJson sorts keys recursively without whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  assert.equal(canonicalJson({ "é": "日本" }), '{"é":"日本"}');
});

test("base64url has no padding and round-trips", () => {
  const bytes = new Uint8Array([251, 255, 0, 1]);
  const s = base64urlEncode(bytes);
  assert.ok(!s.includes("=") && !s.includes("+") && !s.includes("/"));
  assert.deepEqual(base64urlDecode(s), bytes);
  assert.throws(() => base64urlDecode("ab+c"));
});

test("encode/decode round-trip", () => {
  const kp = keypair("k1");
  const r = makeReceipt(new TextEncoder().encode("hi"), kp);
  assert.deepEqual(decodeReceipt(encodeReceipt(r)), r);
  assert.throws(() => decodeReceipt(base64urlEncode(new TextEncoder().encode('{"v":2}'))));
});

test("valid signature verifies", () => {
  const kp = keypair("k1");
  const body = new TextEncoder().encode('{"report":"ok"}');
  const res = verifyReceipt({ header: encodeReceipt(makeReceipt(body, kp)), body, wellKnown: wk(kp.entry) });
  assert.equal(res.ok, true);
});

test("missing header -> receipt_missing", () => {
  const kp = keypair("k1");
  const res = verifyReceipt({ header: null, body: new Uint8Array(), wellKnown: wk(kp.entry) });
  assert.deepEqual(res, { ok: false, reason: "receipt_missing" });
});

test("changing one body byte -> receipt_hash_mismatch", () => {
  const kp = keypair("k1");
  const body = new TextEncoder().encode('{"report":"ok"}');
  const header = encodeReceipt(makeReceipt(body, kp));
  const tampered = body.slice();
  tampered[3] ^= 0x01;
  const res = verifyReceipt({ header, body: tampered, wellKnown: wk(kp.entry) });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.reason, "receipt_hash_mismatch");
});

test("changing a receipt field -> receipt_bad_signature", () => {
  const kp = keypair("k1");
  const body = new TextEncoder().encode("payload");
  const r = makeReceipt(body, kp);
  for (const mutate of [
    (x: Receipt) => (x.resource = "https://seller.example/api/other"),
    (x: Receipt) => (x.delivery = "refetch"),
    (x: Receipt) => (x.issued_at = "2026-10-01T00:00:01.000Z"),
    (x: Receipt) => (x.payment_id = "0x" + "cd".repeat(32)),
  ]) {
    const copy = { ...r };
    mutate(copy);
    const res = verifyReceipt({ header: encodeReceipt(copy), body, wellKnown: wk(kp.entry) });
    assert.equal(!res.ok && res.reason, "receipt_bad_signature");
  }
  // Signature from another key under the same key_id.
  const other = keypair("k1");
  const res = verifyReceipt({ header: encodeReceipt(makeReceipt(body, other)), body, wellKnown: wk(kp.entry) });
  assert.equal(!res.ok && res.reason, "receipt_bad_signature");
});

test("unknown key_id -> receipt_key_unknown", () => {
  const kp = keypair("k1");
  const body = new TextEncoder().encode("x");
  const res = verifyReceipt({ header: encodeReceipt(makeReceipt(body, kp)), body, wellKnown: wk({ ...kp.entry, key_id: "k2" }) });
  assert.equal(!res.ok && res.reason, "receipt_key_unknown");
});

test("revoked key: issued after revoked_at -> key_unknown; before -> ok", () => {
  const kp = keypair("old");
  const body = new TextEncoder().encode("x");
  const header = encodeReceipt(makeReceipt(body, kp, { issued_at: "2026-10-01T12:00:00.000Z" }));
  const after = verifyReceipt({ header, body, wellKnown: wk({ ...kp.entry, revoked_at: "2026-10-01T11:00:00.000Z" }) });
  assert.equal(!after.ok && after.reason, "receipt_key_unknown");
  const equal = verifyReceipt({ header, body, wellKnown: wk({ ...kp.entry, revoked_at: "2026-10-01T12:00:00.000Z" }) });
  assert.equal(!equal.ok && equal.reason, "receipt_key_unknown");
  const before = verifyReceipt({ header, body, wellKnown: wk({ ...kp.entry, revoked_at: "2026-10-01T13:00:00.000Z" }) });
  assert.equal(before.ok, true);
});

test("expect.payment_id mismatch is rejected", () => {
  const kp = keypair("k1");
  const body = new TextEncoder().encode("x");
  const header = encodeReceipt(makeReceipt(body, kp));
  assert.equal(verifyReceipt({ header, body, wellKnown: wk(kp.entry), expect: { payment_id: "0x" + "AB".repeat(32) } }).ok, true);
  const res = verifyReceipt({ header, body, wellKnown: wk(kp.entry), expect: { payment_id: "0x" + "00".repeat(32) } });
  assert.equal(res.ok, false);
});

test("fetchWellKnown + refetch map statuses to reasons", async () => {
  const kp = keypair("k1");
  const body = new TextEncoder().encode("paid content");
  const paymentId = "0x" + "ab".repeat(32);
  let mode: 200 | 402 | 410 | 500 = 200;
  const seen: Record<string, string>[] = [];
  const fakeFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/x402-receipt.json") return Response.json(wk(kp.entry));
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    if (mode !== 200) return new Response("{}", { status: mode });
    return new Response(body, {
      status: 200,
      headers: { [RECEIPT_HEADER]: encodeReceipt(makeReceipt(body, kp, { delivery: "refetch" })) },
    });
  };
  const doc = await fetchWellKnown("https://seller.example", { fetch: fakeFetch });
  assert.equal(doc.keys[0].key_id, "k1");

  const args = { url: "https://seller.example/api/report", paymentHeaders: { "PAYMENT-SIGNATURE": "abc" }, paymentId, fetch: fakeFetch };
  const ok = await refetch(args);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && Buffer.from(ok.body).toString(), "paid content");
  assert.equal(seen[0]["payment-signature"], "abc");
  assert.equal(seen[0]["x-payment-refetch"], paymentId);

  mode = 410;
  assert.equal((await refetch(args) as { reason: string }).reason, "refetch_expired");
  mode = 402;
  assert.equal((await refetch(args) as { reason: string }).reason, "refetch_refused");
  mode = 500;
  assert.equal((await refetch(args) as { reason: string }).reason, "refetch_refused");
  mode = 200;
  const wrongId = await refetch({ ...args, paymentId: "0x" + "00".repeat(32) });
  assert.equal(wrongId.ok, false);
});
