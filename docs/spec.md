# Delivery Receipt 仕様 (v1)

x402（HTTP 402 による USDC 支払い）で、**支払い済みのレスポンスが買い手に届かなかった**場合に、
買い手が **二重に支払うことなく** 同じコンテンツを再取得（refetch）できるようにする仕組み。

- 売り手は支払い済みの 200 応答ごとに **配送レシート（Delivery Receipt）** に署名して付与する。
- 売り手は /settle 成功直後、本文を送る前に **配送記録** を保存する。
- 買い手は元の支払いヘッダと `payment_id` を再送するだけで本文を再取得できる。売り手は再取得時に
  facilitator の /verify・/settle を **一切呼ばない**。
- 買い手は受け取った本文のハッシュと署名を検証する。

本書のキーワード「しなければならない (MUST)」「すべきである (SHOULD)」「してもよい (MAY)」は RFC 2119 の意味で用いる。

---

## 1. 用語

| 用語 | 意味 |
| --- | --- |
| payment header | 買い手が送る支払いヘッダ。x402 v2 は `PAYMENT-SIGNATURE`、v1 は `X-PAYMENT`。値は JSON の base64。 |
| settle response | 売り手が返す決済結果ヘッダ。v2 は `PAYMENT-RESPONSE`、v1 は `X-PAYMENT-RESPONSE`。値は `{success, transaction, network, payer}` の JSON の base64。 |
| payment_id | 支払いを一意に識別する ID（§2）。 |
| 配送記録 (delivery record) | 売り手が保存する、本文と支払者の記録（§6）。 |
| refetch window | 再取得を受け付ける期間（秒）。 |

## 2. payment_id

| ネットワーク | payment_id |
| --- | --- |
| Solana | 送金トランザクションの署名（= トランザクション ID）。settle response の `transaction` の値。base58。 |
| Base (EVM) | EIP-3009 `TransferWithAuthorization` の `authorization.nonce`。`0x` + 32 バイト（64 桁の16進）。比較は大文字小文字を区別しない。小文字に正規化して保存・署名する。 |

Solana の買い手は、自分の送ったトランザクションの手数料支払者（facilitator）の署名をまだ持たないため、
最初の応答の settle response（または自前の RPC 照会）から `transaction` を得る。

## 3. レシート

支払い済みの 200 応答には、ヘッダ `X-Delivery-Receipt` を付けなければならない (MUST)。
値は以下の JSON の **base64url（パディングなし）** である。

```json
{
  "v": 1,
  "payment_id": "0x5f…",
  "network": "eip155:8453",
  "resource": "https://seller.example/api/report",
  "body_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "content_length": 1234,
  "issued_at": "2026-10-29T06:30:00.000Z",
  "delivery": "first",
  "key_id": "2026-10",
  "sig": "…"
}
```

| フィールド | 型 | 内容 |
| --- | --- | --- |
| `v` | number | 常に `1`。 |
| `payment_id` | string | §2。 |
| `network` | string | CAIP-2。例: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`（Solana mainnet）、`eip155:8453`（Base）。x402 v1 の `base` / `solana` は CAIP-2 に正規化する。 |
| `resource` | string | 有料リソースの絶対 URL。 |
| `body_sha256` | string | **送信した本文バイト列そのもの** の SHA-256（小文字16進）。 |
| `content_length` | number | 本文のバイト数。 |
| `issued_at` | string | このレシートに署名した時刻。ISO 8601 UTC（`Z`）。 |
| `delivery` | `"first"` \| `"refetch"` | 初回配送か再取得か。 |
| `key_id` | string | 署名鍵の ID（§4）。 |
| `sig` | string | Ed25519 署名の base64url（パディングなし、64 バイト）。 |

### 3.1 署名対象（正規化 JSON）

`sig` は、**`sig` を除くすべてのフィールド** を次の規則で直列化した UTF-8 バイト列への Ed25519 署名である。

1. オブジェクトのキーをアルファベット順（UTF-16 コード単位順。ASCII キーでは辞書順と同じ）に並べる。入れ子のオブジェクトにも再帰的に適用する。
2. 空白を入れない（`JSON.stringify` と同じ区切り `,` と `:` のみ）。
3. 文字列・数値は JSON 標準の表記。配列の順序は保持する。
4. UTF-8 でエンコードする。

例: `{"body_sha256":"…","content_length":12,"delivery":"first","issued_at":"…","key_id":"…","network":"eip155:8453","payment_id":"0x…","resource":"https://…","v":1}`

ヘッダ値の JSON 自体も同じ正規化で直列化することを推奨する (SHOULD) が、検証者は受け取った JSON を
パースしてから再正規化するので、ヘッダ側の並び順には依存しない。

### 3.2 ブラウザ

ブラウザの買い手が読めるよう、売り手は `Access-Control-Expose-Headers` に `X-Delivery-Receipt`（および
`PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE`）を含めるべきである (SHOULD)。

## 4. 公開鍵: `/.well-known/x402-receipt.json`

```json
{
  "keys": [
    { "key_id": "2026-10", "alg": "Ed25519", "public_key": "<base64url 32 bytes>" },
    { "key_id": "2026-04", "alg": "Ed25519", "public_key": "…", "revoked_at": "2026-10-01T00:00:00Z" }
  ],
  "refetch_window_s": 604800,
  "refetch_header": "X-Payment-Refetch"
}
```

- `public_key`: 生の 32 バイト Ed25519 公開鍵の base64url（パディングなし）。
- `revoked_at`（任意）: 失効時刻（ISO 8601）。**失効した鍵も削除せず `revoked_at` 付きで掲載し続けなければならない** (MUST)。
- レシートがある鍵で有効なのは、その鍵に `revoked_at` が無いか、`issued_at < revoked_at` の場合に限る。
  `issued_at >= revoked_at` のレシートは `receipt_key_unknown` として扱う。
- `refetch_window_s`: 86400 以上でなければならない (MUST)。既定値 604800（7 日）。
- `refetch_header`: 常に `"X-Payment-Refetch"`。

鍵のローテーション: 新しい鍵を `keys` の先頭に追加し、古い鍵は（漏洩時は `revoked_at` を付けて）残す。
漏洩していない古い鍵は `revoked_at` なしで残してよい。

## 5. 再取得 (refetch)

買い手は、最初のリクエストで送った **元の支払いヘッダ**（`PAYMENT-SIGNATURE` または `X-PAYMENT`）を
そのまま再送し、さらに `X-Payment-Refetch: {payment_id}` を付けて同じ URL に GET する。

```http
GET /api/report HTTP/1.1
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6Mi…
X-Payment-Refetch: 0x5f…
```

売り手は `X-Payment-Refetch` があるリクエストを、**/verify も /settle も実行せず** に処理しなければならない (MUST)。
新しい支払いとして扱ってはならない（同じ認可を二度 settle しようとしてはならない）。

### 5.1 判定表

上から順に評価する。

| 条件 | 応答 |
| --- | --- |
| 支払いヘッダが無い・壊れている、または支払いヘッダの署名者が payment_id（または配送記録）と一致しない | **402** `{"error":"refetch_refused"}` |
| 配送記録があり、window 内 | **200**、保存済みの本文、`delivery:"refetch"` のレシート |
| 配送記録はあるが window 外 | **410** `{"error":"refetch_expired"}` |
| 配送記録は無いが、オンチェーンで決済済み（window 内） | ハンドラを呼んで本文を生成し **200**（`delivery:"refetch"`）、配送記録を作成する |
| 配送記録は無く、オンチェーンで決済済みだが window 外 | **410** `{"error":"refetch_expired"}` |
| 配送記録もオンチェーン決済も無い | **402** `{"error":"refetch_refused"}` |

補足:
- オンチェーン照会自体が失敗した場合（RPC 障害など）、売り手は 402 ではなく 503 を返してよい (MAY)。買い手側では `refetch_refused` として扱われる。
- オンチェーン経路で、ハンドラが 200 以外を返した場合はそれをそのまま返し、記録もレシートも作らない。
- 再取得時のレシートの `issued_at` は再署名した時刻である。window の起点は下記のとおり元の時刻であり、再取得によって延長されない。

### 5.2 署名者の一致

**Base (EVM, exact scheme)**

1. 支払いヘッダの `payload.authorization.nonce` が `payment_id` と一致しなければならない。
2. `payload.signature` が EIP-712 `TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)` の署名として `authorization.from` に復元されなければならない。
   ドメインは `name` / `version` = 支払い要件の `extra.name` / `extra.version`（Base USDC は `"USD Coin"` / `"2"`）、`chainId` = 8453、`verifyingContract` = 支払い要件の `asset`。
3. `authorization.to` は `payTo` と一致しなければならない。
4. 記録経路では `from` が記録の `payer` と一致しなければならない。オンチェーン経路では `from` を authorizer として照会する（§7）。

**Solana (exact scheme)**

1. 支払いヘッダの `payload.transaction`（base64 のワイヤ形式トランザクション）には、買い手自身の署名が含まれている（手数料支払者の枠は空）。
   売り手は存在する各署名をメッセージバイト列に対して Ed25519 検証し、正しい署名を **支払者署名** とする。1 つも無ければ 402。
2. 記録経路では、支払者署名が記録の `payer` と一致しなければならない。
3. オンチェーン経路では、署名 `payment_id` のオンチェーントランザクションの `signatures` に支払者署名が含まれ、かつ `payTo` へ送金されていなければならない（§7）。

### 5.3 window

- 起点は、配送記録の元の `issued_at`。記録が無い場合はオンチェーンのブロック時刻。
- `now - 起点 > refetch_window_s` なら window 外（410）。
- オンチェーン経路で作成する記録の `issued_at` にはブロック時刻を入れる（以後の再取得でも window が延びないように）。

## 6. 配送記録

**/settle が成功した直後、本文を送る前に** 次を保存しなければならない (MUST)。

```json
{
  "payment_id": "0x5f…",
  "network": "eip155:8453",
  "resource": "https://seller.example/api/report",
  "payer": "0xabc…",
  "body": "<本文の base64>",
  "content_type": "application/json",
  "body_sha256": "…",
  "issued_at": "2026-10-29T06:30:00.000Z"
}
```

- `payer`: Solana は支払者署名（base58）、EVM は `authorization.from`（小文字）。
- 保持期間は 24 時間以上 (MUST)。既定 7 日（= `refetch_window_s` の既定値 604800）。
  実装は window 経過後も 410 を返せるよう、`refetch_window_s` + 1 日 を TTL とする。
- 記録の保存に失敗した場合、売り手は本文を返してよいが、再取得を約束できないのでレシートを付けてはならない。
- 本文は支払い済みデータそのものなので、ストアのアクセス権限は本文と同等に管理すること。

## 7. オンチェーン照会

`findPayment({network, payment_id, payer, payTo, asset, amount}) → {settled, at?}`

**Solana**: `getTransaction(payment_id, {encoding:"jsonParsed", maxSupportedTransactionVersion:0, commitment:"confirmed"})`。
`meta.err` が null、`transaction.signatures[0] == payment_id`、`signatures` に支払者署名を含み、
`pre/postTokenBalances` で mint = `asset` かつ owner（またはトークンアカウント）= `payTo` の残高増加が `amount` 以上であること。`at` = `blockTime`。

**Base**: USDC コントラクト（`asset`）の `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)`
（topic0 `0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5`）を `eth_getLogs` で
`[topic0, authorizer, nonce]` 指定で新しいブロックから順に探す。見つかったトランザクションの receipt に、
同じ `asset` の `Transfer(from=authorizer, to=payTo, value>=amount)` があること。`at` = そのブロックの `timestamp`。

RPC URL は設定値、または環境変数 `SOLANA_RPC_URL` / `BASE_RPC_URL`（既定は公開 RPC）。

## 8. 買い手の検証

`verifyReceipt({header, body, wellKnown, expect?})` は次の順で検査し、失敗理由を返す。

| 順 | 検査 | 失敗理由 |
| --- | --- | --- |
| 1 | ヘッダがある | `receipt_missing` |
| 2 | デコードと形式検査 | `receipt_bad_signature` |
| 3 | `key_id` が well-known にある | `receipt_key_unknown` |
| 4 | Ed25519 署名が正しい | `receipt_bad_signature` |
| 5 | 鍵が未失効、または `issued_at < revoked_at` | `receipt_key_unknown` |
| 6 | `sha256(body) == body_sha256` かつ長さ一致 | `receipt_hash_mismatch` |
| 7 | `expect.payment_id` / `expect.resource` と一致 | `receipt_bad_signature`（`detail` に理由） |

`refetch({url, paymentHeaders, paymentId, wellKnown?, fetch?})` は再取得を行い、
410 → `refetch_expired`、それ以外の非 200（402 を含む）→ `refetch_refused`、200 ならレシートを検証して
上表の理由のいずれか、または `{ok:true, body, receipt}` を返す。

## 9. 署名鍵

- `RECEIPT_SIGNING_KEY`: 32 バイトの Ed25519 シードの base64 / base64url、または PKCS8 PEM。
  **未設定なら売り手アプリは起動してはならない**（実装は生成時に例外を投げる）。
- `RECEIPT_KEY_ID`: 任意。既定は公開鍵の SHA-256 の先頭 16 桁（16進）。
- 鍵はリポジトリに置かない。`scripts/keygen.ts` は標準出力にのみ出力する。

## 10. セキュリティ上の考慮

- **再取得は支払いの証明ではない**: 支払いヘッダは一度 settle された認可の再提示にすぎない。売り手は記録またはオンチェーンの事実と、ヘッダの署名者の一致を確認して初めて本文を返す。
- **第三者による再取得**: 支払いヘッダを盗んだ者は本文を再取得できる（同じヘッダで元のリクエストも送れるため、x402 自体と同じ脅威モデル）。支払いヘッダは秘密として扱うこと。
- **他人の payment_id の流用**: EVM では nonce と署名者の両方が一致しないと拒否され、Solana では支払者署名の Ed25519 検証と記録／オンチェーン照合で拒否される。
- **リソースの取り違え**: 記録の `resource` と `network` が一致しない再取得は 402。
- **キャッシュ**: 再取得応答は `Cache-Control: private, no-store`。
