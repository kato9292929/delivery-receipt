import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeliveryRecord, ReceiptStore } from "./types.js";

interface Envelope {
  expires_at: number;
  record: DeliveryRecord;
}

/** In-process store. Suitable for tests and single-instance servers only. */
export class MemoryStore implements ReceiptStore {
  private readonly map = new Map<string, Envelope>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(paymentId: string): Promise<DeliveryRecord | null> {
    const env = this.map.get(paymentId);
    if (!env) return null;
    if (env.expires_at <= this.now()) {
      this.map.delete(paymentId);
      return null;
    }
    return structuredClone(env.record);
  }

  async put(record: DeliveryRecord, ttlS: number): Promise<void> {
    this.map.set(record.payment_id, { expires_at: this.now() + ttlS * 1000, record: structuredClone(record) });
  }
}

/**
 * One JSON file per payment_id under `dir`. The filename is the payment_id when
 * it is made of safe characters only, otherwise its sha256 hex. Writes are atomic
 * (temp file + rename).
 */
export class FileStore implements ReceiptStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Map a payment_id to a filename that cannot escape `dir`. */
  static fileName(paymentId: string): string {
    if (/^[A-Za-z0-9_-]{1,128}$/.test(paymentId)) return `${paymentId}.json`;
    return `h_${createHash("sha256").update(paymentId).digest("hex")}.json`;
  }

  async get(paymentId: string): Promise<DeliveryRecord | null> {
    const path = join(this.dir, FileStore.fileName(paymentId));
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const env = JSON.parse(raw) as Envelope;
    if (env.record?.payment_id !== paymentId) return null;
    if (env.expires_at <= this.now()) {
      await unlink(path).catch(() => {});
      return null;
    }
    return env.record;
  }

  async put(record: DeliveryRecord, ttlS: number): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, FileStore.fileName(record.payment_id));
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const env: Envelope = { expires_at: this.now() + ttlS * 1000, record };
    await writeFile(tmp, JSON.stringify(env), { mode: 0o600 });
    await rename(tmp, path);
  }
}

export interface UpstashStoreOptions {
  /** e.g. https://xxx.upstash.io (UPSTASH_REDIS_REST_URL) */
  url: string;
  /** UPSTASH_REDIS_REST_TOKEN */
  token: string;
  keyPrefix?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Upstash Redis via its REST `/pipeline` endpoint (SET … EX ttl / GET), 2s timeout. */
export class UpstashStore implements ReceiptStore {
  private readonly url: string;
  private readonly token: string;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: UpstashStoreOptions) {
    if (!opts.url || !opts.token) throw new Error("UpstashStore: url and token are required");
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.prefix = opts.keyPrefix ?? "x402-receipt:";
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private async pipeline(commands: (string | number)[][]): Promise<{ result?: unknown; error?: string }[]> {
    const res = await this.fetchFn(`${this.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`UpstashStore: HTTP ${res.status}`);
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    for (const r of out) if (r.error) throw new Error(`UpstashStore: ${r.error}`);
    return out;
  }

  async get(paymentId: string): Promise<DeliveryRecord | null> {
    const [r] = await this.pipeline([["GET", this.prefix + paymentId]]);
    if (r?.result === null || r?.result === undefined) return null;
    const rec = JSON.parse(String(r.result)) as DeliveryRecord;
    return rec.payment_id === paymentId ? rec : null;
  }

  async put(record: DeliveryRecord, ttlS: number): Promise<void> {
    await this.pipeline([["SET", this.prefix + record.payment_id, JSON.stringify(record), "EX", Math.ceil(ttlS)]]);
  }
}
