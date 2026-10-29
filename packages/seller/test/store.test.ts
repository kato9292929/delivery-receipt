import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, MemoryStore, UpstashStore, type DeliveryRecord, type ReceiptStore } from "../src/index.ts";

const rec = (payment_id: string): DeliveryRecord => ({
  payment_id,
  network: "eip155:8453",
  resource: "https://seller.example/api/report",
  payer: "0xabc",
  body: Buffer.from("body").toString("base64"),
  content_type: "text/plain",
  body_sha256: "00".repeat(32),
  issued_at: "2026-10-20T00:00:00.000Z",
});

async function contract(store: ReceiptStore, advance: (s: number) => void) {
  assert.equal(await store.get("missing"), null);
  const id = "0x" + "ab".repeat(32);
  await store.put(rec(id), 60);
  assert.deepEqual(await store.get(id), rec(id));
  advance(61);
  assert.equal(await store.get(id), null, "expired records are gone");
}

test("MemoryStore", async () => {
  let t = 1_000_000;
  await contract(new MemoryStore(() => t), (s) => (t += s * 1000));
});

test("FileStore: one JSON file per payment_id, safe filenames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "receipt-store-"));
  try {
    let t = 1_000_000;
    await contract(new FileStore(dir, () => t), (s) => (t += s * 1000));
    const fs = new FileStore(dir);
    const solanaId = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    await fs.put(rec(solanaId), 60);
    await fs.put(rec("../../etc/passwd"), 60);
    const files = await readdir(dir);
    assert.ok(files.includes(`${solanaId}.json`));
    assert.ok(files.every((f) => !f.includes("/") && !f.startsWith(".")));
    assert.ok(files.some((f) => /^h_[0-9a-f]{64}\.json$/.test(f)));
    assert.equal((await fs.get("../../etc/passwd"))?.payment_id, "../../etc/passwd");
    assert.equal((await fs.get(solanaId))?.payment_id, solanaId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UpstashStore: REST /pipeline with SET EX and GET (mocked fetch)", async () => {
  const kv = new Map<string, string>();
  const calls: { url: string; auth: string | null; body: unknown[][]; signal: boolean }[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as (string | number)[][];
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body, signal: init?.signal instanceof AbortSignal });
    const out = body.map(([cmd, key, value]) => {
      if (cmd === "SET") {
        kv.set(String(key), String(value));
        return { result: "OK" };
      }
      if (cmd === "GET") return { result: kv.get(String(key)) ?? null };
      return { error: "unknown command" };
    });
    return Response.json(out);
  }) as typeof fetch;
  const store = new UpstashStore({ url: "https://x.upstash.io/", token: "tkn", fetch: fakeFetch });
  const id = "0x" + "cd".repeat(32);
  assert.equal(await store.get(id), null);
  await store.put(rec(id), 691200);
  assert.deepEqual(await store.get(id), rec(id));
  assert.equal(calls[0].url, "https://x.upstash.io/pipeline");
  assert.equal(calls[0].auth, "Bearer tkn");
  assert.ok(calls.every((c) => c.signal), "requests carry a timeout signal");
  assert.deepEqual(calls[1].body[0].slice(0, 2), ["SET", `x402-receipt:${id}`]);
  assert.deepEqual(calls[1].body[0].slice(3), ["EX", 691200]);

  const failing = new UpstashStore({ url: "https://x.upstash.io", token: "t", fetch: (async () => new Response("no", { status: 500 })) as typeof fetch });
  await assert.rejects(failing.put(rec(id), 60), /HTTP 500/);
  const erroring = new UpstashStore({ url: "https://x.upstash.io", token: "t", fetch: (async () => Response.json([{ error: "WRONGPASS" }])) as typeof fetch });
  await assert.rejects(erroring.get(id), /WRONGPASS/);
});

test("UpstashStore: 2s timeout aborts a hung request", async () => {
  const hung = (async (_u: string | URL, init?: RequestInit) =>
    new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as typeof fetch;
  const store = new UpstashStore({ url: "https://x.upstash.io", token: "t", fetch: hung, timeoutMs: 50 });
  const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout timers are unref'd
  try {
    await assert.rejects(store.get("x"));
  } finally {
    clearInterval(keepAlive);
  }
});
