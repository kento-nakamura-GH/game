/* ============================================================
   analytics.js — Common event tracker that fans out to GA4
   (gtag) and Microsoft Clarity. Both tracking scripts must
   already be loaded in index.html <head>.

   Usage:
     import { trackEvent } from './analytics.js';
     trackEvent('share_x', { method: 'twitter' });
   ============================================================ */

export function trackEvent(name, params = {}) {
  try {
    if (window.gtag) {
      window.gtag('event', name, params);
    }
  } catch (_) { /* ignore */ }

  try {
    if (window.clarity) {
      window.clarity('event', name);
      for (const [k, v] of Object.entries(params)) {
        window.clarity('set', k, String(v));
      }
    }
  } catch (_) { /* ignore */ }
}
