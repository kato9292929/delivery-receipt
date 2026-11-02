/**
 * Runs both failure scenarios against the local seller and shows that the
 * buyer recovers the paid body with `refetch` (no second payment).
 *
 *   npm run example
 */
import { refetch, type RefetchResult } from "@x402jp/delivery-receipt-verify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildPaymentHeader } from "./mock.ts";
import { startLocalSeller, type LocalSeller } from "./server.ts";

export interface ScenarioResult {
  firstAttempt: string;
  refetch: RefetchResult;
  /** /settle calls made during this scenario (always 1: refetch never settles). */
  settleCalls: number;
}

/** (1) /settle succeeds, then the connection is cut before the body is sent. */
export async function scenarioCutAfterSettle(s: LocalSeller): Promise<ScenarioResult> {
  const before = s.facilitator.settleCalls;
  s.setMode("cut-after-settle");
  const buyer = privateKeyToAccount(generatePrivateKey()); // throwaway key
  const { header, nonce } = await buildPaymentHeader(buyer);
  let firstAttempt: string;
  try {
    const r = await fetch(s.url, { headers: { "PAYMENT-SIGNATURE": header } });
    firstAttempt = `HTTP ${r.status}`;
  } catch (e) {
    firstAttempt = `network error (${(e as Error).message})`;
  }
  s.setMode("normal");
  const result = await refetch({ url: s.url, paymentHeaders: { "PAYMENT-SIGNATURE": header }, paymentId: nonce });
  return { firstAttempt, refetch: result, settleCalls: s.facilitator.settleCalls - before };
}

/** (2) The seller answers 402 without waiting for /settle, but the payment settles on chain. */
export async function scenario402BeforeSettle(s: LocalSeller): Promise<ScenarioResult> {
  const before = s.facilitator.settleCalls;
  s.setMode("402-before-settle");
  s.facilitator.settleDelayMs = 50;
  const buyer = privateKeyToAccount(generatePrivateKey()); // throwaway key
  const { header, nonce } = await buildPaymentHeader(buyer);
  const r = await fetch(s.url, { headers: { "PAYMENT-SIGNATURE": header } });
  const firstAttempt = `HTTP ${r.status} ${await r.text()}`;
  await s.facilitator.idle(); // the transfer lands on chain
  s.setMode("normal");
  const result = await refetch({ url: s.url, paymentHeaders: { "PAYMENT-SIGNATURE": header }, paymentId: nonce });
  return { firstAttempt, refetch: result, settleCalls: s.facilitator.settleCalls - before };
}

function show(name: string, r: ScenarioResult): void {
  console.log(`\n=== ${name}`);
  console.log(`first attempt : ${r.firstAttempt}`);
  if (r.refetch.ok) {
    console.log(`refetch       : OK, delivery=${r.refetch.receipt.delivery}, payment_id=${r.refetch.receipt.payment_id}`);
    console.log(`body          : ${Buffer.from(r.refetch.body).toString("utf8")}`);
  } else {
    console.log(`refetch       : FAILED ${r.refetch.reason}`);
  }
  console.log(`settle calls  : ${r.settleCalls}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startLocalSeller();
  console.log(`local seller on ${s.url}`);
  try {
    show("(1) settled, then connection cut before body", await scenarioCutAfterSettle(s));
    show("(2) 402 returned without waiting for /settle", await scenario402BeforeSettle(s));
  } finally {
    await s.close();
  }
}
