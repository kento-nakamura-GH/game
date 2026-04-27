/* ============================================================
   main.js — Entry point. Wires DOM listeners, kicks off the title
   sequence. Loaded as <script type="module"> from index.html.
   ============================================================ */

import { STAGE_GIFS } from './config.js';
import { state } from './state.js';
import {
  els, setupDom, showScene, updateSoundBtn,
} from './dom.js';
import { Snd } from './sound.js';
import { buildTicks } from './rhythm.js';
import { handleTap } from './tap.js';
import { showSelectScreen, initSelectScreen } from './select.js';
import {
  onYes, onNo,
} from './score.js';
import {
  hideRankingPanel, hideNameInput, disableCtaSwipe, enableCtaSwipe,
  submitName,
} from './ranking.js';
import {
  animateTitle, typeTagline,
  shareOnX, shareOnLine, shareOnThreads, shareCopy,
  openSongPicker, closeSongPicker, handleTitleTap,
  applyTweaks, setupTweaks,
} from './ui-extras.js';

/* ---------- Wire up DOM event handlers ---------- */
function bind() {
  // Title BGM is swapped to game BGM inside startGame (Snd reuses a single Audio
  // element now, so the swap is fast and reliable). SE3 masks the brief cut.
  const startFn = (e) => { e && e.preventDefault && e.preventDefault(); Snd.resume(); Snd.playSE('se3', 0.21); showSelectScreen(); };
  const on = (el, ev, fn, opts) => { if (el) el.addEventListener(ev, fn, opts); };
  on(els.startBtn, 'click', startFn);
  on(els.startBtn, 'touchstart', startFn, { passive: false });

  on(els.pushBtn, 'touchstart', handleTap, { passive: false });
  on(els.pushBtn, 'mousedown', handleTap);
  on(els.pushBtn, 'contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => { if (e.code === 'Space' && state.running) { e.preventDefault(); handleTap(e); } });

  // Whole-screen tap → PUSH (skip interactive UI like sound toggle / push-btn itself).
  // push-btn excluded so its own handler stays the source of truth (avoids double-fire).
  const sceneTap = (ev) => {
    if (!state.running) return;
    if (ev.target && ev.target.closest && ev.target.closest('.sound-toggle, .push-btn, .now-playing, .gauge-container')) return;
    handleTap(ev);
  };
  on(els.scenes.game, 'touchstart', sceneTap, { passive: false });
  on(els.scenes.game, 'mousedown', sceneTap);

  on(els.yesBtn, 'click', onYes);
  on(els.noBtn, 'click', onNo);
  on(els.shareX, 'click', shareOnX);
  on(els.shareLine, 'click', shareOnLine);
  on(els.shareThreads, 'click', shareOnThreads);
  on(els.shareCopy, 'click', shareCopy);
  on(els.retryBtn, 'click', () => {
    state.cleared = false;
    state.running = false;
    state.rankingResult = null;
    state.rankingPromise = null;
    state.pendingNameSubmission = null;
    hideRankingPanel();
    hideNameInput();
    disableCtaSwipe();
    Snd.titleBgmStart();
    showScene('title');
    animateTitle();
    typeTagline();
  });

  // Ranking name input modal
  on(els.nameSubmit, 'click', (e) => { e.preventDefault(); submitName(); });
  on(els.nameSkip, 'click', (e) => {
    e.preventDefault();
    state.pendingNameSubmission = null;
    if (state.rankingResult) state.rankingResult.needsName = false;
    hideNameInput();
    // User opted out of name entry — let them swipe between panels anyway.
    setTimeout(() => enableCtaSwipe(), 250);
  });
  on(els.nameInput, 'keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitName(); }
  });

  on(els.soundBtn, 'click', (e) => {
    e && e.preventDefault && e.preventDefault();
    Snd.resume();
    Snd.toggle();
    updateSoundBtn(Snd.isMuted());
    if (els.scenes.title.classList.contains('active')) Snd.titleBgmStart();
    else Snd.retryBgm();
  });

  // Title BGM bootstrap. Skips when the gesture is on GAME START — startFn
  // already handles BGM via gameBgmStart there, and stomping with titleBgmStart
  // would destroy the freshly-created game Audio (mobile pointerdown fires
  // AFTER touchstart; capture-phase pointerdown would override the game BGM
  // initiated in touchstart).
  let firstGestureFired = false;
  const firstGesture = (ev) => {
    if (firstGestureFired) return;
    firstGestureFired = true;
    // iOS Safari: unlock AudioContext synchronously inside gesture handler.
    if (Snd.unlockAudio) Snd.unlockAudio();
    // Preload all BGM+SE buffers so transitions are instant.
    if (Snd.bgmPreload) Snd.bgmPreload();
    if (Snd.seLoad) Snd.seLoad();
    // Don't start title BGM if tap was on GAME START — select screen handles audio from here.
    const isStartBtn = ev && ev.target && ev.target.closest && ev.target.closest('.start-btn');
    if (!isStartBtn && els.scenes.title.classList.contains('active')) Snd.titleBgmStart();
    else if (!isStartBtn) Snd.retryBgm();
  };
  document.addEventListener('pointerdown', firstGesture, { capture: true });
  document.addEventListener('keydown', firstGesture, { capture: true });

  // iOS: audio context often suspends when page goes to background (tab switch,
  // phone call, silent switch). When visibility returns, resume + restart BGM
  // so users don't come back to a silent game.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Snd.ensurePlaying) Snd.ensurePlaying();
  });

  initSelectScreen();

  // Debug: 5連タップで曲選択
  on(els.scenes.title, 'pointerdown', handleTitleTap);
  on(els.songPickerClose, 'click', (e) => { e.preventDefault(); closeSongPicker(); });
  // 背景タップで閉じない（CLOSEボタンのみで閉じる）
  on(els.songPicker, 'pointerdown', (e) => { e.stopPropagation(); });
  on(els.songPicker, 'click', (e) => { e.stopPropagation(); });
}

/* ---------- Init ---------- */
function init() {
  // Set audioSession type to 'playback' FIRST — overrides the physical silent
  // switch on iPhone (SE/8/etc. still have it; 16 Pro replaced it with Action
  // Button). Without this, Web Audio is entirely silent when the ring switch
  // is on Mute, regardless of how perfectly we unlock AudioContext. iOS 17+,
  // no-op elsewhere.
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (e) {}
  setupDom();
  // preload all stage GIFs
  Object.values(STAGE_GIFS).forEach(g => { new Image().src = g.src; });
  // Pre-gesture audio init: some iOS builds stabilize with ctx created early
  // (still suspended until firstGesture unlocks it). If deferred init breaks
  // SE on iOS, this is the workaround that preserved v=100 behavior.
  Snd.seLoad();
  buildTicks();
  applyTweaks();
  bind();
  setupTweaks();
  updateSoundBtn(Snd.isMuted());
  animateTitle();
  typeTagline();
  showScene('title');
  Snd.titleBgmStart();
}

init();
