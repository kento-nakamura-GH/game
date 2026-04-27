/* ============================================================
   dom.js — element references, scene switcher, layout caches.
   els is exported as a single mutable object so other modules
   can hold the reference; setupDom() fills it once DOM is ready.
   ============================================================ */

export const $ = (s) => document.querySelector(s);

/* Single shared object — modules import this reference and read keys.
   Filled by setupDom() during init(). */
export const els = {};

export function setupDom() {
  els.scenes = {
    title:  $('#scene-title'),
    select: $('#scene-select'),
    game:   $('#scene-game'),
    clear:  $('#scene-clear'),
    video:  $('#scene-video'),
    cta:    $('#scene-cta'),
  };
  els.selList = $('#sel-list');
  Object.assign(els, {
    startBtn: $('#start-btn'),
    pushBtn: $('#push-btn'),
    retryBtn: $('#retry-btn'),
    yesBtn: $('#yes-btn'),
    noBtn: $('#no-btn'),
    soundBtn: $('#sound-btn'),
    gaugeFill: $('#gauge-fill'),
    gaugeFillStripes: $('#gauge-fill-stripes'),
    gaugeNum: $('#gauge-num'),
    gaugePulse: $('#gauge-pulse'),
    timer: $('#timer-label'),
    tapCount: $('#tap-count'),
    char: $('#character'),
    charB: $('#character-b'),
    comboLayer: $('#combo-layer'),
    particles: $('#particles'),
    flash: $('#flash'),
    phone: $('.phone'),
    screen: $('.screen'),
    confetti: $('#confetti-canvas'),
    rhythmIndicator: $('#rhythm-indicator'),
    rhythmTicks: $('#rhythm-ticks'),
    beatBadge: $('#beat-badge'),
    splashVideo: $('#splash-video'),
    clearWindow: $('#clear-window'),
    clearText: $('#clear-text'),
    typed: $('#typed'),
    clearActions: $('#clear-actions'),
    tweaksPanel: $('#tweaks-panel'),
    countdownOverlay: $('#countdown-overlay'),
    countdownNum: $('#countdown-num'),
    finishOverlay: $('#finish-overlay'),
    feverOverlay: $('#fever-overlay'),
    nowPlaying: $('#now-playing'),
    sbRowScore: $('#sb-row-score'),
    sbRowCombo: $('#sb-row-combo'),
    sbRowTiming: $('#sb-row-timing'),
    sbRowTime: $('#sb-row-time'),
    sbRowTotal: $('#sb-row-total'),
    sbDivider: $('#sb-divider'),
    sbScore: $('#sb-score'),
    sbCombo: $('#sb-combo'),
    sbTimingBonus: $('#sb-timing-bonus'),
    sbTimeBonus: $('#sb-time-bonus'),
    sbTotal: $('#sb-total'),
    ctaRankBadge: $('#cta-rank-badge'),
    shareX: $('#share-x'),
    shareLine: $('#share-line'),
    shareThreads: $('#share-threads'),
    songPicker: $('#song-picker'),
    songPickerList: $('#song-picker-list'),
    songPickerVersion: $('#song-picker-version'),
    songPickerClose: $('#song-picker-close'),
    bgPickerList: $('#bg-picker-list'),
    roomBgImg: $('.room-bg-img'),
    shareCopy: $('#share-copy'),
    shareToast: $('#cta-share-toast'),
    mashOverlay: $('#mash-overlay'),
    mashCount: $('#mash-count'),
    mashTimerFill: $('#mash-timer-fill'),
    mashTimerNum: $('#mash-timer-num'),
    ctaScoreboardWrap: $('#cta-scoreboard-wrap'),
    ctaRanking: $('#cta-ranking'),
    ctaSlideDots: $('#cta-slide-dots'),
    rkList: $('#rk-list'),
    rkYou: $('#rk-you'),
    rkNewBadge: $('#rk-newbadge'),
    rkStatus: $('#rk-status'),
    nameModal: $('#rank-name-modal'),
    nameInput: $('#rank-name-input'),
    nameSubmit: $('#rank-name-submit'),
    nameSkip: $('#rank-name-skip'),
    nameError: $('#rank-name-error'),
  });
}

/* ---------- BoundingRect cache (avoid forced layout on every tap) ---------- */
export const rect = { btn: null, particles: null, combo: null };

export function updateRectCache() {
  if (!els.pushBtn || !els.particles || !els.comboLayer) return;
  rect.btn       = els.pushBtn.getBoundingClientRect();
  rect.particles = els.particles.getBoundingClientRect();
  rect.combo     = els.comboLayer.getBoundingClientRect();
}

/* Parity toggles — restart CSS animations without void offsetWidth (no forced reflow) */
export const parity = { pulse: false, badge: false, mashPop: false };

export function showScene(name) {
  Object.values(els.scenes).forEach(s => s.classList.remove('active'));
  els.scenes[name].classList.add('active');
  if (els.soundBtn) els.soundBtn.classList.toggle('hide-on-cta', name === 'cta');
}

export function updateSoundBtn(muted) {
  const b = els.soundBtn; if (!b) return;
  b.classList.toggle('muted', muted);
  b.setAttribute('aria-label', muted ? '音声オン' : '音声オフ');
}

window.addEventListener('resize',            updateRectCache, { passive: true });
window.addEventListener('orientationchange', updateRectCache, { passive: true });
