# Integration Guide — ランキングAPI × game.js

Web Audio 移行の commit が終わってから `LP/game/game.js` に組み込む手順メモ。
**API 側は完成済み。フロント統合だけ別ペインの作業完了後に実施。**

## 1. エンドポイント URL 管理

`game.js` 先頭に追加想定：

```js
const RANKING_API = 'https://kyomuusa-ranking.<subdomain>.workers.dev';
// 本番では https://caslive.jp/api に route する
```

localhost 開発時はフォールバック：

```js
const RANKING_API = location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://kyomuusa-ranking.<subdomain>.workers.dev';
```

## 2. 送信タイミング

`triggerClear` → `computeFinalScore()` 完了直後。
`state.scoreBreakdown` は既に埋まってる前提。

```js
async function submitScore() {
  try {
    const res = await fetch(`${RANKING_API}/api/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: GAME_VERSION,
        trackId: state.currentTrackId ?? null,
        stats: {
          taps: state.taps | 0,
          clearTime: state.rhythmClearSec ?? state.clearTime,
          maxCombo: state.maxCombo | 0,
          perfectCount: state.perfectCount | 0,
          greatCount: state.greatCount | 0,
          goodCount: state.goodCount | 0,
          missCount: state.missCount | 0,
          hitScore: state.runningScore | 0,
          decayTotal: Number(state.decayTotal || 0),
        },
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('[ranking] submit failed', e);
    return null; // フロントはオフライン耐性
  }
}
```

## 3. レスポンス処理

```js
const r = await submitScore();
if (r) {
  state.rankingResult = r;
  renderRankingPanel(r);      // CTA スコアボード右にスライドイン
  if (r.needsName) {
    showNameInput(r.submissionId);
  }
}
```

## 4. UI 仕様（じょじを要件）

- 表示場所: CTA の現スコアボード位置
- スライドイン: 横方向（CSS `transform: translateX()` + transition）
- 枠内容:
  - Top 5: 順位 / スコア / 名前（名前未登録は `---` や `ゲスト` 等）
  - 区切り線
  - YOU 行: 自分の順位 / スコア / `YOU`
- **Top5 ランクイン時**: YOU 行をハイライト（glow/点滅）+ 「NEW RECORD!!」的表示 + 名前入力枠（max 5 文字）
- 名前入力: Enter/決定で `PUT /api/score/:id/name` → 再描画

## 5. 名前入力 UI 要件

```html
<div class="name-input-modal">
  <p>TOP5ランクイン！ 名前を入力（5文字まで）</p>
  <input type="text" maxlength="5" id="rank-name-input" />
  <button id="rank-name-submit">OK</button>
</div>
```

注意：
- JS の `maxlength="5"` は UTF-16 ユニット基準なので絵文字（サロゲートペア）だと 2〜4 文字扱い。  
  サーバー側はコードポイント基準でカウントしてるから、送信前に `Array.from(value).slice(0,5).join('')` で揃える。
- Enter キー送信、空送信拒否、連打対策（送信中は disabled）。

## 6. エラー/オフライン時

- ネットワーク失敗: サイレントに握り潰して「ランキングに接続できません」小文字で表示（ゲーム本体は成立してる）
- `409 name_already_set`: 「既に登録済みです」
- `410 entry_evicted`: 「他プレイヤーが先にランクインしました」
- `400 invalid_submission`: 通常は起きない、起きたらログだけ吐く

## 7. 送信フィールド追加が必要な箇所

現 game.js で track id を持ってるか要確認：

```
GAME_BGM_TRACKS の index を選択時に state.currentTrackId に保存しておく
```

`Snd.gameBgmStart` が返す track から index を逆引きするか、`startBGM` 側で保存しておく。

## 8. バージョン bump

フロント統合 commit では：
- `GAME_VERSION` を `v98` 以上に
- `index.html` の `?v=N` 揃えて bump
- CHANGELOG 更新（いつもの慣習）
