/* ============================================================
   ranking.js — Cloudflare Workers ranking integration:
   submitScore, render top5/YOU panel, name input modal,
   scoreboard⇄ranking swipe carousel.
   ============================================================ */

import { GAME_VERSION, RANKING_API, TUNING } from './config.js';
import { state } from './state.js';
import { els } from './dom.js';

/* ---- Turnstile helper (F-7: 後付けでも対応できる枠) ----
   現状は Turnstile widget 未組込み。将来 index.html に widget タグを追加すれば
   自動的に token が拾われて送信される構造。 */
function getTurnstileToken() {
  return window.turnstile?.getResponse?.() || null;
}

/* Fire-and-forget POST in triggerClear so the network round-trip overlaps
   with the clear/video/CTA animation (~6-8s) and the result is ready by
   the time the CTA panel needs it. */
export async function submitScore() {
  // v=153 mash payload: mashTaps go into goodCount (zero accuracyBonus
  // contribution), and hitScore is split into rhythm-only — mashScore is sent
  // separately so the server's strict +400/tap formula can apply.
  // counts_do_not_sum still passes because perfect+great+good+miss = taps.
  const mashTaps = state.mashCount | 0;
  const tapsTotal = state.taps | 0; // includes mashTaps (handleTap ++ for every tap)
  const HIT_SCORE_PER_TAP_CAP = 300; // must match SANITY.hitScorePerTap in game-api/src/index.js
  // Strip mash-phase score from hitScore so the server can score mash via mashScore
  // without double-counting. The server caps hitScore at hitScorePerTap * (taps - mashTaps).
  const mashScore = state.mashRunningScore | 0;
  const rhythmRunningScore = Math.max(0, (state.runningScore | 0) - mashScore);
  const rhythmTaps = Math.max(0, tapsTotal - mashTaps);
  const hitScore = Math.min(rhythmRunningScore, HIT_SCORE_PER_TAP_CAP * rhythmTaps);
  // beatIntervalMs lets the server compute beat-normalized timeBonus (kills the
  // tempo bias where faster BGM tracks earned bigger time bonuses). Fall back
  // to the TUNING default if state somehow never picked it up.
  const beatIntervalMs = Number(state.lastBeatInterval || TUNING.beatIntervalMs || 458);
  // v=152 mash payload: fixed-window mode. mashWindowSec presence flips the
  // server into tap-count scoring (mashTaps * 150). mashTimeSec is still sent
  // for backward compatibility but the new server path ignores it.
  const rhythmSec = Number(state.rhythmClearSec || 0);
  const totalSec = Number(state.clearTime || rhythmSec);
  const mashTimeSec = Math.max(0, totalSec - rhythmSec);
  const mashWindowSec = (state.mashWindowMs || 5000) / 1000;
  const payload = {
    version: GAME_VERSION,
    trackId: (state.currentTrackId != null && state.currentTrackId >= 0) ? state.currentTrackId : null,
    stats: {
      taps: tapsTotal,
      clearTime: Number(state.rhythmClearSec || state.clearTime || 0),
      maxCombo: state.maxCombo | 0,
      perfectCount: state.perfectCount | 0,
      greatCount: state.greatCount | 0,
      goodCount: (state.goodCount | 0) + mashTaps,  // v=153: mash taps → goodCount
      missCount: state.missCount | 0,
      hitScore,
      decayTotal: Number(state.decayTotal || 0),
      beatIntervalMs,
      mashTimeSec,
      mashWindowSec,
      mashTaps,
      mashScore,
      mashScoreVersion: 2,
      feverPerfectCount: state.feverPerfectCount | 0,
      feverGreatCount: state.feverGreatCount | 0,
      feverGoodCount: state.feverGoodCount | 0,
    },
  };
  // F-7: Turnstile token（現状は未組込み。widget 追加時に自動送信される構造）
  const turnstileToken = getTurnstileToken();
  if (turnstileToken) payload.turnstileToken = turnstileToken;

  try {
    const res = await fetch(RANKING_API + '/api/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' }, // F-6: Content-Type 明示（元々OK、確認済）
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let errBody = null;
      try { errBody = await res.json(); } catch { /* ignore */ }
      console.warn('[ranking] submit rejected', res.status, errBody);

      // F-3: レート制限エラー処理
      if (res.status === 429) {
        const retryAfter = Number(
          res.headers.get('Retry-After') || errBody?.retryAfter || 60
        );
        handleRateLimit(retryAfter);
        return null;
      }

      // F-4: invalid_submission の reason 別エラー表示
      if (res.status === 400 && errBody?.error === 'invalid_submission') {
        const reason = errBody?.reason || '';
        const msg = getInvalidSubmissionMessage(reason);
        showSubmitError(msg);
        return null;
      }

      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn('[ranking] submit failed', e);
    return null;
  }
}

/* ---- F-4: invalid_submission reason 別メッセージ ---- */
function getInvalidSubmissionMessage(reason) {
  switch (reason) {
    case 'tap_density_too_low':       return 'タップ少なすぎ。もうちょい本気でやってな';
    case 'mash_taps_exceed_human_rate': return 'マッシュ早すぎや。スコア無効になったで';
    case 'mash_time_exceeds_window':  return 'マッシュ時間がおかしい。リトライしてや';
    case 'fever_total_exceeds_taps':  return 'フィーバー記録に矛盾があったで。リトライ推奨';
    case 'track_id_out_of_range':     return '曲ID不正。リロードしてみ';
    default:                          return 'スコア検証エラー。リロードしてリトライしてな';
  }
}

/* ---- F-3: レート制限 UI ---- */
let rateLimitTimer = null;
function handleRateLimit(retryAfterSec) {
  // 送信ボタン無効化
  if (els.nameSubmit) els.nameSubmit.disabled = true;

  const updateCountdown = (remaining) => {
    const msg = `ちょっと連投しすぎや。あと ${remaining}秒待って`;
    if (els.nameError) els.nameError.textContent = msg;
    if (els.rkStatus) els.rkStatus.textContent = msg;
  };

  let remaining = Math.max(1, Math.ceil(retryAfterSec));
  updateCountdown(remaining);

  if (rateLimitTimer) clearInterval(rateLimitTimer);
  rateLimitTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(rateLimitTimer);
      rateLimitTimer = null;
      if (els.nameSubmit) els.nameSubmit.disabled = false;
      if (els.nameError) els.nameError.textContent = '';
      if (els.rkStatus) els.rkStatus.textContent = '';
    } else {
      updateCountdown(remaining);
    }
  }, 1000);
}

/* ---- エラー表示ヘルパー ---- */
function showSubmitError(msg) {
  if (els.rkStatus) els.rkStatus.textContent = msg;
  console.warn('[ranking] submit error:', msg);
}

export function formatName(name) {
  if (name == null || name === '') return '---';
  return String(name);
}

export function renderRankingPanel(r) {
  if (!els.ctaRanking) return;
  if (!r || !Array.isArray(r.top)) {
    if (els.rkStatus) els.rkStatus.textContent = 'ランキングに接続できません';
    els.ctaRanking.classList.add('show');
    els.ctaRanking.setAttribute('aria-hidden', 'false');
    return;
  }

  // Build top rows — F-1: innerHTML 廃止。entry.name はユーザー入力なので
  // textContent で必ず自動エスケープする（XSS 防御の二重化）。
  els.rkList.innerHTML = '';
  r.top.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'rk-row' + (entry.you ? ' rk-you-row' : '');

    const posSpan = document.createElement('span');
    posSpan.className = 'rk-pos';
    posSpan.textContent = String(i + 1);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'rk-name';
    nameSpan.textContent = formatName(entry.name); // safe: textContent auto-escapes

    const scoreSpan = document.createElement('span');
    scoreSpan.className = 'rk-score';
    scoreSpan.textContent = Number(entry.score || 0).toLocaleString('en-US');

    row.appendChild(posSpan);
    row.appendChild(nameSpan);
    row.appendChild(scoreSpan);
    els.rkList.appendChild(row);
  });

  // YOU row at bottom (only if not already in top5)
  // F-1: こちらも textContent 化（将来 you.name が入っても安全）
  const youInTop = r.top.some(e => e.you);
  if (!youInTop && r.you) {
    els.rkYou.innerHTML = ''; // 先に空にしてから要素追加
    const posSpan = document.createElement('span');
    posSpan.className = 'rk-pos';
    posSpan.textContent = String(r.you.position || '-');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'rk-name';
    nameSpan.textContent = 'YOU';

    const scoreSpan = document.createElement('span');
    scoreSpan.className = 'rk-score';
    scoreSpan.textContent = Number(r.you.score || 0).toLocaleString('en-US');

    els.rkYou.appendChild(posSpan);
    els.rkYou.appendChild(nameSpan);
    els.rkYou.appendChild(scoreSpan);
    els.rkYou.classList.add('show');
  } else {
    els.rkYou.innerHTML = '';
    els.rkYou.classList.remove('show');
  }

  // NEW badge only when in top5
  if (els.rkNewBadge) els.rkNewBadge.classList.toggle('show', !!r.isTop5);
  if (els.rkStatus) els.rkStatus.textContent = '';

  els.ctaRanking.classList.add('show');
  els.ctaRanking.setAttribute('aria-hidden', 'false');

  // Once ranking is shown and name input isn't pending, allow the user to
  // swipe back to the scoreboard. Wait for the slide-in transition (0.6s) to
  // finish before showing the bounce hint.
  if (!r.needsName) {
    setTimeout(() => enableCtaSwipe(), 700);
  }
}

export function hideRankingPanel() {
  if (!els.ctaRanking) return;
  els.ctaRanking.classList.remove('show');
  els.ctaRanking.setAttribute('aria-hidden', 'true');
}

/* ---- CTA scoreboard ⇄ ranking carousel ---- */
const CTA_SLIDE_RANKING = 'ranking';
const CTA_SLIDE_SCOREBOARD = 'scoreboard';

function updateCtaDots(slide) {
  if (!els.ctaSlideDots) return;
  els.ctaSlideDots.querySelectorAll('.cta-dot').forEach(dot => {
    dot.classList.toggle('is-active', dot.dataset.slide === slide);
  });
}

function setCtaSlide(slide) {
  const wrap = els.ctaScoreboardWrap;
  if (!wrap || !wrap.classList.contains('swipeable')) return;
  if (slide !== CTA_SLIDE_RANKING && slide !== CTA_SLIDE_SCOREBOARD) return;
  wrap.dataset.slide = slide;
  updateCtaDots(slide);
}

let ctaSwipeBound = false;
export function enableCtaSwipe() {
  const wrap = els.ctaScoreboardWrap;
  if (!wrap) return;
  if (wrap.classList.contains('swipeable')) return; // idempotent
  wrap.classList.add('swipeable');
  wrap.dataset.slide = CTA_SLIDE_RANKING;
  if (els.ctaSlideDots) {
    els.ctaSlideDots.classList.add('show');
    els.ctaSlideDots.setAttribute('aria-hidden', 'false');
  }
  updateCtaDots(CTA_SLIDE_RANKING);

  // First-time hint: let scoreboard peek from the left, then retract.
  setTimeout(() => {
    wrap.classList.add('bounce-hint');
    setTimeout(() => wrap.classList.remove('bounce-hint'), 980);
  }, 350);

  if (ctaSwipeBound) return; // bind pointer handlers only once
  ctaSwipeBound = true;

  let startX = 0, startY = 0, dragging = false, pointerActive = false;
  const THRESHOLD = 40;

  const onStart = (ev) => {
    const t = ev.touches ? ev.touches[0] : ev;
    startX = t.clientX; startY = t.clientY;
    dragging = false; pointerActive = true;
  };
  const onMove = (ev) => {
    if (!pointerActive) return;
    const t = ev.touches ? ev.touches[0] : ev;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (!dragging && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      dragging = true;
    }
    if (dragging && ev.cancelable) ev.preventDefault();
  };
  const onEnd = (ev) => {
    if (!pointerActive) return;
    pointerActive = false;
    if (!dragging) return;
    const t = ev.changedTouches ? ev.changedTouches[0] : ev;
    const dx = (t.clientX || 0) - startX;
    const current = wrap.dataset.slide;
    // scoreboard is parked off-screen to the LEFT (translateX(-110%)) when ranking
    // is active, and ranking is parked off-screen to the RIGHT when scoreboard is
    // active. So swiping RIGHT on ranking pulls scoreboard in from the left,
    // and swiping LEFT on scoreboard pulls ranking in from the right.
    if (dx > THRESHOLD && current === CTA_SLIDE_RANKING) setCtaSlide(CTA_SLIDE_SCOREBOARD);
    else if (dx < -THRESHOLD && current === CTA_SLIDE_SCOREBOARD) setCtaSlide(CTA_SLIDE_RANKING);
    dragging = false;
  };
  const onCancel = () => { pointerActive = false; dragging = false; };

  wrap.addEventListener('touchstart', onStart, { passive: true });
  wrap.addEventListener('touchmove', onMove, { passive: false });
  wrap.addEventListener('touchend', onEnd);
  wrap.addEventListener('touchcancel', onCancel);
  wrap.addEventListener('mousedown', onStart);
  wrap.addEventListener('mousemove', onMove);
  wrap.addEventListener('mouseup', onEnd);
  wrap.addEventListener('mouseleave', onCancel);

  if (els.ctaSlideDots) {
    els.ctaSlideDots.querySelectorAll('.cta-dot').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.preventDefault();
        setCtaSlide(dot.dataset.slide);
      });
    });
  }
}

export function disableCtaSwipe() {
  const wrap = els.ctaScoreboardWrap;
  if (wrap) {
    wrap.classList.remove('swipeable', 'bounce-hint');
    delete wrap.dataset.slide;
  }
  if (els.ctaSlideDots) {
    els.ctaSlideDots.classList.remove('show');
    els.ctaSlideDots.setAttribute('aria-hidden', 'true');
  }
}

/* ---- Name input modal ---- */
export function showNameInput(submissionId) {
  if (!els.nameModal) return;
  state.pendingNameSubmission = submissionId;
  if (els.nameInput) els.nameInput.value = '';
  if (els.nameError) els.nameError.textContent = '';
  if (els.nameSubmit) els.nameSubmit.disabled = false;
  els.nameModal.classList.add('show');
  els.nameModal.setAttribute('aria-hidden', 'false');
  // Focus the input on open (iOS may still not open the keyboard without a
  // direct gesture, but at least we try)
  setTimeout(() => { try { els.nameInput && els.nameInput.focus(); } catch (e) {} }, 120);
}

export function hideNameInput() {
  if (!els.nameModal) return;
  els.nameModal.classList.remove('show');
  els.nameModal.setAttribute('aria-hidden', 'true');
}

export async function submitName() {
  const id = state.pendingNameSubmission;
  if (!id) { hideNameInput(); return; }
  const raw = (els.nameInput && els.nameInput.value) || '';
  // Codepoint-based slice so surrogate pairs (emoji) count as 1 char,
  // matching the server's Array.from(name).length validation.
  const clipped = Array.from(raw).slice(0, 5).join('');
  const name = clipped.trim();
  if (!name) {
    if (els.nameError) els.nameError.textContent = '名前を入れてな';
    return;
  }
  if (els.nameSubmit) els.nameSubmit.disabled = true;
  try {
    const res = await fetch(RANKING_API + '/api/score/' + encodeURIComponent(id) + '/name', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      let errBody = null;
      try { errBody = await res.json(); } catch { /* ignore */ }

      let msg = 'エラーが発生しました';
      if (res.status === 409) {
        msg = '既に登録済みやで';
      } else if (res.status === 410) {
        msg = '他のプレイヤーに先越されたわ...';
      } else if (res.status === 429) {
        // F-3: name PUT でもレート制限
        const retryAfter = Number(
          res.headers.get('Retry-After') || errBody?.retryAfter || 60
        );
        handleRateLimit(retryAfter);
        return;
      } else if (res.status === 400 && errBody?.error === 'invalid_name') {
        // F-5: invalid_name 強化メッセージ
        msg = '使えへん文字あるかも。英数字＋ひらがな＋カタカナで5文字以内にしてな';
      } else if (res.status === 400) {
        msg = '名前に使えへん文字が入ってるで';
      }
      if (els.nameError) els.nameError.textContent = msg;
      if (els.nameSubmit) els.nameSubmit.disabled = false;
      return;
    }
    const data = await res.json();
    // Merge into current ranking result + re-render
    if (state.rankingResult) {
      state.rankingResult.top = data.top || state.rankingResult.top;
      state.rankingResult.you = data.you || state.rankingResult.you;
      state.rankingResult.needsName = false; // ensures renderRankingPanel enables swipe
    }
    state.pendingNameSubmission = null;
    hideNameInput();
    renderRankingPanel(state.rankingResult);
  } catch (e) {
    console.warn('[ranking] name submit failed', e);
    if (els.nameError) els.nameError.textContent = 'ネットワークエラー';
    if (els.nameSubmit) els.nameSubmit.disabled = false;
  }
}
