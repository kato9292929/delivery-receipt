/**
 * A local x402 seller (node:http + the web-standard adapter) with a mock
 * facilitator and mock chain. `mode` lets you reproduce delivery failures:
 *
 *  - "normal"            verify -> handler -> settle -> 200 + body
 *  - "cut-after-settle"  settle succeeds and the record is written, then the
 *                        connection is destroyed before any body byte is sent
 *  - "402-before-settle" settle is started but not awaited; the seller answers
 *                        402 although the payment lands on chain moments later
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createReceiptSeller,
  MemoryStore,
  WELL_KNOWN_PATH,
  wellKnownResponse,
  withDeliveryReceipts,
  type ReceiptSeller,
} from "@delivery-receipt/seller";
import { MockChain, MockFacilitator, requirement, type ExactEvmPayload } from "./mock.ts";

export type Mode = "normal" | "cut-after-settle" | "402-before-settle";

export interface LocalSeller {
  origin: string;
  url: string;
  seller: ReceiptSeller;
  store: MemoryStore;
  chain: MockChain;
  facilitator: MockFacilitator;
  stats: { handlerCalls: number };
  setMode(m: Mode): void;
  close(): Promise<void>;
}

const REPORT = {
  title: "Tokyo office-rent index (demo)",
  period: "2026-Q3",
  values: [{ ward: "Chiyoda", yen_per_tsubo: 38120 }, { ward: "Minato", yen_per_tsubo: 35990 }],
};

function json(status: number, obj: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
}

function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  return new Request(new URL(req.url ?? "/", origin), { method: req.method, headers });
}

async function writeResponse(res: ServerResponse, r: Response): Promise<void> {
  const body = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, { ...Object.fromEntries(r.headers.entries()), "content-length": String(body.byteLength) });
  res.end(body);
}

export async function startLocalSeller(opts: { mode?: Mode; port?: number } = {}): Promise<LocalSeller> {
  let mode: Mode = opts.mode ?? "normal";
  const chain = new MockChain();
  const facilitator = new MockFacilitator(chain);
  const store = new MemoryStore();
  // Ephemeral demo key, held in memory only (or RECEIPT_SIGNING_KEY if the operator set one).
  const seller = createReceiptSeller({
    signingKey: process.env.RECEIPT_SIGNING_KEY || randomBytes(32).toString("base64url"),
    store,
    chain,
  });
  const stats = { handlerCalls: 0 };

  const handler = async (_req: Request): Promise<Response> => {
    stats.handlerCalls++;
    return json(200, REPORT);
  };

  // Minimal x402 gate backed by the mock facilitator.
  const paywalled = async (req: Request): Promise<Response> => {
    const raw = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
    const required = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", ...requirement }] })).toString("base64");
    if (!raw) return json(402, { error: "payment_required" }, { "PAYMENT-REQUIRED": required });
    const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as ExactEvmPayload;
    const v = await facilitator.verify(payload, requirement);
    if (!v.isValid) return json(402, { error: v.invalidReason }, { "PAYMENT-REQUIRED": required });
    const res = await handler(req);
    if (mode === "402-before-settle") {
      // Bug being reproduced: do not wait for /settle.
      void facilitator.settle(payload, requirement);
      return json(402, { error: "settlement_timeout" }, { "PAYMENT-REQUIRED": required });
    }
    const settled = await facilitator.settle(payload, requirement);
    const headers = new Headers(res.headers);
    headers.set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settled)).toString("base64"));
    return new Response(await res.arrayBuffer(), { status: 200, headers });
  };

  let origin = "";
  let app: ((req: Request) => Promise<Response>) | null = null;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const request = toRequest(req, origin);
      const path = new URL(request.url).pathname;
      if (path === WELL_KNOWN_PATH) return writeResponse(res, wellKnownResponse(seller));
      if (path !== "/api/report") return writeResponse(res, json(404, { error: "not_found" }));
      const response = await app!(request);
      const isPaidFirstDelivery = response.status === 200 && !request.headers.has("x-payment-refetch");
      if (mode === "cut-after-settle" && isPaidFirstDelivery) {
        // Bug being reproduced: the connection dies after /settle (and after the record was written).
        req.socket.destroy();
        return;
      }
      return writeResponse(res, response);
    })().catch((e) => {
      console.error(e);
      res.destroy();
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = `${origin}/api/report`;
  app = withDeliveryReceipts(seller, { paywalled, handler, resource: url, requirement });

  return {
    origin,
    url,
    seller,
    store,
    chain,
    facilitator,
    stats,
    setMode: (m) => {
      mode = m;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
