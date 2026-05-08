# きょむうさ猛プッシュ

CasLive LP 埋め込み用のリズムタップミニゲーム。縦型スマホビュー前提、BGMに乗せて拍点でタップ → 99% で連打フェーズ突入 → クリアでスコア・ランク算出という流れ。

- **プレビュー**: https://kento-nakamura-gh.github.io/game/（main 直push で自動デプロイ、HTML max-age=600）
- **本番**: https://game.caslive.app/（中村側Vercel運用、サブドメイン）
- **リポジトリ**: https://github.com/kento-nakamura-GH/game

## プレイの流れ

1. **タイトル** (`#scene-title`) — Start ボタンで選曲画面へ遷移
2. **選曲** (`#scene-select`) — 5曲のカード + RANDOM カード。タップでプレビュー再生（fade-loop）、PLAY ボタンでゲーム開始（暗転トランジション）。曲ごとのベストスコア・ベストランクを表示
3. **ゲーム** (`#scene-game`) — READY?/GO!! カウントダウン後、拍点に合わせてタップ。Perfect/Great/Good/Miss で判定
4. **FEVER zone** — gauge 60% 到達で発火。タイミングリングが黄→ピンクに変化、得点 1.5 倍
5. **猛プッシュ（連打フェーズ）** — gauge 99% 到達で起動。30 連打で 100% クリア
6. **クリア** (`#scene-clear`) → **動画** (`#scene-video`) → **CTA** (`#scene-cta`) — スコアロール、ランクバッジ、ランキング表示、SNSシェア

## 構成

```
index.html             メインHTML（6シーン全部内包＋debug picker）
css/                   分割CSS（依存順にloadされる）
  base.css             変数・リセット・共通要素
  title.css            タイトル＋debug picker
  select.css           選曲画面（カードリスト・PLAYボタン・暗転トランジション）
  scene-game.css       ゲーム画面（room-bg, gauge, rhythm-ring, push-btn, FEVER）
  overlays.css         FEVER!/猛プッシュ/FINISH オーバーレイ
  clear-video.css      クリア画面＋動画シーン
  cta.css              CTA画面（ランクバッジ, scoreboard, share）
  ranking.css          ランキングパネル
  responsive.css       breakpoint別調整（iPhone SE / 背高端末）
js/                    ES module 分割
  main.js              entry point — DOMContentLoaded で init()
  config.js            TUNING/GAME_VERSION/RANKING_API/STAGE_GIFS/BG_VARIANTS
  state.js             共有可変state（gauge, taps, fever counts 等）
  dom.js               element refs + scene switcher
  sound.js             Web Audio BGM/SE管理 + previewStart/previewStop（選曲画面用）
  select.js            選曲画面ロジック（buildCards / selectTrack / showSelectScreen / doRandom）
  rhythm.js            beat scheduler + ring indicator + judgeTap
  tap.js               handleTap 振り分け + mash mode
  fever.js             FEVER zone 起動/終了
  stage.js             gauge レンダ + GIF stage machine
  effects.js           パーティクル/フラッシュ/シェイク/コンボポップ
  gameloop.js          rAF loop + startGame/triggerClear + BG picker
  score.js             computeFinalScore + rank + scoreboard演出
  ranking.js           Cloudflare Workers連携 + name入力モーダル
  ui-extras.js         title pop, tagline typewriter, share, debug picker(BG選択)
assets/
  musicA-E.mp3                ゲームBGM 5曲（130-137 BPM）
  music_title.mp3             タイトルBGM
  music_endA/endB.mp3         CTA BGM 2種
  SE1/SE2/SE3/SE_clear.mp3    各種SE
  kyomuA-F.webp               キャラGIF（A→B→C→D→E ステージ進行 + F クリア演出）
  goodicon_01-07.webp         タップパーティクル（実アプリのいいね素材）
  gameBG_A.webp               メインBG（80% 出現）
  gameBG_B.webp               レアBG（20% 出現）
  clearBG.webp / titleBG.webp / CTA_BG.webp  各シーン背景
game-api/                ランキングAPI（Cloudflare Workers、同monorepo配下）
  src/index.js           POST /api/score, PUT /api/score/:id/name, GET /api/top
  wrangler.toml          KV namespace: kyomuusa-ranking, ALLOWED_ORIGINS など環境変数
tools/
  bpm_analyze.py / bpm_drift_check.py  BPM計測検証
  convert_webp.py                       アセット一括webp変換
  gen_favicons.py                       favicon生成
```

## スコアリング

### タップ判定（リズムフェーズ）

| 判定 | ウィンドウ | ゲージ増加 | running score |
|---|---|---|---|
| Perfect | ±100ms | +2.95 | 300 × コンボ倍率 |
| Great | ±190ms | +1.77 | 180 × コンボ倍率 |
| Good | ±290ms | +1.00 | 90 × コンボ倍率 |
| Miss | 外し | 0 | 0 |

コンボ倍率 = `1 + min(combo, 30) × 0.05`（最大 2.5 倍）。Miss でコンボリセット。

### FEVER zone（gauge 60% 〜 mash entry）

- gauge 60% 到達で起動。タイミングリングが黄(#FFE600)→赤寄りピンク(#FF3370)、PUSH ボタン外周も同色に
- FEVER 中の Perfect/Great/Good は **得点 1.5 倍**
- 内訳: ratingPts × 1.5（runningScore）+ accuracyBonus に feverBonus 加算（0.5x ベース）

### 猛プッシュ（99% → 100%）

- gauge 99% 到達 → 350ms 後に mash mode 突入
- 30 タップで 100% 到達 → クリア
- 1 タップ +200 点、30 回到達時に BREAKTHROUGH 表示
- オーバーシュート（31回目以降）は 4 重ガードで遮断
- mash 中の taps は server validation 上 great に集計

### 最終スコア

```
total = max(0, round((hitScore + timeBonus + accuracyBonus + comboBonus + noMissBonus − decayPenalty) × efficiencyFactor))
```

| 項目 | 計算 |
|---|---|
| **hitScore** | `min(runningScore, 300 × taps)`（タップごと 300 cap、FEVER 1.5x の余白込み）|
| **timeBonus** | rhythmTimeBonus（ビート単位） + mashTimeBonus（秒単位）|
| **accuracyBonus** | `perfectCount × 400 + (greatCount + mashCount) × 150 + feverBonus` |
| **feverBonus** | `feverPerfect × 200 + feverGreat × 75 + feverGood × 45` |
| **comboBonus** | `maxCombo × 200` |
| **noMissBonus** | Miss=0 で +3000 フラット |
| **decayPenalty** | `decayTotal × 40` |
| **efficiencyFactor** | `clamp(0.3, 1.0, 44 / max(taps, 44))` |

#### timeBonus のテンポ補正

リズムフェーズはビート単位、マッシュフェーズは秒単位で算出。BGM の BPM 差で生まれる時間ボーナスのバラツキを潰す設計。

**rhythmTimeBonus（ビート単位、targetBeats=44）**

```
rhythmBeats = rhythmSec × 1000 / beatIntervalMs
under target (≤44 beats): 5000 + (44 - rhythmBeats) × 700
over target  (>44 beats): max(0, (44 + 11 - rhythmBeats) × 460)
```

**mashTimeBonus（秒単位、target=8s）**

| マッシュ時間 | bonus | 評価 |
|---|---|---|
| 4 秒 | 4,000 | 神速 |
| 5 秒 | 3,750 | 速い |
| 8 秒 | 3,000 | 標準 |
| 10 秒 | 600 | 遅め |
| 12 秒+ | 0 | 圏外 |

```
under target (≤8s): 3000 + (8 - mashSec) × 250
over target  (>8s): max(0, (8 + 4 - mashSec) × 300)
```

### ランク

| ランク | 閾値 |
|---|---|
| **SS** | 42,000+ |
| **S** | 40,000+ |
| **A** | 38,000+ |
| **B** | 36,000+ |
| **C** | 34,000+ |
| **D** | <34,000 |

SS は虹グラデーション + ピンクボーダー、`.rank-double` で 2 文字幅をフォントサイズ縮小で吸収。

## ランキング統合（Cloudflare Workers）

クリア後、`triggerClear()` から `submitScore()` を fire-and-forget で発火。CTA 画面に到達する頃にレスポンスが返ってきている設計。

- エンドポイント: `https://kyomuusa-ranking.caslive.workers.dev`（2026-05-07 に旧 kento-nakamura-62a.workers.dev から移行済み）
- POST `/api/score` — 集計済 stats を投げて、score / position / top5 が返る
- PUT `/api/score/:id/name` — top入りした際、5文字以内の名前を後付け
- GET `/api/top` — 現在の top（TOP_LIST_SIZE=300、レスポンスは TOP_RETURN_SIZE=5）
- GET `/api/health` — liveness

CORS allowlist（`ALLOWED_ORIGINS` 環境変数）: `kento-nakamura-gh.github.io` / `game.caslive.app` / localhost。新環境（ステージング等）追加時は `wrangler.toml` 編集 → `npx wrangler deploy`。

セキュリティ強化（v=182〜）: Origin allowlist 強制 / Content-Type 検証 / IP単位 Rate limit / XSS sanitize / Turnstile 任意対応（`TURNSTILE_SECRET` を `wrangler secret put` で設定すると有効）。

サーバー側（`game-api/src/index.js`）はクライアントの集計を信用せず `recomputeScore` で全項目を再算出。client/server の式は完全 lock-step（更新時は両方同時に bump、SCORE_CONSTANTS と TUNING を一致させる）。

CTA panel ではスコアロール後にランキングがスライドインし、scoreboard ⇄ ranking のスワイプカルーセル UI に切り替わる。top5 入りした場合は名前入力モーダルが先に出る。

## BGM / BPM チューニング

5 曲の BPM と offset（最初の拍までの遅延 ms）を個別設定。

```js
// js/sound.js GAME_BGM_TRACKS
{ src: './assets/musicA.mp3', bpm: 130.8, offsetMs: 487,  title: 'Milky CasWay' },
{ src: './assets/musicB.mp3', bpm: 131,   offsetMs: 468,  title: 'Parallel CasNight' },
{ src: './assets/musicC.mp3', bpm: 130.8, offsetMs: 862,  title: 'Signals of CasLiver' },
{ src: './assets/musicD.mp3', bpm: 126.7, offsetMs: 1700, title: 'Tropical CasSoda' },
{ src: './assets/musicE.mp3', bpm: 137,   offsetMs: 1234, title: 'Sunset CasDrive' },
```

**重要**: BPM は librosa 実測値を使うこと。「先読み感」を作るために BPM をブーストする手法は禁止（30拍までに約+118ms のドリフトが累積し、Great/Good 判定窓を超えて Miss が量産される）。一定の手前感が欲しい場合は `offsetMs` を前にずらすか `TUNING.beatLatencyMs` を下げる。

`useAudioTimeSync: true`（デフォルト）で beat grid を毎フレ audio.currentTime から再導出。HTMLAudio は端末によって currentTime が 50-200ms チャンキーに更新される問題があり、Web Audio API の AudioBufferSourceNode に置き換え済（v=98 以降）。

## TUNING パラメータ

`js/config.js` の `TUNING` オブジェクトで調整。devtools から `window.TUNING.beatLatencyMs = 180` のようにライブ変更可。

| キー | 現在値 | 役割 |
|---|---|---|
| `beatIntervalMs` | 560 | デフォルト拍間隔（曲ごとに `60000/bpm` で再計算） |
| `perfectWindowMs` | 100 | Perfect判定ウィンドウ（±ms）|
| `greatWindowMs` | 190 | Great判定ウィンドウ |
| `goodWindowMs` | 290 | Good判定ウィンドウ |
| `gainPerfect/Great/Good` | 2.95 / 1.77 / 1.00 | 各判定のゲージ増加量 |
| `decayPerSec` | 2.0 | 手を止めたときの毎秒減衰量 |
| `targetTimeSec` | 27 | （legacy。現スコア式は targetBeats=44 ベース）|
| `beatLatencyMs` | 80 | 全体の拍タイミング遅延補正 |
| `effectIntensity` | 10 | パーティクル量・演出強度 |
| `shakeEnabled` / `flashEnabled` | true / true | 画面シェイク / 白フラッシュ |
| `useAudioTimeSync` | true | every-frame audio-time 同期（誤差最小）|

## 背景バリアント

`BG_VARIANTS`（`js/config.js`）で複数の BG を重み付き抽選。`startGame()` ごとに 1 枚決定。

| variant | 確率 | bleed color |
|---|---|---|
| gameBG_A | 80% | `#9ED9CF`（壁の緑）|
| gameBG_B | 20% | `#0F1749`（深ネイビー）|

`bleed` 色は iPhone SE 等の狭幅ビューで画像端の外側に見える縁色。各 BG 画像のエッジパレットに合わせて指定する。

## デバッグ

タイトル画面を **5 タップ**（1.5 秒以内）で Debug Picker を起動。

- **BACKGROUND**: RANDOM (80/20) / BG_A / BG_B（localStorage `kyomuusa_force_bg`）

選択値は次の `startGame()` から反映。BGM 選曲はゲーム本編の選曲画面（scene-select）に正式機能として移管済み（v=178 以降は Debug Picker から削除）。

## GIFステージ進行

ゲージ進捗に応じてキャラ GIF が段階的に切り替わる。

| stage | 役割 | ループ | 遷移契機 |
|---|---|---|---|
| A | 0-25%（idle） | ○ | gauge≥25 で B 予約 |
| B | bridge（耳ピク） | × | A ループ完了で再生→C |
| C | 25-60%（interest） | ○ | gauge≥60 で D 予約 |
| D | bridge（前のめり） | × | C ループ完了で再生→E |
| E | 60-100%（excited） | ○ | クリアまでループ |
| F | クリア演出（kiss） | × | triggerClear で再生、4秒で次シーン |

ブリッジ B/D はループ完了タイミングで差し替え（`queueGifAdvance`）、ちらつきなし。

## 演出の仕組み

- ボタン押下 `scale(0.92)` → `elastic.out` で弾性復元（GSAP）
- リップル波紋（CSS animation）
- パーティクル散布（goodicon 画像、量は `effectIntensity` × レーティング）
- コンボ数字ポップアップ（Perfect × 3+ / 10 COMBO / 毎 5 コンボ）
- 画面シェイク（レーティング別に 2-4px）
- 白フラッシュ（80ms）
- ゲージのパルスリング（パリティトグル + `void offsetWidth` で強制 reflow）
- FEVER 中はリング/ボタン/シーンチントが赤系に
- mash mode はフルスクリーン「猛プッシュ」オーバーレイ

## シェア

CTA 画面の X / LINE / Threads / コピーボタンから。文面例:

```
#きょむうさ猛プッシュ でランクSS/スコア42,150/ランキング3位達成！
みんなでハイスコアを目指そう🐰🥇
#CasLive
```

`buildShareText()`（`js/ui-extras.js`）で生成。順位は `state.rankingResult.you.position` か `r.top[i].you=true` の index から取得、フォールバックは省略。

## 技術

- Vanilla ES modules + GSAP 3.12（演出のみ）
- Web Audio API — `AudioBufferSourceNode` で BGM、`bgmCurrentTime` を ms 換算して beat grid 算出
- `getAudioClockMs()` で audio.currentTime ベースの判定
- iOS Safari unlock: 1-sample 無音 buffer を user gesture 内で `start(0)`、後続の async `decodeAudioData` 連鎖を有効化
- iOS サイレントスイッチ override: `navigator.audioSession.type = 'playback'`
- 60fps 目標、パーティクル / ring は `requestAnimationFrame` 管理
- `touch-action: manipulation`、`touchstart` / `mousedown` 二重発火防止
- GIF ちらつき防止: ダブルバッファ（2 枚 img を交互に visibility で swap）
- アクセシビリティ: `prefers-reduced-motion` 対応
- スペースキーでデスクトップタップ可能（開発用）

## キャッシュ更新

CSS / JS / HTML の更新時は **3 箇所同時に bump**:

1. `index.html` の `?v=NNN` — 全 CSS / main.js
2. `js/config.js` の `GAME_VERSION = 'vNNN'` — server に送信される version 識別子 + debug picker 表示

片方だけ上げるとブラウザ側で新旧が混在して破綻する。GitHub Pages の HTML は `max-age=600`（10 分）なので CDN 反映に最大 10 分かかる。

## ローカル確認

```bash
# クライアントだけ確認（ランキング送信はリモート本番に飛ぶ → sanity check で蹴られる可能性）
cd game
python -m http.server 8000
# → http://localhost:8000/

# server もローカルで立ち上げる場合
cd game/game-api
npx wrangler dev --port 8787 --local
# js/config.js の RANKING_API を 'http://localhost:8787' に一時的に書き替えて使う。
# 戻し忘れると本番デプロイ時に客がlocalhostを見にいって全滅するので注意。
```

`file://` 直開きは Web Audio API が CORS で動かないので必ず HTTP サーバー経由。

## デプロイ

```bash
# server 先（client が新payloadを投げるので、server 旧版だと validation で全部蹴られる）
cd game/game-api
npx wrangler deploy

# client 後（gameディレクトリ root から）
cd game
git add -A
git commit -m "..."
git push    # main 直push で GitHub Pages（preview）と Vercel（本番）の両方が自動デプロイ
```

本番反映フロー: `main` 直push → Vercel が `game.caslive.app` を自動更新（GitHub連携）。同時に GitHub Pages の `kento-nakamura-gh.github.io/game/` も更新される（プレビュー兼用）。

`.vercelignore` で `game-api/` / `tools/` / `*.md` 等は Vercel deploy対象外（フロント配信に不要）。
