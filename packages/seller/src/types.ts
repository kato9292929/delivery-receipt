/** The payment requirement a paywalled route advertises (x402 "exact" scheme). */
export interface PaymentRequirement {
  /** CAIP-2 ("eip155:8453", "solana:5eykt…") or x402 v1 name ("base", "solana"). */
  network: string;
  /** Recipient: EVM address, or Solana owner / token account. */
  payTo: string;
  /** Token: EVM USDC contract address, or Solana USDC mint. */
  asset: string;
  /** Amount in atomic units (decimal string). */
  amount: string;
  /** EVM: `{ name, version }` of the token's EIP-712 domain (USDC on Base: "USD Coin" / "2"). */
  extra?: Record<string, unknown>;
}

/** What is stored right after /settle succeeds, before the body is sent. */
export interface DeliveryRecord {
  payment_id: string;
  network: string;
  resource: string;
  /** Solana: the payer's own tx signature (base58). EVM: authorization.from (lowercase). */
  payer: string;
  /** base64 of the exact body bytes. */
  body: string;
  content_type: string;
  body_sha256: string;
  /** ISO 8601 UTC; the refetch window is measured from here. */
  issued_at: string;
}

export interface ReceiptStore {
  get(paymentId: string): Promise<DeliveryRecord | null>;
  put(record: DeliveryRecord, ttlS: number): Promise<void>;
}

export interface FindPaymentInput {
  network: string;
  payment_id: string;
  /** Solana: payer signature that must appear in the tx. EVM: authorizer address. */
  payer: string;
  payTo: string;
  asset: string;
  amount: string;
}

export interface FindPaymentResult {
  settled: boolean;
  /** Block time of the settlement. */
  at?: Date;
}

export interface ChainVerifier {
  findPayment(input: FindPaymentInput): Promise<FindPaymentResult>;
}

/** Decoded PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header. */
export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  [k: string]: unknown;
}

/** Framework-neutral HTTP response produced by the core. */
export interface SellerResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Body produced by the real (unpaid) handler during a chain-path refetch. */
export interface GeneratedBody {
  status: number;
  body: Uint8Array;
  contentType: string;
}
