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
- DevTools で `state.perfectCount` を直接盛る程度は落とせるが、大規模なチートは弾ききれない。LP のフックなので許容。

**強化したい場合の候補**（必要になったら別PR）:

- HMAC 付きプレイトークン（init 時にサーバーから challenge → submit 時に HMAC 返却）
- サーバー側で拍タイムラインを再生（オーバーキル）
- Turnstile / reCAPTCHA で bot 除去

## KV スキーマ

- `top100` : JSON 配列、上位 100 件、score DESC ソート済み。
  ```json
  [ { "id": "...", "score": 42000, "name": "タロウ", "at": 1714..., "trackId": 0 }, ... ]
  ```
- `submission:<id>` : TTL 10 分。`{score, at, position, isTop5, inList, nameAdded}`
- `stats:plays` : 総プレイ数カウンタ（ベストエフォート）

**注意**: KV は結果整合性のため、同時多発的に複数の high score が来ると一部上書きで消える可能性がある。1秒あたり数十件までなら実害なし。厳密な一貫性が必要になったら Durable Objects 化する。

## フロント統合（後工程）

Web Audio 移行 commit 完了後、`LP/game/game.js` 側に以下を追加する想定：

1. `triggerClear` 後のスコア確定で `POST /api/score`
2. レスポンスの `top` を CTA スコアボード横にスライドインで表示
3. `needsName: true` なら名前入力モーダル → `PUT /api/score/:id/name` → top5 再描画

詳細は `INTEGRATION.md` 参照。
