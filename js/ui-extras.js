/* ============================================================
   ui-extras.js — Title pop animation, tagline typewriter,
   share buttons, debug song picker, dev tweaks panel.
   Things that aren't core gameplay but live alongside it.
   ============================================================ */

import {
  GAME_VERSION,
  SHARE_HASHTAGS, SHARE_URL,
  SONG_PICKER_TAP_WINDOW, SONG_PICKER_REQUIRED,
  BG_VARIANTS, BG_PICKER_KEY,
  TUNING,
} from './config.js';
import { state } from './state.js';
import { els } from './dom.js';
import { Snd } from './sound.js';
import { computeRank } from './score.js';

/* ---------- Title PON! (rAF-driven pop with overshoot + bounce-back) ---------- */
export function animateTitle() {
  const targets = [
    { el: document.querySelector('#tw-1'),        delay: 60,  dur: 450, peak: 1.35, fromRot: -10, peakRot:  4, toRot: 0 },
    { el: document.querySelector('#tw-2'),        delay: 180, dur: 450, peak: 1.35, fromRot:  10, peakRot: -4, toRot: 0 },
    { el: document.querySelector('#title-kyomu'), delay: 320, dur: 480, peak: 1.45, fromRot:  -6, peakRot:  3, toRot: 0 },
  ].filter(t => t.el);

  // Final visible state applied IMMEDIATELY so tab-backgrounded rAF doesn't hide content
  targets.forEach(t => {
    t.el.style.opacity = '1';
    t.el.style.transform = `scale(1) rotate(${t.toRot}deg)`;
    t.el.style.willChange = 'transform, opacity';
  });

  // Pop curve: 0 → peak (explosive ease-out) → bounce (0.88 * peak) → settle (1.0)
  const popScale = (p, peak) => {
    if (p < 0.32) {
      const t = p / 0.32;
      return peak * (1 - Math.pow(1 - t, 4));
    } else if (p < 0.62) {
      const t = (p - 0.32) / 0.30;
      return peak + (0.88 - peak) * (1 - Math.pow(1 - t, 2));
    } else {
      const t = (p - 0.62) / 0.38;
      return 0.88 + (1 - 0.88) * (1 - Math.pow(1 - t, 2));
    }
  };
  const popRot = (p, from, peakR, to) => {
    if (p < 0.32) {
      const t = p / 0.32;
      return from + (peakR - from) * (1 - Math.pow(1 - t, 4));
    } else {
      const t = (p - 0.32) / 0.68;
      return peakR + (to - peakR) * (1 - Math.pow(1 - t, 2));
    }
  };

  const start = performance.now();
  // Pre-state: invisible + collapsed
  targets.forEach(t => {
    t.el.style.opacity = '0';
    t.el.style.transform = `scale(0) rotate(${t.fromRot}deg)`;
  });

  let lastTick = start;
  function tick(now) {
    lastTick = now;
    const t = now - start;
    let anyRunning = false;
    targets.forEach(tg => {
      const local = t - tg.delay;
      if (local < 0) { anyRunning = true; return; }
      if (local >= tg.dur) {
        tg.el.style.opacity = '1';
        tg.el.style.transform = `scale(1) rotate(${tg.toRot}deg)`;
        return;
      }
      anyRunning = true;
      const p = local / tg.dur;
      const sc = popScale(p, tg.peak);
      const rot = popRot(p, tg.fromRot, tg.peakRot, tg.toRot);
      tg.el.style.opacity = Math.min(1, p * 5).toFixed(3);
      tg.el.style.transform = `scale(${sc.toFixed(3)}) rotate(${rot.toFixed(2)}deg)`;
    });
    if (anyRunning) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Safety net: if rAF never fires (backgrounded tab), ensure visible after 1.5s via setTimeout
  setTimeout(() => {
    if (performance.now() - lastTick > 1000) {
      targets.forEach(t => {
        t.el.style.opacity = '1';
        t.el.style.transform = `scale(1) rotate(${t.toRot}deg)`;
      });
    }
  }, 1500);
}

/* ---------- Title tagline typewriter ---------- */
let taglineTypeTimer = null;
export function typeTagline() {
  const tgt = document.getElementById('tagline-typed');
  if (!tgt) return;
  if (taglineTypeTimer) { clearTimeout(taglineTypeTimer); taglineTypeTimer = null; }
  tgt.textContent = '';
  const text = 'テンポよくタップして、\nきょむうさをノリノリにしよう！';
  let i = 0;
  taglineTypeTimer = setTimeout(function next() {
    if (i >= text.length) { taglineTypeTimer = null; return; }
    tgt.textContent += text[i];
    i++;
    const d = text[i-1] === '\n' ? 180 : (55 + Math.random() * 25);
    taglineTypeTimer = setTimeout(next, d);
  }, 1150);
}

/* ---------- SNS share ---------- */
export function buildShareText() {
  const score = (state.finalScore || 0).toLocaleString('en-US');
  const rank = state.rank || computeRank(state.finalScore || 0);
  // Pull ranking position from whichever field the server populated.
  // - r.you.position: when player is OUT of top5
  // - r.top[i].you=true: when player is IN top5 (position is the 1-based index)
  // Falls back silently when ranking hasn't loaded (offline / API error).
  let positionTxt = '';
  const r = state.rankingResult;
  if (r) {
    let pos = null;
    if (r.you && r.you.position) pos = r.you.position;
    else if (Array.isArray(r.top)) {
      const idx = r.top.findIndex(e => e && e.you);
      if (idx >= 0) pos = idx + 1;
    }
    if (pos) positionTxt = `/ランキング${pos}位`;
  }
  return `#きょむうさ猛プッシュ でランク${rank}/スコア${score}${positionTxt}達成！\nみんなでハイスコアを目指そう🐰🥇\n${SHARE_HASHTAGS}`;
}
export function shareOnX() {
  const text = buildShareText();
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(SHARE_URL)}`;
  window.open(url, '_blank', 'noopener');
}
export function shareOnLine() {
  const text = buildShareText() + '\n' + SHARE_URL;
  const url = `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(SHARE_URL)}&text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener');
}
export function shareOnThreads() {
  const text = buildShareText() + '\n' + SHARE_URL;
  const url = `https://www.threads.net/intent/post?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener');
}
export function shareCopy() {
  const text = buildShareText() + '\n' + SHARE_URL;
  const done = () => {
    if (els.shareToast) {
      els.shareToast.classList.remove('show'); void els.shareToast.offsetWidth;
      els.shareToast.classList.add('show');
      setTimeout(() => els.shareToast.classList.remove('show'), 1800);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(done);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
    done();
  }
}

/* ---------- Debug: Picker (5連タップで起動)
   v=178: BGM選曲は scene-select に移管したので Song picker は廃止。BG picker のみ残置。 */
const songTapTimes = [];

/* ---------- BG picker ----------
   localStorage[BG_PICKER_KEY] = idx (force) | null/missing/'random' (weighted).
   gameloop.pickBackground() reads the same key on each startGame. */
function getForcedBgIdx() {
  try {
    const v = localStorage.getItem(BG_PICKER_KEY);
    if (v === null || v === '' || v === 'random') return null;
    const idx = parseInt(v, 10);
    return isNaN(idx) ? null : idx;
  } catch (e) { return null; }
}
function setForcedBgIdx(idx) {
  try {
    if (idx === null || idx === undefined) localStorage.removeItem(BG_PICKER_KEY);
    else localStorage.setItem(BG_PICKER_KEY, String(idx));
  } catch (e) {}
}
function buildBgPicker() {
  if (!els.bgPickerList) return;
  const current = getForcedBgIdx();
  const items = [
    { idx: null, label: 'RANDOM', tag: '80/20' },
    ...BG_VARIANTS.map((bg, i) => ({ idx: i, label: bg.label, tag: bg.weight + '%' })),
  ];
  els.bgPickerList.innerHTML = '';
  items.forEach((it) => {
    const btn = document.createElement('button');
    btn.className = 'song-picker-btn' + ((current === it.idx || (current === null && it.idx === null)) ? ' selected' : '');
    btn.innerHTML = '<span class="sp-label">' + it.label + '</span><span class="sp-tag">' + it.tag + '</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setForcedBgIdx(it.idx);
      buildBgPicker();
      closeSongPicker();
    });
    els.bgPickerList.appendChild(btn);
  });
}
export function openSongPicker() {
  if (!els.songPicker) return;
  buildBgPicker();
  if (els.songPickerVersion) {
    const ctxState = (Snd.getCtxState && Snd.getCtxState()) || 'none';
    const bgmInfo = (Snd.getBgmState && Snd.getBgmState()) || '';
    const session = (Snd.getAudioSessionType && Snd.getAudioSessionType()) || 'n/a';
    els.songPickerVersion.textContent = GAME_VERSION + ' / ctx: ' + ctxState + ' / sess: ' + session + (bgmInfo ? ' / ' + bgmInfo : '');
  }
  els.songPicker.classList.add('show');
  els.songPicker.setAttribute('aria-hidden', 'false');
}
export function closeSongPicker() {
  if (!els.songPicker) return;
  els.songPicker.classList.remove('show');
  els.songPicker.setAttribute('aria-hidden', 'true');
}
export function handleTitleTap(ev) {
  if (!els.scenes.title || !els.scenes.title.classList.contains('active')) return;
  if (els.songPicker && els.songPicker.classList.contains('show')) return;
  // 除外: GAME START / sound toggle / picker自身
  if (ev.target && ev.target.closest && ev.target.closest('.start-btn, .sound-toggle, .song-picker')) return;
  const now = performance.now();
  // 窓切れ判定
  if (songTapTimes.length && now - songTapTimes[songTapTimes.length - 1] > SONG_PICKER_TAP_WINDOW) {
    songTapTimes.length = 0;
  }
  songTapTimes.push(now);
  if (songTapTimes.length >= SONG_PICKER_REQUIRED) {
    songTapTimes.length = 0;
    openSongPicker();
  }
}

/* ---------- Tweaks panel (parent-frame edit-mode bridge) ---------- */
export function applyTweaks() {
  document.documentElement.style.setProperty('--holo-strength', (TUNING.hologramStrength / 10).toFixed(2));
}
export function setupTweaks() {
  window.addEventListener('message', (ev) => {
    const d = ev.data || {};
    if (d.type === '__activate_edit_mode') els.tweaksPanel.classList.add('open');
    else if (d.type === '__deactivate_edit_mode') els.tweaksPanel.classList.remove('open');
  });
  try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch (e) {}
  const panel = els.tweaksPanel;
  panel.innerHTML = `
    <h3>TWEAKS</h3>
    <div class="tweak-row"><label>ビート間隔(ms) <span class="val" id="t-bi-v">${TUNING.beatIntervalMs}</span></label>
      <input type="range" id="t-bi" min="300" max="900" step="20" value="${TUNING.beatIntervalMs}"/></div>
    <div class="tweak-row"><label>PERFECT窓(ms) <span class="val" id="t-pw-v">${TUNING.perfectWindowMs}</span></label>
      <input type="range" id="t-pw" min="40" max="180" step="10" value="${TUNING.perfectWindowMs}"/></div>
    <div class="tweak-row"><label>エフェクト派手さ <span class="val" id="t-ef-v">${TUNING.effectIntensity}</span></label>
      <input type="range" id="t-ef" min="0" max="10" step="1" value="${TUNING.effectIntensity}"/></div>
    <div class="tweak-row"><label>ホログラム <span class="val" id="t-ho-v">${TUNING.hologramStrength}</span></label>
      <input type="range" id="t-ho" min="0" max="10" step="1" value="${TUNING.hologramStrength}"/></div>
    <div class="tweak-row"><label>減衰量 <span class="val" id="t-dc-v">${TUNING.decayPerSec}</span></label>
      <input type="range" id="t-dc" min="0" max="6" step="0.2" value="${TUNING.decayPerSec}"/></div>
    <div class="tweak-row"><label>SHAKE / FLASH</label>
      <div class="chips">
        <button class="chip ${TUNING.shakeEnabled?'active':''}" data-t="shake">SHAKE</button>
        <button class="chip ${TUNING.flashEnabled?'active':''}" data-t="flash">FLASH</button>
      </div></div>
  `;
  const post = (k, v) => { TUNING[k] = v; try { window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [k]: v } }, '*'); } catch (e) {} };
  const bindR = (id, key, fmt) => {
    const el = panel.querySelector('#' + id);
    const vEl = panel.querySelector('#' + id + '-v');
    el.oninput = (e) => {
      const v = +e.target.value;
      post(key, v); vEl.textContent = fmt ? fmt(v) : v;
      if (key === 'hologramStrength') applyTweaks();
    };
  };
  bindR('t-bi', 'beatIntervalMs');
  bindR('t-pw', 'perfectWindowMs');
  bindR('t-ef', 'effectIntensity');
  bindR('t-ho', 'hologramStrength');
  bindR('t-dc', 'decayPerSec');
  panel.querySelectorAll('.chip').forEach(c => {
    c.onclick = () => {
      const k = c.dataset.t === 'shake' ? 'shakeEnabled' : 'flashEnabled';
      TUNING[k] = !TUNING[k];
      c.classList.toggle('active', TUNING[k]);
      post(k, TUNING[k]);
    };
  });
}
