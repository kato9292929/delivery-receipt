import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { ChainVerifier, FindPaymentInput, FindPaymentResult, PaymentRequirement } from "../src/index.ts";

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qJxNXq5ZF4ykDsxDeEC7aVv6Uu";
export const RESOURCE = "https://seller.example/api/report";

export const baseRequirement: PaymentRequirement = {
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
  asset: BASE_USDC,
  amount: "10000",
  extra: { name: "USD Coin", version: "2" },
};

export const solanaRequirement: PaymentRequirement = {
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  asset: SOLANA_USDC,
  amount: "10000",
};

/** Fresh throwaway Ed25519 seed (base64url). */
export function newSeed(): string {
  return randomBytes(32).toString("base64url");
}

export const b64json = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

export function newBuyer(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

/** Build an x402 v2 exact-EVM PAYMENT-SIGNATURE header. `signer` defaults to `from`. */
export async function evmPaymentHeader(
  from: PrivateKeyAccount,
  req: PaymentRequirement = baseRequirement,
  opts: { nonce?: `0x${string}`; signer?: PrivateKeyAccount } = {},
): Promise<{ header: string; nonce: `0x${string}` }> {
  const nonce = opts.nonce ?? (`0x${randomBytes(32).toString("hex")}` as const);
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: from.address,
    to: req.payTo,
    value: req.amount,
    validAfter: String(now - 600),
    validBefore: String(now + 300),
    nonce,
  };
  const signature = await (opts.signer ?? from).signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: req.asset as `0x${string}` },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: from.address,
      to: req.payTo as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce,
    },
  });
  const payload = {
    x402Version: 2,
    accepted: { scheme: "exact", ...req, maxTimeoutSeconds: 300 },
    payload: { signature, authorization },
  };
  return { header: b64json(payload), nonce };
}

const b58 = getBase58Decoder();

function edKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { privateKey, raw, address: b58.decode(raw) };
}

/**
 * Minimal partially-signed legacy Solana wire tx: fee payer slot empty (the
 * facilitator signs later), buyer signature present. Returns the x402 SVM
 * payment header and the buyer's base58 signature.
 */
export function solanaPaymentHeader(): { header: string; payerSig: string; buyer: string } {
  const feePayer = edKey();
  const buyer = edKey();
  const program = randomBytes(32);
  const message = Buffer.concat([
    Buffer.from([2, 0, 1]), // header: 2 signers, 0 readonly signed, 1 readonly unsigned
    Buffer.from([3]),
    feePayer.raw,
    buyer.raw,
    program,
    randomBytes(32), // recent blockhash
    Buffer.from([0]), // no instructions
  ]);
  const buyerSig = sign(null, message, buyer.privateKey);
  const wire = Buffer.concat([Buffer.from([2]), Buffer.alloc(64), buyerSig, message]);
  const header = b64json({
    x402Version: 2,
    accepted: { scheme: "exact", ...solanaRequirement },
    payload: { transaction: wire.toString("base64") },
  });
  return { header, payerSig: b58.decode(buyerSig), buyer: buyer.address };
}

/** A fake base58 tx signature (what the facilitator would return as `transaction`). */
export function fakeSolanaTxId(): string {
  return b58.decode(randomBytes(64));
}

/** In-memory chain: payment_id -> { payer, at }. */
export class MockChain implements ChainVerifier {
  readonly payments = new Map<string, { payer: string; at: Date }>();
  calls = 0;
  settle(paymentId: string, payer: string, at = new Date()): void {
    this.payments.set(paymentId.toLowerCase(), { payer: payer.toLowerCase(), at });
  }
  async findPayment(input: FindPaymentInput): Promise<FindPaymentResult> {
    this.calls++;
    const p = this.payments.get(input.payment_id.toLowerCase());
    if (!p || p.payer !== input.payer.toLowerCase()) return { settled: false };
    return { settled: true, at: p.at };
  }
}

/** A clock that tests can move forward. */
export function clock(start = new Date("2026-10-20T00:00:00.000Z")) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance: (s: number) => {
      t += s * 1000;
    },
  };
}
