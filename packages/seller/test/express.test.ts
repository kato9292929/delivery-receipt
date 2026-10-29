import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { fetchWellKnown, refetch, verifyReceipt, RECEIPT_HEADER, REFETCH_HEADER } from "@delivery-receipt/verify";
import {
  createReceiptSeller,
  MemoryStore,
  receiptRecorder,
  receiptRefetch,
  wellKnownRoute,
  type DeliveryRecord,
} from "../src/index.ts";
import { MockChain, b64json, baseRequirement, evmPaymentHeader, newBuyer, newSeed } from "./helpers.ts";

const BODY = JSON.stringify({ forecast: "sunny", n: 42 });

/** Store whose put is slow, recording when it completed. */
class SlowStore extends MemoryStore {
  putDoneAt = 0;
  override async put(r: DeliveryRecord, ttl: number) {
    await new Promise((res) => setTimeout(res, 80));
    await super.put(r, ttl);
    this.putDoneAt = Date.now();
  }
}

async function startApp(gateStyle: "settle-before-next" | "settle-after-handler") {
  const store = new SlowStore();
  const chain = new MockChain();
  const seller = createReceiptSeller({ signingKey: newSeed(), store, chain });
  const counters = { settle: 0, handler: 0 };
  const app = express();
  let origin = "";
  const resource = () => `${origin}/api/forecast`;

  const gate: express.RequestHandler = (req, res, next) => {
    const h = req.header("payment-signature");
    if (!h) return void res.status(402).json({ error: "payment required" });
    const payer = JSON.parse(Buffer.from(h, "base64").toString()).payload.authorization.from;
    const settleHeader = b64json({ success: true, transaction: "0x" + "77".repeat(32), network: "eip155:8453", payer });
    if (gateStyle === "settle-before-next") {
      counters.settle++;
      res.setHeader("PAYMENT-RESPONSE", settleHeader);
      return next();
    }
    // x402-express style: intercept end, settle after the handler, then flush.
    const origEnd = res.end.bind(res) as (...a: unknown[]) => express.Response;
    res.end = ((...args: unknown[]) => {
      setTimeout(() => {
        counters.settle++;
        res.setHeader("PAYMENT-RESPONSE", settleHeader);
        origEnd(...args);
      }, 10);
      return res;
    }) as express.Response["end"];
    next();
  };
  const handler: express.RequestHandler = (_req, res) => {
    counters.handler++;
    res.type("application/json").send(BODY);
  };

  app.get("/.well-known/x402-receipt.json", wellKnownRoute(seller));
  app.use(
    "/api/forecast",
    receiptRefetch(seller, {
      resource,
      requirement: baseRequirement,
      generate: async () => {
        counters.handler++;
        return { body: BODY, contentType: "application/json" };
      },
    }),
  );
  app.use("/api/forecast", gate);
  app.use("/api/forecast", receiptRecorder(seller, { resource, requirement: baseRequirement }));
  app.get("/api/forecast", handler);

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seller, store, chain, counters, origin, url: resource(), close: () => new Promise((r) => server.close(r)) };
}

for (const style of ["settle-before-next", "settle-after-handler"] as const) {
  test(`express (${style}): record written before body, receipt verifies, refetch skips the gate`, async () => {
    const s = await startApp(style);
    try {
      const buyer = newBuyer();
      const { header, nonce } = await evmPaymentHeader(buyer);
      const res = await fetch(s.url, { headers: { "PAYMENT-SIGNATURE": header } });
      const arrivedAt = Date.now();
      assert.equal(res.status, 200);
      const body = new Uint8Array(await res.arrayBuffer());
      assert.equal(Buffer.from(body).toString(), BODY);
      assert.ok(s.store.putDoneAt > 0 && s.store.putDoneAt <= arrivedAt, "record exists before the response leaves");
      assert.equal(Number(res.headers.get("content-length")), body.byteLength);
      const wk = await fetchWellKnown(s.origin);
      const v = verifyReceipt({ header: res.headers.get(RECEIPT_HEADER), body, wellKnown: wk, expect: { payment_id: nonce, resource: s.url } });
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.equal(s.counters.settle, 1);

      const again = await refetch({ url: s.url, paymentHeaders: { "PAYMENT-SIGNATURE": header }, paymentId: nonce });
      assert.equal(again.ok, true);
      assert.equal(again.ok && again.receipt.delivery, "refetch");
      assert.equal(s.counters.settle, 1, "refetch never reaches the gate");
      assert.equal(s.counters.handler, 1);

      // chain path via express
      const b2 = newBuyer();
      const p2 = await evmPaymentHeader(b2);
      s.chain.settle(p2.nonce, b2.address);
      const r2 = await refetch({ url: s.url, paymentHeaders: { "PAYMENT-SIGNATURE": p2.header }, paymentId: p2.nonce });
      assert.equal(r2.ok, true);
      assert.equal(s.counters.handler, 2);

      const r3 = await fetch(s.url, { headers: { "PAYMENT-SIGNATURE": header, [REFETCH_HEADER]: p2.nonce } });
      assert.equal(r3.status, 402);
      assert.equal(s.counters.settle, 1);
    } finally {
      await s.close();
    }
  });
}
