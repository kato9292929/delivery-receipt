import { RECEIPT_HEADER, REFETCH_HEADER } from "@x402jp/delivery-receipt-verify";
import type { ReceiptSeller } from "./core.js";
import { EXPOSE_HEADERS } from "./core.js";
import { PAYMENT_HEADERS, PAYMENT_RESPONSE_HEADERS, decodeSettleResponse, pickHeader } from "./payment.js";
import type { PaymentRequirement, SellerResponse } from "./types.js";

export type WebHandler = (req: Request) => Promise<Response>;

export interface WithDeliveryReceiptsOptions {
  /** The x402-gated handler (verify -> handler -> settle). Never called on a refetch. */
  paywalled: WebHandler;
  /** The real, ungated handler. Called (without payment headers) for chain-path refetches. */
  handler: WebHandler;
  /** Absolute URL of the resource, as put into receipts. */
  resource: string;
  requirement: PaymentRequirement;
}

/** Merge `Access-Control-Expose-Headers` so browsers can read the receipt. */
function exposeHeaders(headers: Headers): void {
  const existing = headers.get("access-control-expose-headers");
  const set = new Set(
    (existing ? `${existing}, ${EXPOSE_HEADERS}` : EXPOSE_HEADERS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  headers.set("access-control-expose-headers", [...set].join(", "));
}

export function toWebResponse(r: SellerResponse): Response {
  return new Response(r.body.byteLength ? Buffer.from(r.body) : null, { status: r.status, headers: r.headers });
}

/** Copy of `req` without the payment / refetch headers, for calling the real handler. */
async function stripPayment(req: Request): Promise<Request> {
  const headers = new Headers(req.headers);
  for (const h of [...PAYMENT_HEADERS, REFETCH_HEADER]) headers.delete(h);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(req.url, { method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined });
}

/**
 * Wrap an x402 web-standard handler (e.g. a Next.js route handler) with
 * Delivery Receipts.
 */
export function withDeliveryReceipts(seller: ReceiptSeller, opts: WithDeliveryReceiptsOptions): WebHandler {
  return async (req: Request): Promise<Response> => {
    const paymentHeader = pickHeader((n) => req.headers.get(n), PAYMENT_HEADERS);
    const refetchId = req.headers.get(REFETCH_HEADER);

    if (refetchId !== null) {
      const out = await seller.handleRefetch({
        paymentHeader,
        paymentId: refetchId,
        resource: opts.resource,
        requirement: opts.requirement,
        generate: async () => {
          const r = await opts.handler(await stripPayment(req));
          return {
            status: r.status,
            body: new Uint8Array(await r.arrayBuffer()),
            contentType: r.headers.get("content-type") ?? "application/octet-stream",
          };
        },
      });
      return toWebResponse(out);
    }

    const res = await opts.paywalled(req);
    if (res.status !== 200) return res;
    const settle = decodeSettleResponse(pickHeader((n) => res.headers.get(n), PAYMENT_RESPONSE_HEADERS));
    if (!settle || settle.success !== true) return res;

    // Buffer the body, record it, and only then hand the response back to the server.
    const body = new Uint8Array(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    const prepared = await seller.recordFirstDelivery({
      requirement: opts.requirement,
      resource: opts.resource,
      paymentHeader,
      settle,
      body,
      contentType: headers.get("content-type") ?? "application/octet-stream",
    });
    if (prepared) headers.set(RECEIPT_HEADER, prepared.header);
    exposeHeaders(headers);
    headers.delete("content-length");
    return new Response(body.byteLength ? Buffer.from(body) : null, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}

/** Response for GET /.well-known/x402-receipt.json */
export function wellKnownResponse(seller: ReceiptSeller): Response {
  return new Response(JSON.stringify(seller.wellKnown()), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
