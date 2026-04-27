/* ============================================================
   tap.js — handleTap dispatcher, mash mode (99% → 5秒間連打).
   ============================================================ */

import { TUNING } from './config.js';
import { state } from './state.js';
import { els, parity } from './dom.js';
import { Snd } from './sound.js';
import { judgeTap } from './rhythm.js';
import { renderGauge } from './stage.js';
import { showBadge, spawnParticles, spawnRipple, doFlash, doShake, spawnCombo } from './effects.js';
import { triggerClear } from './gameloop.js';
import { exitFever } from './fever.js';

export function handleTap(ev) {
  if (!state.running) return;
  if (ev && ev.cancelable) ev.preventDefault();
  if (ev && ev.type === 'touchstart') els.pushBtn._touched = true;
  if (ev && ev.type === 'mousedown' && els.pushBtn._touched) { els.pushBtn._touched = false; return; }

  // iOS Safari opportunistic: if context was suspended mid-game (silent switch,
  // memory pressure, brief interrupt) or source dropped, re-arm BGM. No-op if
  // already playing, so safe to call every tap.
  if (Snd && Snd.ensurePlaying) Snd.ensurePlaying();

  // Ignore overshoot taps after the mash finisher so the gauge can't rebound to 99.
  if (state.cleared || state.gauge >= 100) return;

  const now = performance.now();
  if (now - state.lastTapAt < 60) return; // debounce
  state.lastTapAt = now;
  state.taps++;
  els.tapCount.textContent = String(state.runningScore || 0).padStart(6, '0');

  // Mash mode (99% → 5秒間連打) bypasses rhythm judgment entirely.
  if (state.mashMode) {
    doMashTap();
    return;
  }

  const { rating, gain } = judgeTap(now);
  // Cap at 99 — the final 1% is awarded when the 5s mash window ends.
  state.gauge = Math.min(99, state.gauge + gain);

  // combo logic: perfect/great/good build combo, miss resets
  if (rating === 'miss') {
    state.combo = 0;
    state.perfectStreak = 0;
    state.missCount++;
  } else {
    state.combo++;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
    if (rating === 'perfect') { state.perfectStreak++; state.perfectCount++; }
    else { state.perfectStreak = 0; }
    if (rating === 'great') state.greatCount++;
    else if (rating === 'good') state.goodCount++;
  }

  // FEVER zone: 1.5x score multiplier on every non-miss tap.
  // Track per-rating fever counts so computeFinalScore can replay the bonus
  // server-side (lock-step). Without separate counters the server can't tell
  // which hits earned the multiplier, so the bonus would get clipped by the
  // hitScore cap and never materialize in the final score.
  if (state.feverActive && rating !== 'miss') {
    if (rating === 'perfect') state.feverPerfectCount++;
    else if (rating === 'great') state.feverGreatCount++;
    else if (rating === 'good') state.feverGoodCount++;
  }
  const baseRatingPts = { perfect: 300, great: 180, good: 90, miss: 0 }[rating];
  const feverMult = (state.feverActive && rating !== 'miss') ? 1.5 : 1;
  const ratingPts = baseRatingPts * feverMult;
  const comboMult = 1 + Math.min(state.combo, 30) * 0.05;
  state.runningScore += Math.round(ratingPts * comboMult);
  els.tapCount.textContent = String(state.runningScore).padStart(6, '0');

  Snd.hit(rating, { streak: state.perfectStreak });

  els.pushBtn.classList.add('pressed');
  clearTimeout(els.pushBtn._rt);
  els.pushBtn._rt = setTimeout(() => els.pushBtn.classList.remove('pressed'), 90);

  spawnRipple();
  showBadge(rating);

  // effect scaling by rating
  const ratingBoost = { perfect: 2.2, great: 1.4, good: 1.0, miss: 0.5 }[rating];
  const partCount = Math.round((4 + TUNING.effectIntensity * 0.6) * ratingBoost);
  const partColor = rating === 'perfect' ? '#FFE600' : (rating === 'great' ? '#FF4DF6' : null);
  spawnParticles(partCount, partColor);

  // combo popup. v=176: PERFECT text fires from 1st perfect tap, "PERFECT × N"
  // callout starts from streak 2 (matches the SE pitch progression that also kicks in early).
  if (rating === 'perfect' && state.perfectStreak >= 2) spawnCombo(`PERFECT × ${state.perfectStreak}`, 'perfect');
  else if (rating === 'perfect') spawnCombo('PERFECT', 'perfect');
  else if (state.combo >= 10 && state.combo % 5 === 0) spawnCombo(`${state.combo} COMBO!`, 'mega');
  else if (rating === 'great')   spawnCombo('+' + Math.floor(gain), '');
  else if (rating === 'good')    spawnCombo('+' + Math.floor(gain), 'small');
  else                           spawnCombo('miss', 'small');

  if (TUNING.flashEnabled) doFlash(rating === 'perfect' ? 0.35 : (rating === 'great' ? 0.2 : 0.1));
  if (TUNING.shakeEnabled) doShake(rating === 'perfect' ? 4 : (rating === 'great' ? 3 : 2));

  parity.pulse = !parity.pulse;
  els.gaugePulse.className = 'gauge-pulse ' + (parity.pulse ? 'pulse-a' : 'pulse-b');

  if (window.gsap) gsap.fromTo(els.pushBtn, { scale: 0.92 }, { scale: 1, duration: 0.3, ease: 'elastic.out(1.2,0.4)', overwrite: 'auto' });

  renderGauge();
  // Gauge hitting 99 arms the mash phase; a short delay lets the final tap's
  // flash/shake settle before 「猛プッシュ」overlay crashes in.
  if (state.gauge >= 99 && !state.mashMode && !state.mashPending && !state.cleared) {
    state.mashPending = true;
    // Freeze rhythm-phase clear time here so the mash duration doesn't eat the time bonus.
    state.rhythmClearSec = (now - state.startAt) / 1000;
    setTimeout(() => {
      state.mashPending = false;
      enterMashMode();
    }, 350);
  }
}

/* ---------- Mash phase (99% → 6秒間連打) ----------
   v=155 redesign: strict +800 per mash tap, with mashScore bypassing the
   efficiencyFactor on the server so heavy mash actually scales the score
   instead of being deflated by the inflated tap denominator.
   mashScore is tracked separately and sent as its own payload field so the
   server can score mash deterministically. Client puts mash taps in goodCount
   (zero accuracyBonus contribution) and the server excludes mash taps from
   the hitScore cap. maxCombo is NOT extended by mash taps — combo bonus stays
   locked to the rhythm-phase peak. */
export function enterMashMode() {
  if (state.mashMode || state.cleared) return;
  exitFever();
  state.mashMode = true;
  state.mashCount = 0;
  state.mashRunningScore = 0;
  state.mashStartAt = performance.now();
  els.mashCount.textContent = '0';
  els.scenes.game.classList.add('mash-mode');
  els.pushBtn.classList.add('mash-pulse');
  els.mashOverlay.classList.remove('show'); void els.mashOverlay.offsetWidth;
  els.mashOverlay.classList.add('show');
  Snd.playSE('se2');
  if (TUNING.flashEnabled) doFlash(0.55);
  if (TUNING.shakeEnabled) doShake(6);

  // Auto-finish after the fixed window. The timer is the sole exit path —
  // doMashTap no longer triggers finish on tap count. Stored on state so
  // startGame can clear it on retry.
  if (state.mashEndTimer) clearTimeout(state.mashEndTimer);
  state.mashEndTimer = setTimeout(() => {
    state.mashEndTimer = null;
    finishMashMode();
  }, state.mashWindowMs);

  // rAF-driven timer bar + countdown text. Stops itself when mashMode flips off.
  if (els.mashTimerFill) els.mashTimerFill.style.transform = 'scaleX(1)';
  if (els.mashTimerNum) els.mashTimerNum.textContent = (state.mashWindowMs / 1000).toFixed(1);
  const tickTimer = () => {
    if (!state.mashMode) return;
    const elapsed = performance.now() - state.mashStartAt;
    const remaining = Math.max(0, state.mashWindowMs - elapsed);
    const t = remaining / state.mashWindowMs;
    if (els.mashTimerFill) els.mashTimerFill.style.transform = 'scaleX(' + t.toFixed(4) + ')';
    if (els.mashTimerNum) els.mashTimerNum.textContent = (remaining / 1000).toFixed(1);
    if (remaining > 0) requestAnimationFrame(tickTimer);
  };
  requestAnimationFrame(tickTimer);
}

export function doMashTap() {
  if (state.cleared || !state.mashMode) return;
  state.mashCount++;
  els.mashCount.textContent = String(state.mashCount);
  parity.mashPop = !parity.mashPop;
  els.mashCount.className = parity.mashPop ? 'pop' : 'pop-b';

  // Gauge stays at 99 during the window (B案). Finish flips it to 100.
  // Running score: +800 per tap (v=155). mashRunningScore is also tracked
  // separately so submitScore can split rhythm vs mash for the server formula.
  state.runningScore = (state.runningScore || 0) + 800;
  state.mashRunningScore = (state.mashRunningScore || 0) + 800;
  els.tapCount.textContent = String(state.runningScore).padStart(6, '0');
  // NOTE: maxCombo intentionally NOT bumped — see header comment.

  // Feedback per tap: particles + ripple + flash + shake (count halved to reduce jank)
  Snd.hit('great');
  const n = Math.round((3 + TUNING.effectIntensity * 0.55));
  spawnParticles(n);
  spawnRipple();
  if (TUNING.flashEnabled) doFlash(0.28);
  if (TUNING.shakeEnabled) doShake(3.5);

  parity.pulse = !parity.pulse;
  els.gaugePulse.className = 'gauge-pulse ' + (parity.pulse ? 'pulse-a' : 'pulse-b');

  els.pushBtn.classList.add('pressed');
  clearTimeout(els.pushBtn._rt);
  els.pushBtn._rt = setTimeout(() => els.pushBtn.classList.remove('pressed'), 80);

  // Milestone combo popups every 10 taps, +800 confetti every 3rd tap.
  if (state.mashCount > 0 && state.mashCount % 10 === 0) {
    spawnCombo(`${state.mashCount} TAPS!!`, 'mega');
  } else if (state.mashCount % 3 === 0) {
    spawnCombo('+800', 'small');
  }
}

export function finishMashMode() {
  if (!state.mashMode) return;
  state.mashMode = false;
  if (state.mashEndTimer) { clearTimeout(state.mashEndTimer); state.mashEndTimer = null; }
  // handleTap のstate.runningチェックで、triggerClear待ち300ms中のオーバーシュートを遮断
  state.running = false;
  els.pushBtn.classList.remove('mash-pulse');
  els.mashOverlay.classList.remove('show');
  els.scenes.game.classList.remove('mash-mode');
  state.gauge = 100;
  renderGauge();
  spawnCombo('BREAKTHROUGH!!', 'perfect');
  if (TUNING.flashEnabled) doFlash(0.7);
  if (TUNING.shakeEnabled) doShake(7);
  setTimeout(triggerClear, 300);
}
