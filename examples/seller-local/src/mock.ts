/**
 * In-process mocks: a fake x402 facilitator (/verify, /settle) and a fake chain.
 * Nothing here touches a real network or a real key.
 */
import { randomBytes } from "node:crypto";
import { verifyTypedData, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { ChainVerifier, FindPaymentInput, FindPaymentResult, PaymentRequirement } from "@delivery-receipt/seller";

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const requirement: PaymentRequirement = {
  network: "eip155:8453",
  // Throwaway demo recipient.
  payTo: "0x000000000000000000000000000000000000dEaD",
  asset: BASE_USDC,
  amount: "10000", // 0.01 USDC
  extra: { name: "USD Coin", version: "2" },
};

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const domain = (req: PaymentRequirement) => ({
  name: String(req.extra?.name),
  version: String(req.extra?.version),
  chainId: 8453,
  verifyingContract: req.asset as Hex,
});

interface Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface ExactEvmPayload {
  x402Version: 2;
  accepted: Record<string, unknown>;
  payload: { signature: Hex; authorization: Authorization };
}

/** Buyer side: build a realistic x402 v2 exact-EVM PAYMENT-SIGNATURE header. */
export async function buildPaymentHeader(
  account: PrivateKeyAccount,
  req: PaymentRequirement = requirement,
): Promise<{ header: string; nonce: Hex; payload: ExactEvmPayload }> {
  const now = Math.floor(Date.now() / 1000);
  const authorization: Authorization = {
    from: account.address,
    to: req.payTo as Hex,
    value: req.amount,
    validAfter: String(now - 600),
    validBefore: String(now + 300),
    nonce: `0x${randomBytes(32).toString("hex")}`,
  };
  const signature = await account.signTypedData({
    domain: domain(req),
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  });
  const payload: ExactEvmPayload = {
    x402Version: 2,
    accepted: { scheme: "exact", ...req, maxTimeoutSeconds: 300 },
    payload: { signature, authorization },
  };
  return { header: Buffer.from(JSON.stringify(payload)).toString("base64"), nonce: authorization.nonce, payload };
}

/** Fake chain: records EIP-3009 authorizations that were "used". */
export class MockChain implements ChainVerifier {
  private readonly used = new Map<string, { from: string; to: string; value: bigint; at: Date; tx: string }>();

  markUsed(a: Authorization, at = new Date()): string {
    const tx = `0x${randomBytes(32).toString("hex")}`;
    this.used.set(a.nonce.toLowerCase(), { from: a.from.toLowerCase(), to: a.to.toLowerCase(), value: BigInt(a.value), at, tx });
    return tx;
  }
  isUsed(nonce: string): boolean {
    return this.used.has(nonce.toLowerCase());
  }

  async findPayment(input: FindPaymentInput): Promise<FindPaymentResult> {
    const u = this.used.get(input.payment_id.toLowerCase());
    if (!u) return { settled: false };
    if (u.from !== input.payer.toLowerCase() || u.to !== input.payTo.toLowerCase() || u.value < BigInt(input.amount)) {
      return { settled: false };
    }
    return { settled: true, at: u.at };
  }
}

/** Fake facilitator with call counters and an optional settle latency. */
export class MockFacilitator {
  verifyCalls = 0;
  settleCalls = 0;
  settleDelayMs = 0;
  private pending = new Set<Promise<unknown>>();

  constructor(private readonly chain: MockChain) {}

  async verify(p: ExactEvmPayload, req: PaymentRequirement): Promise<{ isValid: boolean; invalidReason?: string }> {
    this.verifyCalls++;
    const a = p.payload.authorization;
    const ok = await verifyTypedData({
      address: a.from,
      domain: domain(req),
      types: TYPES,
      primaryType: "TransferWithAuthorization",
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
      signature: p.payload.signature,
    });
    if (!ok) return { isValid: false, invalidReason: "invalid_signature" };
    if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { isValid: false, invalidReason: "wrong_recipient" };
    if (BigInt(a.value) < BigInt(req.amount)) return { isValid: false, invalidReason: "insufficient_amount" };
    if (this.chain.isUsed(a.nonce)) return { isValid: false, invalidReason: "nonce_used" };
    return { isValid: true };
  }

  settle(p: ExactEvmPayload, req: PaymentRequirement) {
    this.settleCalls++;
    const run = (async () => {
      if (this.settleDelayMs) await new Promise((r) => setTimeout(r, this.settleDelayMs));
      const transaction = this.chain.markUsed(p.payload.authorization);
      return { success: true, transaction, network: req.network, payer: p.payload.authorization.from };
    })();
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
    return run;
  }

  /** Wait until every in-flight settle has landed on the mock chain. */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
