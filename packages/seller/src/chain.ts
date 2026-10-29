import { isEvmNetwork, isSolanaNetwork, evmChainId, normalizeNetwork } from "./payment.js";
import type { ChainVerifier, FindPaymentInput, FindPaymentResult } from "./types.js";

/** keccak256("AuthorizationUsed(address,bytes32)") */
export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
export const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";

type FetchFn = typeof fetch;

async function jsonRpc<T>(fetchFn: FetchFn, url: string, method: string, params: unknown[], timeoutMs: number): Promise<T> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const out = (await res.json()) as { result?: T; error?: { message?: string } };
  if (out.error) throw new Error(`${method}: ${out.error.message ?? "rpc error"}`);
  return out.result as T;
}

export interface RpcVerifierOptions {
  rpcUrl?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

/**
 * Solana: getTransaction(payment_id, jsonParsed). Settled when the tx succeeded,
 * contains the payer's signature, and the payTo owner / token account received
 * at least `amount` of `asset` (computed from pre/post token balances).
 */
export class SolanaRpcVerifier implements ChainVerifier {
  private readonly rpcUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  constructor(opts: RpcVerifierOptions = {}) {
    this.rpcUrl = opts.rpcUrl || process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC_URL;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async findPayment(input: FindPaymentInput): Promise<FindPaymentResult> {
    const tx = await jsonRpc<{
      blockTime?: number | null;
      meta?: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
      transaction?: { signatures: string[]; message: { accountKeys: (string | { pubkey: string })[] } };
    } | null>(
      this.fetchFn,
      this.rpcUrl,
      "getTransaction",
      [input.payment_id, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
      this.timeoutMs,
    );
    if (!tx || !tx.meta || tx.meta.err !== null || !tx.transaction) return { settled: false };
    const sigs = tx.transaction.signatures;
    if (sigs[0] !== input.payment_id || !sigs.includes(input.payer)) return { settled: false };

    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    const pre = new Map<number, bigint>();
    for (const b of tx.meta.preTokenBalances ?? []) {
      if (b.mint === input.asset) pre.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
    }
    let received = 0n;
    for (const b of tx.meta.postTokenBalances ?? []) {
      if (b.mint !== input.asset) continue;
      if (b.owner !== input.payTo && keys[b.accountIndex] !== input.payTo) continue;
      received += BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) ?? 0n);
    }
    if (received < BigInt(input.amount)) return { settled: false };
    return { settled: true, at: tx.blockTime ? new Date(tx.blockTime * 1000) : undefined };
  }
}

export interface BaseRpcVerifierOptions extends RpcVerifierOptions {
  /** How far back to search for the AuthorizationUsed log (default ~8 days of 2s blocks). */
  lookbackBlocks?: number;
  /** Max block span per eth_getLogs call (default 10000). */
  chunkBlocks?: number;
}

const pad32 = (addr: string): string => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/**
 * EVM (Base): find USDC `AuthorizationUsed(authorizer, nonce)` via eth_getLogs
 * (newest blocks first, in chunks), confirm the same tx moved >= amount from the
 * payer to payTo, then read the block timestamp.
 */
export class BaseRpcVerifier implements ChainVerifier {
  private readonly rpcUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly lookback: number;
  private readonly chunk: number;
  constructor(opts: BaseRpcVerifierOptions = {}) {
    this.rpcUrl = opts.rpcUrl || process.env.BASE_RPC_URL || DEFAULT_BASE_RPC_URL;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.lookback = opts.lookbackBlocks ?? 350_000;
    this.chunk = opts.chunkBlocks ?? 10_000;
  }

  private rpc<T>(method: string, params: unknown[]): Promise<T> {
    return jsonRpc<T>(this.fetchFn, this.rpcUrl, method, params, this.timeoutMs);
  }

  async findPayment(input: FindPaymentInput): Promise<FindPaymentResult> {
    const latest = BigInt(await this.rpc<string>("eth_blockNumber", []));
    const floor = latest > BigInt(this.lookback) ? latest - BigInt(this.lookback) : 0n;
    type Log = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string };
    let found: Log | undefined;
    for (let to = latest; to >= floor && !found; to -= BigInt(this.chunk)) {
      const from = to - BigInt(this.chunk) + 1n > floor ? to - BigInt(this.chunk) + 1n : floor;
      const logs = await this.rpc<Log[]>("eth_getLogs", [
        {
          address: input.asset,
          topics: [AUTHORIZATION_USED_TOPIC, pad32(input.payer), input.payment_id.toLowerCase()],
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
        },
      ]);
      found = logs[0];
      if (from === floor) break;
    }
    if (!found) return { settled: false };

    const receipt = await this.rpc<{ status: string; logs: Log[] } | null>("eth_getTransactionReceipt", [
      found.transactionHash,
    ]);
    if (!receipt || receipt.status !== "0x1") return { settled: false };
    const paid = receipt.logs.some(
      (l) =>
        l.address.toLowerCase() === input.asset.toLowerCase() &&
        l.topics[0] === ERC20_TRANSFER_TOPIC &&
        l.topics[1]?.toLowerCase() === pad32(input.payer) &&
        l.topics[2]?.toLowerCase() === pad32(input.payTo) &&
        BigInt(l.data) >= BigInt(input.amount),
    );
    if (!paid) return { settled: false };
    const block = await this.rpc<{ timestamp: string } | null>("eth_getBlockByNumber", [found.blockNumber, false]);
    return { settled: true, at: block ? new Date(Number(BigInt(block.timestamp)) * 1000) : undefined };
  }
}

export interface DefaultChainVerifierOptions {
  solanaRpcUrl?: string;
  baseRpcUrl?: string;
  fetch?: FetchFn;
}

/** Dispatch by network: Solana mainnet/devnet -> SolanaRpcVerifier, eip155:8453 -> BaseRpcVerifier. */
export function createDefaultChainVerifier(opts: DefaultChainVerifierOptions = {}): ChainVerifier {
  const solana = new SolanaRpcVerifier({ rpcUrl: opts.solanaRpcUrl, fetch: opts.fetch });
  const base = new BaseRpcVerifier({ rpcUrl: opts.baseRpcUrl, fetch: opts.fetch });
  return {
    async findPayment(input) {
      const network = normalizeNetwork(input.network);
      if (isSolanaNetwork(network)) return solana.findPayment(input);
      if (isEvmNetwork(network) && evmChainId(network) === 8453) return base.findPayment(input);
      throw new Error(`no default chain verifier for ${network}`);
    },
  };
}
