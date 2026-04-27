/* ============================================================
   config.js — TUNING constants, version, endpoints, GIF stages
   ============================================================ */

export const GAME_VERSION = 'v178';

/* ---------- Fever phase ----------
   Triggered when gauge crosses FEVER_THRESHOLD; ends at mash entry (gauge=99).
   Threshold matches the C→D GIF transition so visuals + game state align. */
export const FEVER_THRESHOLD = 60;

/* ---------- Ranking API ---------- */
// Always use the remote Workers endpoint. The localhost fallback is intentionally
// removed — in practice nobody has wrangler dev running locally, so localhost
// would fail-fast with a network error and show "接続できません" even though
// the prod API is up. For local dev, edit this constant temporarily.
export const RANKING_API = 'https://kyomuusa-ranking.kento-nakamura-62a.workers.dev';

export const TUNING = /*EDITMODE-BEGIN*/{
  "beatIntervalMs": 560,
  "beatSpeedupAt100": 0.5,
  "perfectWindowMs": 100,
  "greatWindowMs": 190,
  "goodWindowMs": 290,
  "gainPerfect": 2.95,
  "gainGreat": 1.77,
  "gainGood": 1.00,
  "gainMiss": 0,
  "decayPerSec": 2.0,
  "targetTimeSec": 27,
  "beatLatencyMs": 80,
  "hologramStrength": 0,
  "effectIntensity": 10,
  "shakeEnabled": true,
  "flashEnabled": true,
  "particlesEnabled": true,
  "useAudioTimeSync": true
}/*EDITMODE-END*/;

// Expose for devtools tuning (e.g., window.TUNING.beatLatencyMs = 180)
if (typeof window !== 'undefined') window.TUNING = TUNING;

/* Rabbit stage GIFs — 3-level hype progression with seamless transitions
   A(loop 0-25%) → B(bridge) → C(loop 25-60%) → D(bridge) → E(loop 60-100%) → F(clear kiss, 2.5s)
   Durations measured from the actual GIFs (ms). */
export const STAGE_GIFS = {
  A: { src: './assets/kyomuA.webp', dur: 2800, loop: true,  next: 'B' },
  B: { src: './assets/kyomuB.webp', dur: 1200, loop: false, next: 'C' },
  C: { src: './assets/kyomuC.webp', dur: 440,  loop: true,  next: 'D' },
  D: { src: './assets/kyomuD.webp', dur: 1440, loop: false, next: 'E' },
  E: { src: './assets/kyomuE.webp', dur: 1200, loop: true,  next: null },
  F: { src: './assets/kyomuF.webp', dur: 3000, loop: false, next: null },
};
export const CLEAR_F_PLAY_MS = 4000;

/* Tap-particle assets — same icons used as the in-app "like" button to foreshadow CasLive. */
export const GOOD_ICONS = [
  './assets/goodicon_01.webp',
  './assets/goodicon_02.webp',
  './assets/goodicon_03.webp',
  './assets/goodicon_04.webp',
  './assets/goodicon_05.webp',
  './assets/goodicon_06.webp',
  './assets/goodicon_07.webp',
];

/* SNS share */
// #きょむうさ猛プッシュ moved to the start of buildShareText's line 1.
// Only the residual hashtags remain here (joined to the message body via \n).
export const SHARE_HASHTAGS = '#CasLive';
export const SHARE_URL = (typeof window !== 'undefined' && window.location)
  ? window.location.href.split('?')[0]
  : 'https://caslive.jp/';

/* Debug picker (5タップ起動。BGM選曲は scene-select に移管したのでBG選択のみ) */
export const SONG_PICKER_TAP_WINDOW = 1500; // ms — taps within window count toward unlock
export const SONG_PICKER_REQUIRED = 5;

/* Background variants — picked at startGame() with weighted randomness.
   Weights are integers; pickBackground sums them and rolls Math.random*total.
   Force-select via debug picker writes BG_PICKER_KEY=<index> to localStorage.
   `bleed` is the fallback color shown around the BG image on viewports too
   narrow for the image's aspect ratio (e.g., iPhone SE) — must match each
   image's edge palette so the bleed strip is invisible. */
export const BG_VARIANTS = [
  { src: './assets/gameBG_A.webp', label: 'BG_A', weight: 80, bleed: '#9ED9CF' },
  { src: './assets/gameBG_B.webp', label: 'BG_B', weight: 20, bleed: '#0F1749' },
];
export const BG_PICKER_KEY = 'kyomuusa_force_bg';

/* Best rank per track — keyed as BEST_RANK_KEY + trackIndex (0-4) */
export const BEST_RANK_KEY = 'kyomuusa_bestRank_';
/* Best score per track — keyed as BEST_SCORE_KEY + trackIndex (0-4) */
export const BEST_SCORE_KEY = 'kyomuusa_bestScore_';
