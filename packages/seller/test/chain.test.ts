import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTHORIZATION_USED_TOPIC, BaseRpcVerifier, ERC20_TRANSFER_TOPIC, SolanaRpcVerifier } from "../src/index.ts";
import { BASE_USDC, SOLANA_USDC, baseRequirement, solanaRequirement } from "./helpers.ts";

type Call = { method: string; params: unknown[] };
function rpc(handler: (c: Call) => unknown) {
  const calls: Call[] = [];
  const f = (async (_url: string | URL, init?: RequestInit) => {
    const c = JSON.parse(String(init?.body)) as Call;
    calls.push(c);
    return Response.json({ jsonrpc: "2.0", id: 1, result: handler(c) });
  }) as typeof fetch;
  return { f, calls };
}
const pad = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

test("SolanaRpcVerifier: settled when payer signature present and payTo received >= amount", async () => {
  const txId = "TxSig111";
  const payerSig = "PayerSig222";
  let delta = 10000;
  const { f, calls } = rpc(() => ({
    blockTime: 1_790_000_000,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 2, mint: SOLANA_USDC, owner: solanaRequirement.payTo, uiTokenAmount: { amount: "5" } }],
      postTokenBalances: [{ accountIndex: 2, mint: SOLANA_USDC, owner: solanaRequirement.payTo, uiTokenAmount: { amount: String(5 + delta) } }],
    },
    transaction: { signatures: [txId, payerSig], message: { accountKeys: [{ pubkey: "fee" }, { pubkey: "buyer" }, { pubkey: "ata" }] } },
  }));
  const v = new SolanaRpcVerifier({ rpcUrl: "http://rpc", fetch: f });
  const input = { network: solanaRequirement.network, payment_id: txId, payer: payerSig, payTo: solanaRequirement.payTo, asset: SOLANA_USDC, amount: "10000" };
  const ok = await v.findPayment(input);
  assert.equal(ok.settled, true);
  assert.equal(ok.at?.toISOString(), new Date(1_790_000_000_000).toISOString());
  assert.equal(calls[0].method, "getTransaction");
  assert.deepEqual(calls[0].params[1], { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  assert.equal((await v.findPayment({ ...input, payer: "SomeoneElse" })).settled, false);
  delta = 9999;
  assert.equal((await v.findPayment(input)).settled, false);
});

test("BaseRpcVerifier: AuthorizationUsed log + Transfer to payTo + block timestamp", async () => {
  const payer = "0x2222222222222222222222222222222222222222";
  const nonce = "0x" + "ab".repeat(32);
  const { f, calls } = rpc(({ method, params }) => {
    switch (method) {
      case "eth_blockNumber":
        return "0x" + (25_000).toString(16);
      case "eth_getLogs": {
        const q = params[0] as { topics: string[]; fromBlock: string };
        assert.deepEqual(q.topics, [AUTHORIZATION_USED_TOPIC, pad(payer), nonce]);
        return parseInt(q.fromBlock, 16) <= 12_000 ? [{ address: BASE_USDC, topics: q.topics, data: "0x", blockNumber: "0x2ee0", transactionHash: "0xtx" }] : [];
      }
      case "eth_getTransactionReceipt":
        return {
          status: "0x1",
          logs: [{ address: BASE_USDC.toLowerCase(), topics: [ERC20_TRANSFER_TOPIC, pad(payer), pad(baseRequirement.payTo)], data: "0x" + (10000).toString(16).padStart(64, "0") }],
        };
      case "eth_getBlockByNumber":
        return { timestamp: "0x" + (1_790_000_000).toString(16) };
    }
  });
  const v = new BaseRpcVerifier({ rpcUrl: "http://rpc", fetch: f, chunkBlocks: 10_000 });
  const r = await v.findPayment({ network: "eip155:8453", payment_id: nonce, payer, payTo: baseRequirement.payTo, asset: BASE_USDC, amount: "10000" });
  assert.equal(r.settled, true);
  assert.equal(r.at?.getTime(), 1_790_000_000_000);
  assert.equal(calls.filter((c) => c.method === "eth_getLogs").length, 2, "searches newest chunk first, then older");
  const tooMuch = await v.findPayment({ network: "eip155:8453", payment_id: nonce, payer, payTo: baseRequirement.payTo, asset: BASE_USDC, amount: "10001" });
  assert.equal(tooMuch.settled, false);
});
