/**
 * Express (or any connect-style) adapter. Typed structurally against node:http so
 * the package does not depend on express itself.
 *
 *   app.get("/.well-known/x402-receipt.json", wellKnownRoute(seller));
 *   app.use("/api/report", receiptRefetch(seller, opts)); // BEFORE the x402 gate
 *   app.use("/api/report", x402Gate);
 *   app.use("/api/report", receiptRecorder(seller, opts)); // AFTER the x402 gate
 *   app.get("/api/report", handler);
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { RECEIPT_HEADER, REFETCH_HEADER } from "@delivery-receipt/verify";
import { EXPOSE_HEADERS, type ReceiptSeller } from "./core.js";
import { PAYMENT_HEADERS, PAYMENT_RESPONSE_HEADERS, decodeSettleResponse, pickHeader } from "./payment.js";
import type { PaymentRequirement } from "./types.js";

export type Req = IncomingMessage & { originalUrl?: string };
export type Res = ServerResponse;
export type Next = (err?: unknown) => void;
export type Middleware = (req: Req, res: Res, next: Next) => void;

type ResourceOpt = string | ((req: Req) => string);

export interface ReceiptRefetchOptions {
  resource: ResourceOpt;
  requirement: PaymentRequirement;
  /** Produce the body with the real handler, without payment (chain path only). */
  generate: (req: Req) => Promise<{ status?: number; body: Uint8Array | string; contentType?: string }>;
}

export interface ReceiptRecorderOptions {
  resource: ResourceOpt;
  requirement: PaymentRequirement;
}

const reqHeader = (req: Req, name: string): string | null => {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
};
const resolveResource = (r: ResourceOpt, req: Req): string => (typeof r === "function" ? r(req) : r);

function addExpose(res: Res): void {
  const cur = res.getHeader("access-control-expose-headers");
  const merged = new Set(
    `${cur ? String(cur) + ", " : ""}${EXPOSE_HEADERS}`
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  res.setHeader("access-control-expose-headers", [...merged].join(", "));
}

/** Handles `X-Payment-Refetch` requests; otherwise calls next(). Mount before the x402 gate. */
export function receiptRefetch(seller: ReceiptSeller, opts: ReceiptRefetchOptions): Middleware {
  return (req, res, next) => {
    const paymentId = reqHeader(req, REFETCH_HEADER);
    if (paymentId === null) return next();
    seller
      .handleRefetch({
        paymentHeader: pickHeader((n) => reqHeader(req, n), PAYMENT_HEADERS),
        paymentId,
        resource: resolveResource(opts.resource, req),
        requirement: opts.requirement,
        generate: async () => {
          const g = await opts.generate(req);
          return {
            status: g.status ?? 200,
            body: typeof g.body === "string" ? new Uint8Array(Buffer.from(g.body)) : g.body,
            contentType: g.contentType ?? "application/octet-stream",
          };
        },
      })
      .then((out) => {
        res.statusCode = out.status;
        for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
        res.setHeader("content-length", out.body.byteLength);
        res.end(Buffer.from(out.body));
      })
      .catch(next);
  };
}

function chunkToBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), encoding ?? "utf8");
}

/**
 * Defer every OutgoingMessage#_send call (which carries the head and body bytes
 * to the socket) until `until` settles, then replay them in order. Socket corking
 * is not enough because ServerResponse#end fully uncorks the socket.
 */
function holdOutputUntil(res: Res, until: Promise<unknown>): void {
  const target = res as unknown as { _send?: (...a: unknown[]) => unknown };
  const realSend = target._send;
  if (typeof realSend !== "function") return;
  const queued: unknown[][] = [];
  target._send = (...a: unknown[]) => {
    queued.push(a);
    return true;
  };
  void until.finally(() => {
    delete target._send; // fall back to the prototype method
    if (target._send !== realSend) target._send = realSend;
    for (const a of queued) realSend.apply(res, a);
  });
}

/**
 * Records + signs paid 200 responses. Mount after the x402 gate.
 *
 * It buffers the handler's body (res.write/res.end). Two gate styles are supported:
 *  - the gate settled before calling next() (PAYMENT-RESPONSE already set): the
 *    record is written, then the body is released;
 *  - the gate settles after the handler (it intercepts res.end itself, like
 *    x402-express): the receipt is attached when the gate writes the head, and the
 *    response's output (head + body) is held until the record write completes, so
 *    no byte leaves before the record exists. This path relies on Node's
 *    OutgoingMessage#_send, which has been stable for many major versions; prefer
 *    a gate that settles before calling next() (or the web adapter) when possible.
 */
export function receiptRecorder(seller: ReceiptSeller, opts: ReceiptRecorderOptions): Middleware {
  return (req, res, next) => {
    const paymentHeader = pickHeader((n) => reqHeader(req, n), PAYMENT_HEADERS);
    if (!paymentHeader || req.method === "HEAD") return next();
    const resource = resolveResource(opts.resource, req);
    const chunks: Buffer[] = [];
    const innerWrite = res.write;
    const innerEnd = res.end;
    let ended = false;

    const firstInput = (settle: ReturnType<typeof decodeSettleResponse>, body: Buffer) => ({
      requirement: opts.requirement,
      resource,
      paymentHeader,
      settle,
      body: new Uint8Array(body),
      contentType: String(res.getHeader("content-type") ?? "application/octet-stream"),
    });

    const installLateHook = (body: Buffer): void => {
      const origWriteHead = res.writeHead;
      res.writeHead = function (this: Res, statusCode: number, ...rest: unknown[]) {
        res.writeHead = origWriteHead;
        const headersArg = rest.find((a) => a && typeof a === "object") as OutgoingHttpHeaders | undefined;
        const fromArg = (n: string) => {
          if (!headersArg) return undefined;
          const hit = Object.entries(headersArg).find(([k]) => k.toLowerCase() === n.toLowerCase());
          return hit ? String(hit[1]) : undefined;
        };
        const raw = pickHeader((n) => (res.getHeader(n) as string | undefined) ?? fromArg(n), PAYMENT_RESPONSE_HEADERS);
        const settle = decodeSettleResponse(raw);
        if (statusCode === 200 && settle?.success === true) {
          try {
            const prepared = seller.prepareFirstDelivery(firstInput(settle, body));
            if (prepared) {
              res.setHeader(RECEIPT_HEADER, prepared.header);
              addExpose(res);
              holdOutputUntil(
                res,
                seller.store
                  .put(prepared.record, seller.retentionS)
                  .catch((e) => console.error("[delivery-receipt] store.put:", e)),
              );
            }
          } catch (e) {
            console.error("[delivery-receipt] receipt:", e);
          }
        }
        return (origWriteHead as (...a: unknown[]) => Res).call(this, statusCode, ...rest);
      } as Res["writeHead"];
    };

    const finalize = async (body: Buffer): Promise<void> => {
      if (res.statusCode !== 200) return;
      const raw = pickHeader((n) => res.getHeader(n) as string | undefined, PAYMENT_RESPONSE_HEADERS);
      if (raw === null) return installLateHook(body);
      const settle = decodeSettleResponse(raw);
      if (settle?.success !== true) return;
      const prepared = await seller.recordFirstDelivery(firstInput(settle, body));
      if (prepared) {
        res.setHeader(RECEIPT_HEADER, prepared.header);
        addExpose(res);
      }
    };

    res.write = function (chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(chunkToBuffer(chunk, typeof encOrCb === "string" ? (encOrCb as BufferEncoding) : undefined));
      }
      const done = typeof encOrCb === "function" ? encOrCb : cb;
      if (typeof done === "function") process.nextTick(done as () => void);
      return true;
    } as Res["write"];

    res.end = function (chunk?: unknown, encOrCb?: unknown, cb?: unknown): Res {
      if (ended) return res;
      ended = true;
      let done: unknown = cb;
      if (typeof chunk === "function") {
        done = chunk;
        chunk = undefined;
      } else if (typeof encOrCb === "function") {
        done = encOrCb;
      }
      if (chunk !== undefined && chunk !== null) {
        chunks.push(chunkToBuffer(chunk, typeof encOrCb === "string" ? (encOrCb as BufferEncoding) : undefined));
      }
      const body = Buffer.concat(chunks);
      res.write = innerWrite;
      res.end = innerEnd;
      const release = () => {
        if (res.getHeader("content-length") !== undefined) res.setHeader("content-length", body.byteLength);
        (innerEnd as (...a: unknown[]) => Res).call(res, body, ...(typeof done === "function" ? [done] : []));
      };
      finalize(body).then(release, (e) => {
        console.error("[delivery-receipt] recorder:", e);
        release();
      });
      return res;
    } as Res["end"];

    next();
  };
}

/** GET /.well-known/x402-receipt.json */
export function wellKnownRoute(seller: ReceiptSeller): (req: Req, res: Res) => void {
  return (_req, res) => {
    const body = JSON.stringify(seller.wellKnown());
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "public, max-age=300");
    res.setHeader("access-control-allow-origin", "*");
    res.end(body);
  };
}
