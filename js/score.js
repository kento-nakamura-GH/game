/* ============================================================
   score.js — Final-score formula, rank lookup, CTA scoreboard
   reveal sequence, and the YES/NO clear-scene flow.
   computeFinalScore must stay lock-step with server recomputeScore
   (LP/game-api/src/index.js) — see comment block in the function.
   ============================================================ */

import { TUNING, BEST_RANK_KEY } from './config.js';
import { state } from './state.js';
import { els, showScene } from './dom.js';
import { Snd } from './sound.js';
import { doShake } from './effects.js';
import {
  hideRankingPanel, hideNameInput,
  renderRankingPanel, showNameInput,
} from './ranking.js';

/* ---------- Rolling number / Rank ---------- */
export function rollNumber(el, from, to, duration = 900, onDone) {
  if (!el) { onDone && onDone(); return; }
  const startTs = performance.now();
  el.classList.add('rolling');
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  function frame(now) {
    const t = Math.min(1, (now - startTs) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = from + (to - from) * eased;
    el.textContent = fmt(val);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      el.textContent = fmt(to);
      el.classList.remove('rolling');
      el.classList.remove('pop'); void el.offsetWidth;
      el.classList.add('pop');
      onDone && onDone();
    }
  }
  requestAnimationFrame(frame);
}

export function computeRank(score) {
  // v=156 retune: shifted higher to match the +800/tap mash + efficiency-bypass
  // scoring profile. SS now lives in the 70k+ summit, with tight bands around
  // the C/B/A boundary (56k-60k) and a wider gap up to S/SS for top plays.
  if (score >= 70000) return 'SS';
  if (score >= 65000) return 'S';
  if (score >= 60000) return 'A';
  if (score >= 58000) return 'B';
  if (score >= 56000) return 'C';
  return 'D';
}

/* Final score: timing-first balance — reward precision + combo + speed,
   penalize hammering and gauge decay.
   - hitScore: runningScore (per-tap rating*combo mult). Miss=0. Cap 300/tap
     gives FEVER's 1.5x multiplier room to breathe (was 200 pre-v=147).
   - timeBonus: ビート単位で評価（テンポ差を打ち消す）。targetBeats=44 を基準に
     早ければ +、遅ければ漸減。マッシュフェーズ時間は除外。
   - accuracyBonus: perfectCount*400 + (great+mash)*150 + feverBonus(0.5x base
     for fever-zone hits)。
   - comboBonus: maxCombo * 200。
   - noMissBonus: missCount===0 で +3000 フラット。
   - decayPenalty: 減衰で失ったゲージ量 * 40 を減点。
   - efficiencyFactor: タップ数超過で減衰、下限 0.3。基準 44 (1.5x play time)。
   Lock-step with server recomputeScore — both clamp hitScore to 300 * taps,
   count mash taps as 'great', and apply the same fever bonus. Without these
   the scoreboard total and ranking row total disagree. */
export function computeFinalScore() {
  const taps = state.taps || 0;
  const mashTaps = state.mashCount || 0;
  const rhythmTaps = Math.max(0, taps - mashTaps);
  const HIT_SCORE_PER_TAP_CAP = 300;
  // v=153: hitScore cap excludes mash taps (mash phase scored via mashScore).
  const mashScore = state.mashRunningScore || 0;
  const rhythmRunningScore = Math.max(0, (state.runningScore || 0) - mashScore);
  const hitScore = Math.min(rhythmRunningScore, HIT_SCORE_PER_TAP_CAP * rhythmTaps);

  // Beat-normalized rhythm timeBonus: removes tempo bias (faster songs no
  // longer get free seconds-bonus). Convert rhythmSec → rhythmBeats via
  // beatIntervalMs. Mash phase is intentionally NOT included here.
  const interval = state.lastBeatInterval || TUNING.beatIntervalMs || 458;
  const targetBeats = 44;
  const rhythmSec = state.rhythmClearSec || state.clearTime;
  const rhythmBeats = (rhythmSec * 1000) / interval;
  const rhythmTimeBonus = rhythmBeats <= targetBeats
    ? 5000 + Math.round((targetBeats - rhythmBeats) * 700)
    : Math.max(0, Math.round((targetBeats + 11 - rhythmBeats) * 460));

  // v=155 mash mode: mashTimeBonus folded into mashScore (+800/tap directly).
  const totalClearSec = state.clearTime || rhythmSec;
  const mashTimeSec = Math.max(0, totalClearSec - rhythmSec);
  const mashTimeBonus = 0;

  const timeBonus = rhythmTimeBonus + mashTimeBonus;

  // v=153: mash taps go into goodCount in the payload, so accuracyBase here
  // mirrors that — only real great counts contribute, NOT mashCount.
  const accuracyBase = (state.perfectCount || 0) * 400 + (state.greatCount || 0) * 150;
  // FEVER bonus: 0.5x of base accuracy values for hits that landed during the
  // fever zone. Combined with the tap.js 1.5x runningScore multiplier this
  // delivers the user-facing "FEVER中は得点1.5倍" promise end-to-end.
  const feverBonus = (state.feverPerfectCount || 0) * 200
                   + (state.feverGreatCount || 0) * 75
                   + (state.feverGoodCount || 0) * 45;
  const accuracyBonus = accuracyBase + feverBonus;
  const comboBonus = (state.maxCombo || 0) * 200;
  const noMissBonus = (state.missCount || 0) === 0 ? 3000 : 0;
  const decayPenalty = Math.round((state.decayTotal || 0) * 40);
  const optimalTaps = 44;
  const efficiencyFactor = Math.max(
    0.3,
    Math.min(1.0, optimalTaps / Math.max(taps || optimalTaps, optimalTaps))
  );
  // v=155: mashScore bypasses efficiencyFactor so heavy mash actually scales
  // the final score. Rhythm-side raw still gets multiplied by efficiencyFactor.
  // This must stay lock-step with server recomputeScore (game-api/src/index.js).
  const rawWithoutMash = hitScore + timeBonus + accuracyBonus + comboBonus + noMissBonus - decayPenalty;
  const total = Math.max(0, Math.round(rawWithoutMash * efficiencyFactor) + mashScore);
  state.scoreBreakdown = { hitScore, timeBonus, rhythmTimeBonus, mashTimeBonus, mashTimeSec, mashScore, accuracyBonus, comboBonus, noMissBonus, decayPenalty, feverBonus, efficiencyFactor, total };
  return total;
}

export function renderCTAScore() {
  const bd = state.scoreBreakdown || { hitScore: 0, timeBonus: 0, accuracyBonus: 0, comboBonus: 0, noMissBonus: 0, decayPenalty: 0, total: state.finalScore || 0 };
  const total = bd.total || state.finalScore || 0;
  const rank = computeRank(total);
  state.rank = rank;
  // Persist best rank per track
  const RANK_ORDER = ['D', 'C', 'B', 'A', 'S', 'SS'];
  try {
    const tid = state.currentTrackId;
    if (tid != null && tid >= 0) {
      const key = BEST_RANK_KEY + tid;
      const prev = localStorage.getItem(key);
      if (!prev || RANK_ORDER.indexOf(rank) > RANK_ORDER.indexOf(prev)) {
        localStorage.setItem(key, rank);
      }
    }
  } catch(e) {}
  // "TIMING BONUS" row bundles accuracy + noMiss - decay (non-negative display)
  const timingVal = Math.max(0, (bd.accuracyBonus || 0) + (bd.noMissBonus || 0) - (bd.decayPenalty || 0));

  // reset rows + rank
  [els.sbRowScore, els.sbRowCombo, els.sbRowTiming, els.sbRowTime, els.sbRowTotal].forEach(r => r && r.classList.remove('show'));
  if (els.sbDivider) els.sbDivider.classList.remove('show');
  hideRankingPanel();
  hideNameInput();
  if (els.sbScore)       els.sbScore.textContent = '0';
  if (els.sbCombo)       els.sbCombo.textContent = '0';
  if (els.sbTimingBonus) els.sbTimingBonus.textContent = '0';
  if (els.sbTimeBonus)   els.sbTimeBonus.textContent = '0';
  if (els.sbTotal)       els.sbTotal.textContent = '0';
  if (els.ctaRankBadge) {
    els.ctaRankBadge.className = 'cta-rank-badge';
    // SS letters are 2-wide, so trim font-size slightly via a marker class
    // — keeps the badge from overflowing the .cta-info row width.
    if (rank === 'SS') els.ctaRankBadge.classList.add('rank-double');
    els.ctaRankBadge.textContent = rank;
  }

  const delays = {
    row1:    300,
    row2:    850,
    row3:   1400,
    row4:   1950,
    divider:2500,
    total:  2700,
    rank:   3950,
  };

  setTimeout(() => {
    if (els.sbRowScore) els.sbRowScore.classList.add('show');
    Snd.countBeep(false);
    rollNumber(els.sbScore, 0, bd.hitScore, 600);
  }, delays.row1);

  setTimeout(() => {
    if (els.sbRowCombo) els.sbRowCombo.classList.add('show');
    Snd.countBeep(false);
    rollNumber(els.sbCombo, 0, state.maxCombo || 0, 500);
  }, delays.row2);

  setTimeout(() => {
    if (els.sbRowTiming) els.sbRowTiming.classList.add('show');
    Snd.countBeep(false);
    rollNumber(els.sbTimingBonus, 0, timingVal, 600);
  }, delays.row3);

  setTimeout(() => {
    if (els.sbRowTime) els.sbRowTime.classList.add('show');
    Snd.countBeep(false);
    rollNumber(els.sbTimeBonus, 0, bd.timeBonus, 600);
  }, delays.row4);

  setTimeout(() => {
    if (els.sbDivider) els.sbDivider.classList.add('show');
  }, delays.divider);

  setTimeout(() => {
    if (els.sbRowTotal) els.sbRowTotal.classList.add('show');
    Snd.countBeep(true);
    rollNumber(els.sbTotal, 0, total, 1100);
  }, delays.total);

  setTimeout(() => {
    if (els.ctaRankBadge) {
      els.ctaRankBadge.classList.add('rank-' + rank, 'show');
      Snd.finish();
    }
  }, delays.rank);

  // Ranking panel slides in after rank badge. If the fetch is still in flight,
  // show as soon as it resolves. On network failure renderRankingPanel shows a
  // connect-error status.
  const RANKING_SHOW_DELAY = delays.rank + 900;
  const showRanking = () => {
    if (!state.rankingResult && !state.rankingPromise) {
      renderRankingPanel(null);
      return;
    }
    if (state.rankingResult) {
      renderRankingPanel(state.rankingResult);
      if (state.rankingResult.needsName) showNameInput(state.rankingResult.submissionId);
      return;
    }
    state.rankingPromise.then(r => {
      state.rankingResult = r;
      renderRankingPanel(r);
      if (r && r.needsName) showNameInput(r.submissionId);
    });
  };
  setTimeout(showRanking, RANKING_SHOW_DELAY);
}

/* ---------- Clear scene typewriter + YES/NO ---------- */
export function showClearSequence() {
  els.clearWindow.classList.remove('show'); void els.clearWindow.offsetWidth;
  els.clearWindow.classList.add('show');
  els.typed.textContent = '';
  els.clearActions.classList.remove('show');
  const text = '他の人より\nもう一歩、\nキョリが近づいた。';
  let i = 0;
  setTimeout(function typeNext() {
    if (i >= text.length) {
      setTimeout(() => els.clearActions.classList.add('show'), 260);
      return;
    }
    els.typed.textContent += text[i];
    i++;
    const d = text[i-1] === '\n' ? 220 : (50 + Math.random() * 40);
    setTimeout(typeNext, d);
  }, 650);
}

export function onYes() {
  Snd.playSE('se3');
  showScene('video');
  const v = els.splashVideo;
  try { v.currentTime = 0; } catch (e) {}

  let done = false;
  const goToCTA = () => {
    if (done) return;
    done = true;
    try { v.pause(); } catch (e) {}
    showScene('cta');
    renderCTAScore();
    Snd.ctaBgmStart();
  };

  v.onended = goToCTA;
  const p = v.play();
  if (p && typeof p.catch === 'function') p.catch(goToCTA);

  // Safety net: if 'ended' never fires (stuck decode / unsupported codec),
  // bail after the video's natural duration + slack. The iOS-optimized encode
  // (720x1732 H.264 Main L4.0) should play reliably on iPhone, but this guard
  // protects against edge cases.
  setTimeout(() => {
    if (!done && els.scenes.video.classList.contains('active') &&
        (v.paused || v.ended || v.readyState < 2)) {
      goToCTA();
    }
  }, 5000);
}

export function onNo(ev) {
  const b = ev.currentTarget;
  b.classList.remove('shake'); void b.offsetWidth;
  b.classList.add('shake');
  doShake(5);
}
