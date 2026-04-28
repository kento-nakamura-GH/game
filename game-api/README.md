# きょむうさ猛プッシュ — Ranking API

Cloudflare Workers + KV で動くランキング API。`LP/game/` のフロントから叩く想定。

## セットアップ

```bash
# このフォルダで
npm install

# Cloudflare ログイン（初回のみ）
npx wrangler login

# KV 名前空間を作成
npm run kv:create          # production 用 ID が出る
npm run kv:create-preview  # preview 用 ID が出る
```

出力された ID を `wrangler.toml` の `[[kv_namespaces]]` ブロックに貼って、コメントアウトを外す。

## ローカル開発

```bash
npm run dev   # wrangler dev。http://localhost:8787 に立つ
```

ヘルスチェック：

```bash
curl http://localhost:8787/api/health
```

## デプロイ

```bash
npm run deploy
```

`workers.dev` のデフォルトサブドメインに出る（例: `kyomuusa-ranking.<account>.workers.dev`）。  
本番は `caslive.jp/api/*` 等にルートしたければ `wrangler.toml` の `routes` を設定。

## エンドポイント

### `POST /api/score` — スコア提出

リクエスト：

```json
{
  "version": "v97",
  "trackId": 0,
  "stats": {
    "taps": 29,
    "clearTime": 14.2,
    "maxCombo": 28,
    "perfectCount": 22,
    "greatCount": 5,
    "goodCount": 2,
    "missCount": 0,
    "hitScore": 1840,
    "decayTotal": 3.2
  }
}
```

レスポンス：

```json
{
  "submissionId": "xxxx",
  "score": 34500,
  "position": 3,
  "isTop5": true,
  "needsName": true,
  "top": [
    { "score": 42000, "name": "タロウ", "at": 1714000000000, "you": false },
    { "score": 38000, "name": "ハナ", "at": 1714000001000, "you": false },
    { "score": 34500, "name": null, "at": 1714000002000, "you": true },
    { "score": 32000, "name": "ジロウ", "at": 1714000003000, "you": false },
    { "score": 30000, "name": "ミサ", "at": 1714000004000, "you": false }
  ],
  "you": { "score": 34500, "position": 3, "name": null }
}
```

- `needsName: true` が返ったら、フロントは名前入力 UI を出す。
- `needsName: false` でも `you.position` で「YOU: N位」表示はできる。

### `PUT /api/score/:submissionId/name` — ランクイン時の名前登録

リクエスト：

```json
{ "name": "キョム" }
```

- 1〜5 コードポイント（絵文字や日本語は 1 文字としてカウント）。
- 空白、制御文字、ゼロ幅文字は自動除去。空になったら `invalid_name`。
- 既に登録済み or エントリが他プレイに押し出された場合は `409`/`410`。

レスポンス：更新後の top5 と `you`。

### `GET /api/top` — 現在の top5

```json
{ "top": [ ... ] }
```

### `GET /api/health` — 生存確認

## 改ざん対策

- クライアントは生のプレイ統計（taps, clearTime, maxCombo, perfect/great/good/miss 数, hitScore, decayTotal）を送る。
- サーバーは `computeFinalScore()` と同じ式で **timeBonus / accuracyBonus / comboBonus / noMissBonus / efficiencyFactor** を再計算。
- `hitScore` と `decayTotal` はクライアント報告だが `SANITY` で上限クランプ。
- 整合性チェック: counts の合計が taps と一致、maxCombo ≤ ヒット数、範囲外の値は即 `400`。
- 物理整合性チェック（M-3 / V-01）:
  - `taps >= clearTime * 0.5`（最低タップ密度）
  - `mashTaps <= mashTimeSec * 30`（人間の最大タップ速度 30Hz 想定）
  - `mashTimeSec <= mashWindowSec`
  - `feverPerfectCount + feverGreatCount + feverGoodCount <= taps`
- DevTools で `state.perfectCount` を直接盛る程度は落とせるが、大規模なチートは弾ききれない。LP のフックなので許容。

## セキュリティ層（2026-04-28 監査対応）

POST `/api/score` と PUT/POST `/api/score/:id/name` には以下の入口検証が順番に走る：

1. **Origin allowlist enforce**（M-1 / V-05）— `ALLOWED_ORIGINS` に含まれない Origin（curl 直叩き含む）は `403 origin_not_allowed`。
2. **Content-Type strict**（M-2 / V-16）— `application/json` で始まらないリクエストは `415 unsupported_content_type`。`text/plain` 経由の preflight bypass を遮断。
3. **IP レート制限**（M-4 / V-02）— `cf-connecting-ip` を 60 秒バケットでカウント、`RATE_LIMIT_PER_MIN`（既定 60）を超えたら `429 rate_limited` + `Retry-After: 60`。
4. **Body parse / Validation**（M-3 / M-6）— JSON parse 失敗は `400 bad_json`、validateSubmission 失敗は `400 invalid_submission` + `reason` フィールドで具体的な field 名を返す。
5. **sanitizeName 強化**（M-5）— 名前入力は制御文字・ゼロ幅・bidi override・全角/NBSP空白・HTML 特殊文字（`<>&"'\``）を除去。全文空白系は `null` 扱いで `400 invalid_name`。

GET（`/api/health`, `/api/top`）は state-change がないため Origin / Content-Type / レート制限の対象外。CORS レスポンスヘッダだけ allowlist で制御。

OPTIONS preflight も従来どおり `204` 即応答。

### Turnstile（後付け可能）

`wrangler secret put TURNSTILE_SECRET` で Turnstile を有効化できる。

- 有効時: POST body の `turnstileToken` を Cloudflare の `siteverify` に投げ、`success: true` ならレート制限をスキップ。
- 無効時（既定）: `turnstileToken` フィールドは無視。レート制限のみで防御。

クライアント側は body にオプショナルで `turnstileToken: <string>` を含めるだけ。フィールド未定の場合は無視される（後方互換）。

### 監査ログ

`console.warn('[SEC] ts=... reason=... ip=... origin=... path=...')` 形式で `wrangler tail` から監視可能。
記録対象は: `origin_denied` / `content_type_denied` / `rate_limited` / `validation_failed` / `score_out_of_range` / `invalid_name`。

**強化したい場合の候補**（必要になったら別PR）:

- HMAC 付きプレイトークン（init 時にサーバーから challenge → submit 時に HMAC 返却）
- サーバー側で拍タイムラインを再生（オーバーキル）
- Turnstile / reCAPTCHA で bot 除去（フックは実装済、`wrangler secret put TURNSTILE_SECRET` で有効化）
- `top100` race を Durable Objects に移行

## KV スキーマ

- `top100` : JSON 配列、上位 100 件、score DESC ソート済み。
  ```json
  [ { "id": "...", "score": 42000, "name": "タロウ", "at": 1714..., "trackId": 0 }, ... ]
  ```
- `submission:<id>` : TTL 10 分。`{score, at, position, isTop5, inList, nameAdded}`
- `stats:plays` : 総プレイ数カウンタ（ベストエフォート）
- `rate:<ip>:<bucket>` : TTL 120 秒。レート制限カウンタ（M-4）。`bucket` は `Math.floor(Date.now() / 60000)`。

## エラーコード一覧（クライアント表示用）

| HTTP | error | 表示推奨 |
|---|---|---|
| 400 | `bad_json` | 「通信エラー（送信データ不正）」 |
| 400 | `invalid_submission` (with `reason`) | 「スコア検証エラー」reasonで詳細分岐可能 |
| 400 | `invalid_name` | 「名前に使えない文字が含まれてるで」 |
| 400 | `score_out_of_range` | 「スコアが範囲外」（通常起きない） |
| 403 | `origin_not_allowed` | 「許可されてない接続元」 |
| 404 | `submission_not_found` | 「セッションの有効期限切れや」 |
| 404 | `not_found` | 「エンドポイント不正」 |
| 409 | `name_already_set` | 「もう名前登録済み」 |
| 409 | `not_in_list` | 「ランクインしてない」 |
| 410 | `entry_evicted` | 「他の人に押し出された…」 |
| 415 | `unsupported_content_type` | 「Content-Type が application/json じゃない」 |
| 429 | `rate_limited` (+ `Retry-After: 60`) | 「ちょっと連投しすぎ。しばらく待ってな」 |
| 500 | `kv_not_bound` / `internal` | 「サーバーエラー」 |

**注意**: KV は結果整合性のため、同時多発的に複数の high score が来ると一部上書きで消える可能性がある。1秒あたり数十件までなら実害なし。厳密な一貫性が必要になったら Durable Objects 化する。

## フロント統合（後工程）

Web Audio 移行 commit 完了後、`LP/game/game.js` 側に以下を追加する想定：

1. `triggerClear` 後のスコア確定で `POST /api/score`
2. レスポンスの `top` を CTA スコアボード横にスライドインで表示
3. `needsName: true` なら名前入力モーダル → `PUT /api/score/:id/name` → top5 再描画

詳細は `INTEGRATION.md` 参照。
