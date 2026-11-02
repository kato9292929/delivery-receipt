import {
  DEFAULT_REFETCH_WINDOW_S,
  MIN_REFETCH_WINDOW_S,
  RECEIPT_HEADER,
  REFETCH_HEADER,
  encodeReceipt,
  sha256Hex,
  type Delivery,
  type Receipt,
  type ReceiptPayload,
  type WellKnown,
  type WellKnownKey,
} from "@x402jp/delivery-receipt-verify";
import { createDefaultChainVerifier } from "./chain.js";
import { deriveKeyId, loadSigningKey, signPayload, type SigningKey } from "./keys.js";
import {
  checkEvmSigner,
  decodePaymentHeader,
  getEvmAuthorization,
  isEvmNetwork,
  isSolanaNetwork,
  normalizeNetwork,
  solanaPayerSignatures,
} from "./payment.js";
import type {
  ChainVerifier,
  DeliveryRecord,
  FindPaymentResult,
  GeneratedBody,
  PaymentRequirement,
  ReceiptStore,
  SellerResponse,
  SettleResponse,
} from "./types.js";

export interface PreviousKey {
  key_id: string;
  /** base64url raw 32-byte Ed25519 public key */
  public_key: string;
  /** ISO 8601; receipts issued at/after this instant are rejected by verifiers. */
  revoked_at?: string;
}

export interface ReceiptSellerOptions {
  /** base64/base64url 32-byte Ed25519 seed or PKCS8 PEM. Default: process.env.RECEIPT_SIGNING_KEY. */
  signingKey?: string;
  /** Default: process.env.RECEIPT_KEY_ID, else first 16 hex of sha256(public key). */
  keyId?: string;
  /** Older keys kept in the well-known document (optionally revoked). */
  previousKeys?: PreviousKey[];
  store: ReceiptStore;
  /** Seconds; default 604800 (7 days); values below 86400 are rejected. */
  refetchWindowS?: number;
  /** Default: Solana/Base JSON-RPC verifiers (SOLANA_RPC_URL / BASE_RPC_URL). */
  chain?: ChainVerifier;
  solanaRpcUrl?: string;
  baseRpcUrl?: string;
  now?: () => Date;
  /** Called on non-fatal errors (e.g. store write failure). Default: console.error. */
  onError?: (err: unknown, context: string) => void;
}

export interface IssueReceiptInput {
  payment_id: string;
  network: string;
  resource: string;
  body: Uint8Array;
  delivery: Delivery;
  issuedAt?: Date;
}

export interface FirstDeliveryInput {
  requirement: PaymentRequirement;
  resource: string;
  /** Raw PAYMENT-SIGNATURE / X-PAYMENT header of the paid request. */
  paymentHeader: string | null;
  /** Decoded PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header. */
  settle: SettleResponse | null;
  body: Uint8Array;
  contentType: string;
}

export interface PreparedDelivery {
  record: DeliveryRecord;
  receipt: Receipt;
  /** Value for the X-Delivery-Receipt header. */
  header: string;
}

export interface RefetchRequest {
  /** Raw PAYMENT-SIGNATURE / X-PAYMENT header re-sent by the buyer. */
  paymentHeader: string | null;
  /** Value of X-Payment-Refetch. */
  paymentId: string;
  resource: string;
  requirement: PaymentRequirement;
  /** Calls the real handler (without payment) for the chain path. */
  generate: () => Promise<GeneratedBody>;
}

export interface ReceiptSeller {
  readonly keyId: string;
  /** base64url raw Ed25519 public key */
  readonly publicKey: string;
  readonly refetchWindowS: number;
  /** Store TTL: refetchWindowS + 1 day grace, so an expired refetch still finds its record and gets 410. */
  readonly retentionS: number;
  readonly store: ReceiptStore;
  readonly chain: ChainVerifier;
  /** The /.well-known/x402-receipt.json document. */
  wellKnown(): WellKnown;
  /** Sign a receipt for exactly these body bytes. */
  issueReceipt(input: IssueReceiptInput): { receipt: Receipt; header: string };
  /** Derive payment_id / payer and build record + receipt for a settled first delivery (no I/O). */
  prepareFirstDelivery(input: FirstDeliveryInput): PreparedDelivery | null;
  /** prepareFirstDelivery + store.put. Returns null (and reports via onError) when nothing could be recorded. */
  recordFirstDelivery(input: FirstDeliveryInput): Promise<PreparedDelivery | null>;
  /** Serve a refetch. Never touches the facilitator (/verify, /settle). */
  handleRefetch(input: RefetchRequest): Promise<SellerResponse>;
}

/** Extra retention beyond the refetch window. */
export const RETENTION_GRACE_S = 86_400;

export const EXPOSE_HEADERS = [RECEIPT_HEADER, "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"].join(", ");

function jsonResponse(status: number, obj: unknown): SellerResponse {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-expose-headers": EXPOSE_HEADERS },
    body: new Uint8Array(Buffer.from(JSON.stringify(obj))),
  };
}
const refused = (detail: string): SellerResponse => jsonResponse(402, { error: "refetch_refused", detail });
const expired = (): SellerResponse => jsonResponse(410, { error: "refetch_expired" });

export function createReceiptSeller(opts: ReceiptSellerOptions): ReceiptSeller {
  const keyInput = opts.signingKey ?? process.env.RECEIPT_SIGNING_KEY;
  if (!keyInput || keyInput.trim() === "") throw new Error("RECEIPT_SIGNING_KEY is not set");
  const key: SigningKey = loadSigningKey(keyInput);
  const keyId = opts.keyId || process.env.RECEIPT_KEY_ID || deriveKeyId(key.publicKeyRaw);
  const refetchWindowS = opts.refetchWindowS ?? DEFAULT_REFETCH_WINDOW_S;
  if (!Number.isFinite(refetchWindowS) || refetchWindowS < MIN_REFETCH_WINDOW_S) {
    throw new Error(`refetchWindowS must be >= ${MIN_REFETCH_WINDOW_S}`);
  }
  const retentionS = refetchWindowS + RETENTION_GRACE_S;
  if (!opts.store) throw new Error("store is required");
  const store = opts.store;
  const chain =
    opts.chain ?? createDefaultChainVerifier({ solanaRpcUrl: opts.solanaRpcUrl, baseRpcUrl: opts.baseRpcUrl });
  const now = opts.now ?? (() => new Date());
  const onError = opts.onError ?? ((err, ctx) => console.error(`[delivery-receipt] ${ctx}:`, err));
  const previousKeys = (opts.previousKeys ?? []).filter((k) => k.key_id !== keyId);

  const isExpired = (anchor: Date): boolean => now().getTime() - anchor.getTime() > refetchWindowS * 1000;

  function issueReceipt(input: IssueReceiptInput): { receipt: Receipt; header: string } {
    const payload: ReceiptPayload = {
      v: 1,
      payment_id: input.payment_id,
      network: normalizeNetwork(input.network),
      resource: input.resource,
      body_sha256: sha256Hex(input.body),
      content_length: input.body.byteLength,
      issued_at: (input.issuedAt ?? now()).toISOString(),
      delivery: input.delivery,
      key_id: keyId,
    };
    const receipt: Receipt = { ...payload, sig: signPayload(payload, key.privateKey) };
    return { receipt, header: encodeReceipt(receipt) };
  }

  function prepareFirstDelivery(input: FirstDeliveryInput): PreparedDelivery | null {
    if (!input.settle || input.settle.success !== true) return null;
    const network = normalizeNetwork(input.requirement.network);
    const p = decodePaymentHeader(input.paymentHeader);
    if (!p) return null;
    let paymentId: string;
    let payer: string;
    if (isSolanaNetwork(network)) {
      if (typeof input.settle.transaction !== "string" || !input.settle.transaction) return null;
      const sigs = solanaPayerSignatures(p);
      if (sigs.length === 0) return null;
      paymentId = input.settle.transaction;
      // The fee payer (facilitator) slot is empty in the buyer's tx, so the present signature is the payer's.
      payer = sigs[0];
    } else if (isEvmNetwork(network)) {
      const got = getEvmAuthorization(p);
      if (!got) return null;
      paymentId = got.authorization.nonce.toLowerCase();
      payer = got.authorization.from.toLowerCase();
    } else {
      return null;
    }
    const issuedAt = now();
    const { receipt, header } = issueReceipt({
      payment_id: paymentId,
      network,
      resource: input.resource,
      body: input.body,
      delivery: "first",
      issuedAt,
    });
    const record: DeliveryRecord = {
      payment_id: paymentId,
      network,
      resource: input.resource,
      payer,
      body: Buffer.from(input.body).toString("base64"),
      content_type: input.contentType,
      body_sha256: receipt.body_sha256,
      issued_at: receipt.issued_at,
    };
    return { record, receipt, header };
  }

  async function recordFirstDelivery(input: FirstDeliveryInput): Promise<PreparedDelivery | null> {
    let prepared: PreparedDelivery | null;
    try {
      prepared = prepareFirstDelivery(input);
    } catch (e) {
      onError(e, "prepare receipt");
      return null;
    }
    if (!prepared) return null;
    try {
      await store.put(prepared.record, retentionS);
    } catch (e) {
      // Without a record we cannot honor a refetch, so do not hand out a receipt.
      onError(e, "store.put");
      return null;
    }
    return prepared;
  }

  function refetchOk(body: Uint8Array, contentType: string, paymentId: string, network: string, resource: string): SellerResponse {
    const { header } = issueReceipt({ payment_id: paymentId, network, resource, body, delivery: "refetch" });
    return {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "private, no-store",
        [RECEIPT_HEADER.toLowerCase()]: header,
        "access-control-expose-headers": EXPOSE_HEADERS,
      },
      body,
    };
  }

  async function handleRefetch(input: RefetchRequest): Promise<SellerResponse> {
    const { requirement, resource } = input;
    const network = normalizeNetwork(requirement.network);
    const paymentId = input.paymentId.trim();
    if (!paymentId) return refused(`empty ${REFETCH_HEADER}`);
    const p = decodePaymentHeader(input.paymentHeader);
    if (!p) return refused("payment header missing or malformed");

    // 1. The payment header must belong to the signer of payment_id.
    let candidates: string[];
    let lookupId = paymentId;
    if (isEvmNetwork(network)) {
      const check = await checkEvmSigner(p, paymentId, requirement);
      if (!check.ok) return refused(check.detail);
      candidates = [check.payer];
      lookupId = paymentId.toLowerCase();
    } else if (isSolanaNetwork(network)) {
      candidates = solanaPayerSignatures(p);
      if (candidates.length === 0) return refused("no valid payer signature in transaction");
    } else {
      return refused(`unsupported network ${network}`);
    }

    // 2. Record path.
    const record = await store.get(lookupId);
    if (record) {
      if (record.network !== network || record.resource !== resource) return refused("record is for another resource");
      if (!candidates.includes(record.payer)) return refused("payer does not match record");
      if (isExpired(new Date(record.issued_at))) return expired();
      const body = new Uint8Array(Buffer.from(record.body, "base64"));
      return refetchOk(body, record.content_type, record.payment_id, network, resource);
    }

    // 3. Chain path: no record, but maybe the payment settled anyway.
    let found: FindPaymentResult | null = null;
    let payer = "";
    try {
      for (const c of candidates) {
        const r = await chain.findPayment({
          network,
          payment_id: lookupId,
          payer: c,
          payTo: requirement.payTo,
          asset: requirement.asset,
          amount: requirement.amount,
        });
        if (r.settled) {
          found = r;
          payer = c;
          break;
        }
      }
    } catch (e) {
      onError(e, "chain.findPayment");
      return jsonResponse(503, { error: "refetch_unavailable" });
    }
    if (!found) return refused("payment not found on chain");
    const anchor = found.at ?? now();
    if (isExpired(anchor)) return expired();

    const gen = await input.generate();
    if (gen.status !== 200) {
      return { status: gen.status, headers: { "content-type": gen.contentType }, body: gen.body };
    }
    const newRecord: DeliveryRecord = {
      payment_id: lookupId,
      network,
      resource,
      payer,
      body: Buffer.from(gen.body).toString("base64"),
      content_type: gen.contentType,
      body_sha256: sha256Hex(gen.body),
      // Anchor the window at settlement time so later refetches do not extend it.
      issued_at: anchor.toISOString(),
    };
    try {
      await store.put(newRecord, retentionS);
    } catch (e) {
      onError(e, "store.put (chain path)");
    }
    return refetchOk(gen.body, gen.contentType, lookupId, network, resource);
  }

  return {
    keyId,
    publicKey: key.publicKey,
    refetchWindowS,
    retentionS,
    store,
    chain,
    wellKnown(): WellKnown {
      const keys: WellKnownKey[] = [
        { key_id: keyId, alg: "Ed25519", public_key: key.publicKey },
        ...previousKeys.map((k) => ({
          key_id: k.key_id,
          alg: "Ed25519" as const,
          public_key: k.public_key,
          ...(k.revoked_at ? { revoked_at: k.revoked_at } : {}),
        })),
      ];
      return { keys, refetch_window_s: refetchWindowS, refetch_header: REFETCH_HEADER };
    },
    issueReceipt,
    prepareFirstDelivery,
    recordFirstDelivery,
    handleRefetch,
  };
}
