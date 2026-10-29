import { verify as cryptoVerify, createPublicKey } from "node:crypto";
import { getAddressEncoder, getBase58Decoder, getBase64Encoder, getTransactionDecoder, type Address } from "@solana/kit";
import { recoverTypedDataAddress, type Hex } from "viem";
import type { PaymentRequirement, SettleResponse } from "./types.js";

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const BASE_MAINNET = "eip155:8453";
export const BASE_SEPOLIA = "eip155:84532";

/** v2 / v1 request header names carrying the payment payload. */
export const PAYMENT_HEADERS = ["PAYMENT-SIGNATURE", "X-PAYMENT"] as const;
/** v2 / v1 response header names carrying the settlement result. */
export const PAYMENT_RESPONSE_HEADERS = ["PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] as const;

const V1_NAMES: Record<string, string> = {
  base: BASE_MAINNET,
  "base-sepolia": BASE_SEPOLIA,
  solana: SOLANA_MAINNET,
  "solana-devnet": SOLANA_DEVNET,
};

/** Map x402 v1 network names to CAIP-2; CAIP-2 input is returned unchanged. */
export function normalizeNetwork(network: string): string {
  return V1_NAMES[network] ?? network;
}
export const isSolanaNetwork = (n: string): boolean => normalizeNetwork(n).startsWith("solana:");
export const isEvmNetwork = (n: string): boolean => normalizeNetwork(n).startsWith("eip155:");
export function evmChainId(network: string): number {
  const id = Number(normalizeNetwork(network).split(":")[1]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`not an EVM network: ${network}`);
  return id;
}

/** Decode a base64 (standard or url-safe) JSON header. Returns null when malformed. */
export function decodeBase64Json<T = unknown>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    const b64 = value.trim().replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Decoded x402 payment payload (v1 or v2); only `payload` is relied on. */
export interface PaymentPayload {
  x402Version?: number;
  network?: string;
  accepted?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  [k: string]: unknown;
}

export function decodePaymentHeader(value: string | null | undefined): PaymentPayload | null {
  const p = decodeBase64Json<PaymentPayload>(value);
  return p && typeof p === "object" && p.payload && typeof p.payload === "object" ? p : null;
}

export function decodeSettleResponse(value: string | null | undefined): SettleResponse | null {
  const s = decodeBase64Json<SettleResponse>(value);
  return s && typeof s === "object" ? s : null;
}

/** Read the first present header among `names` via a getter. */
export function pickHeader(get: (name: string) => string | null | undefined, names: readonly string[]): string | null {
  for (const n of names) {
    const v = get(n) ?? get(n.toLowerCase());
    if (v) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// EVM (EIP-3009 TransferWithAuthorization)
// ---------------------------------------------------------------------------

export interface EvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export function getEvmAuthorization(p: PaymentPayload): { authorization: EvmAuthorization; signature: string } | null {
  const inner = p.payload as { authorization?: EvmAuthorization; signature?: string } | undefined;
  const a = inner?.authorization;
  if (!a || typeof inner?.signature !== "string") return null;
  for (const k of ["from", "to", "value", "validAfter", "validBefore", "nonce"] as const) {
    if (typeof a[k] !== "string" && typeof a[k] !== "number") return null;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return null;
  return { authorization: a, signature: inner.signature };
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type SignerCheck = { ok: true; payer: string } | { ok: false; detail: string };

/**
 * Check that an EVM payment payload is bound to `paymentId` and signed by its `from`.
 * Returns the lowercase `from` as payer.
 */
export async function checkEvmSigner(
  p: PaymentPayload,
  paymentId: string,
  requirement: PaymentRequirement,
): Promise<SignerCheck> {
  const got = getEvmAuthorization(p);
  if (!got) return { ok: false, detail: "no EIP-3009 authorization in payment header" };
  const { authorization: a, signature } = got;
  if (a.nonce.toLowerCase() !== paymentId.toLowerCase()) return { ok: false, detail: "nonce does not match payment_id" };
  if (a.to.toLowerCase() !== requirement.payTo.toLowerCase()) return { ok: false, detail: "authorization.to != payTo" };
  const extra = requirement.extra ?? {};
  if (typeof extra.name !== "string" || typeof extra.version !== "string") {
    return { ok: false, detail: "requirement.extra.name/version missing" };
  }
  try {
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: extra.name,
        version: extra.version,
        chainId: evmChainId(requirement.network),
        verifyingContract: requirement.asset as Hex,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: a.from as Hex,
        to: a.to as Hex,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce as Hex,
      },
      signature: signature as Hex,
    });
    if (recovered.toLowerCase() !== a.from.toLowerCase()) return { ok: false, detail: "signature does not recover to from" };
  } catch (e) {
    return { ok: false, detail: `bad EIP-712 signature: ${(e as Error).message}` };
  }
  return { ok: true, payer: a.from.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Solana (partially signed wire transaction)
// ---------------------------------------------------------------------------

/**
 * Extract the signatures that are actually present in the buyer's base64 wire
 * transaction (the facilitator's fee-payer slot is still empty), verifying each
 * against the message bytes. Returns base58 signatures; empty when none are valid.
 */
export function solanaPayerSignatures(p: PaymentPayload): string[] {
  const txB64 = (p.payload as { transaction?: unknown } | undefined)?.transaction;
  if (typeof txB64 !== "string") return [];
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(txB64));
    const out: string[] = [];
    const addrEnc = getAddressEncoder();
    const b58 = getBase58Decoder();
    for (const [addr, sig] of Object.entries(tx.signatures)) {
      if (!sig || sig.every((b) => b === 0)) continue;
      const pub = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(addrEnc.encode(addr as Address)).toString("base64url") },
        format: "jwk",
      });
      if (!cryptoVerify(null, new Uint8Array(tx.messageBytes), pub, new Uint8Array(sig))) return [];
      out.push(b58.decode(sig));
    }
    return out;
  } catch {
    return [];
  }
}
