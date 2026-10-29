# Delivery Receipt for x402

x402（HTTP 402 / USDC）で **支払ったのに本文が届かなかった** ときに、二重払いせずに再取得できるようにする仕組みです。
売り手は支払い済み 200 応答ごとに Ed25519 署名付きレシート（`X-Delivery-Receipt`）を付け、/settle 直後に配送記録を保存します。
買い手は元の支払いヘッダ + `X-Payment-Refetch: <payment_id>` で再取得し、レシートを検証します。

仕様: [docs/spec.md](docs/spec.md)

## パッケージ

| パス | 内容 |
| --- | --- |
| `packages/verify` (`@delivery-receipt/verify`) | 買い手側の検証・再取得。**実行時依存ゼロ**（`node:crypto` と `fetch` のみ）、`src/index.ts` 1 ファイル。 |
| `packages/seller` (`@delivery-receipt/seller`) | 売り手側。署名・記録・再取得処理、Web 標準アダプタ（Next.js）、Express アダプタ、ストア、チェーン照会。 |
| `examples/seller-local` | モック facilitator / モックチェーンで 2 つの障害を再現するローカル売り手。 |

## 使い方（Next.js route handler）

```ts
import { createReceiptSeller, UpstashStore, withDeliveryReceipts, wellKnownResponse } from "@delivery-receipt/seller";

const seller = createReceiptSeller({
  store: new UpstashStore({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! }),
}); // RECEIPT_SIGNING_KEY が無ければここで例外

export const GET = withDeliveryReceipts(seller, {
  paywalled,          // 既存の x402 ゲート付きハンドラ
  handler,            // ゲート無しの本体（オンチェーン経路の再取得で使用）
  resource: "https://example.com/api/report",
  requirement: { network: "eip155:8453", payTo, asset: USDC_BASE, amount: "10000", extra: { name: "USD Coin", version: "2" } },
});
// app/.well-known/x402-receipt.json/route.ts:  export const GET = () => wellKnownResponse(seller);
```

買い手:

```ts
import { refetch } from "@delivery-receipt/verify";
const r = await refetch({ url, paymentHeaders: { "PAYMENT-SIGNATURE": header }, paymentId });
if (r.ok) use(r.body); else console.log(r.reason); // refetch_expired / refetch_refused / receipt_*
```

## 開発

```sh
npm install
npm test           # 全テスト
npm run typecheck
npm run example    # 2 つの障害シナリオを実行
npm run keygen     # 新しい署名鍵を標準出力に表示（ファイルには書きません）
```

環境変数は `.env.example` を参照。署名鍵はリポジトリに置かず、Vercel などの環境変数に設定してください。
