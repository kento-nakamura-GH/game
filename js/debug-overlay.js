/* ============================================================
   debug-overlay.js — Long Task observer. Activate with ?debug=1.
   Shows the 10 most recent main-thread freezes (50ms+) in the
   top-right corner so we can pinpoint random in-game jank.
   ============================================================ */

(function () {
  const params = new URLSearchParams(location.search);
  if (!params.has('debug')) return;
  if (!('PerformanceObserver' in window)) return;

  const supportedTypes = PerformanceObserver.supportedEntryTypes || [];
  if (!supportedTypes.includes('longtask')) {
    console.warn('[debug-overlay] longtask entryType not supported on this browser');
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'debug-longtask';
  overlay.style.cssText = [
    'position:fixed', 'top:8px', 'right:8px',
    'z-index:99999',
    'background:rgba(0,0,0,0.78)',
    'color:#0f0',
    'font:11px/1.35 ui-monospace,monospace',
    'padding:6px 8px',
    'border-radius:4px',
    'max-width:46vw',
    'pointer-events:none',
    'white-space:pre',
    'text-align:right',
    'box-shadow:0 2px 6px rgba(0,0,0,0.3)',
  ].join(';');
  overlay.textContent = 'longtask: waiting...';

  const attach = () => { if (document.body) document.body.appendChild(overlay); };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach);

  const entries = [];
  const MAX = 10;
  const colorOf = (dur) => dur >= 250 ? '#f44' : dur >= 120 ? '#fa0' : dur >= 80 ? '#ff0' : '#0f0';

  const render = () => {
    overlay.innerHTML = 'longtask 50ms+:<br>' +
      entries.slice().reverse().map(({ dur, t }) =>
        `<span style="color:${colorOf(dur)}">${dur}ms@${t}s</span>`
      ).join('<br>');
  };

  try {
    const obs = new PerformanceObserver((list) => {
      let pushed = false;
      for (const e of list.getEntries()) {
        if (e.duration < 50) continue;
        entries.push({ dur: Math.round(e.duration), t: (e.startTime / 1000).toFixed(1) });
        pushed = true;
      }
      while (entries.length > MAX) entries.shift();
      if (pushed) render();
    });
    obs.observe({ type: 'longtask', buffered: true });
  } catch (e) {
    overlay.textContent = 'longtask observe failed: ' + (e && e.message || e);
  }
})();
