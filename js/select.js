/* ============================================================
   select.js — Song selection screen logic (Y2K design).
   Flow: Title → GAME START → showSelectScreen() → PLAY → startGame(idx)
   ============================================================ */

import { BEST_RANK_KEY } from './config.js';
import { els, showScene } from './dom.js';
import { Snd } from './sound.js';
import { startGame } from './gameloop.js';

const RANK_ORDER = ['D', 'C', 'B', 'A', 'S', 'SS'];

// -1 means RANDOM selected
let selectedIdx = -1;

function bestRank(idx) {
  try { return localStorage.getItem(BEST_RANK_KEY + idx) || null; } catch(e) { return null; }
}

function buildCards(tracks) {
  els.selList.innerHTML = '';

  // ── RANDOM card (top) ──
  const randomCard = document.createElement('div');
  randomCard.className = 'sel-card sel-card-random';
  randomCard.dataset.idx = '-1';
  randomCard.innerHTML =
    `<div class="sel-card-body">` +
      `<div class="sel-random-label">RANDOM</div>` +
      `<div class="sel-random-sub">ランダムで曲を選ぶ</div>` +
    `</div>` +
    `<div class="sel-rank-section">` +
      `<div class="sel-card-rank sel-random-note">♪</div>` +
    `</div>`;
  const onTapRandom = (e) => { e.preventDefault(); selectTrack(-1); };
  randomCard.addEventListener('touchstart', onTapRandom, { passive: false });
  randomCard.addEventListener('click', onTapRandom);
  els.selList.appendChild(randomCard);

  // ── Track cards ──
  tracks.forEach((track, i) => {
    const rank    = bestRank(i);
    const hasRank = rank && RANK_ORDER.includes(rank);
    const card    = document.createElement('div');
    card.className   = 'sel-card';
    card.dataset.idx = i;
    card.innerHTML =
      `<div class="sel-card-body">` +
        `<div class="sel-card-title">${track.title}</div>` +
      `</div>` +
      `<div class="sel-rank-section">` +
          `<div class="sel-card-rank${hasRank ? ' rank-' + rank.toLowerCase() : ' no-rank'}">${hasRank ? rank : ''}</div>` +
          `<div class="sel-rank-label">RANK</div>` +
      `</div>`;
    const onTap = (e) => { e.preventDefault(); selectTrack(i); };
    card.addEventListener('touchstart', onTap, { passive: false });
    card.addEventListener('click', onTap);
    els.selList.appendChild(card);
  });
}

function selectTrack(idx) {
  selectedIdx = idx;
  refreshSelection();
  if (idx === -1) {
    // RANDOM: stop preview (if any), resume title BGM
    Snd.previewStop();
    Snd.titleBgmStart();
  } else {
    // Track selected: stop title BGM, start preview
    Snd.bgmStop();
    Snd.previewStart(idx);
  }
}

function refreshSelection() {
  document.querySelectorAll('.sel-card').forEach((c) => {
    const ci = parseInt(c.dataset.idx, 10);
    c.classList.toggle('selected', ci === selectedIdx);
  });
}

export function showSelectScreen() {
  const tracks = Snd.getTrackList();
  buildCards(tracks);
  selectedIdx = -1; // Start with RANDOM selected
  refreshSelection();
  // Title BGM keeps playing — no audio change on entering select screen
  showScene('select');
}

export function hideSelectScreen() {
  Snd.previewStop();
}

export function initSelectScreen() {
  const on = (id, ev, fn, opts) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn, opts);
  };

  const doPlay = () => {
    hideSelectScreen();
    const trackIdx = selectedIdx === -1
      ? Math.floor(Math.random() * Snd.getTrackList().length)
      : selectedIdx;
    startGame(trackIdx);
  };

  on('sel-play-btn', 'touchstart', (e) => { e.preventDefault(); doPlay(); }, { passive: false });
  on('sel-play-btn', 'click', doPlay);

  const doBack = () => {
    const hadPreview = selectedIdx >= 0;
    hideSelectScreen();
    showScene('title');
    if (hadPreview) Snd.titleBgmStart();
  };
  on('sel-back-btn', 'touchstart', (e) => { e.preventDefault(); doBack(); }, { passive: false });
  on('sel-back-btn', 'click', doBack);
}
