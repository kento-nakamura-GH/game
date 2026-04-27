/**
 * きょむうさ猛プッシュ — Ranking API (Cloudflare Workers + KV)
 *
 * Endpoints:
 *   POST /api/score              submit a play, get position + top5
 *   PUT  /api/score/:id/name     attach a name (1..NAME_MAX chars) to a top5 entry
 *   GET  /api/top                read current top5
 *   GET  /api/health             liveness
 *
 * Storage (KV binding: RANKING):
 *   - key `top100`                JSON array of up to TOP_LIST_SIZE entries, sorted score DESC then at ASC
 *     { id, score, name, at, trackId }
 *   - key `submission:<id>`       JSON { score, at, position, isTop5, nameAdded }
 *                                 written for every accepted submission, TTL = SUBMISSION_TTL_SECONDS
 *   - key `stats:plays`           integer counter of total accepted submissions (best-effort)
 *
 * Anti-tampering (minimum viable):
 *   The server recomputes the deterministic parts of the score formula from the raw
 *   play stats sent by the client, then sanity-checks the client-reported hitScore
 *   and decayTotal against upper bounds. Replaying the per-tap timeline is NOT done;
 *   this is an LP hook, not a competitive leaderboard. Hard tampering is possible but
 *   casual dev-tools tampering is rejected.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

// Must match the client-side computeFinalScore in game.js
const SCORE_CONSTANTS = {
  perfectValue: 400,
  greatValue: 150,
  comboMultiplier: 200,
  noMissBonus: 3000,
  decayWeight: 40,
  optimalTaps: 44,
  efficiencyFloor: 0.3,
  // rhythm timeBonus (beat-normalized, v=147+)
  targetBeats: 44,
  underTargetBase: 5000,
  underTargetPerBeat: 700,
  overTargetWindowBeats: 11,
  overTargetPerBeat: 460,
  // legacy mash timeBonus (seconds-based) — used only when client doesn't send
  // the new mashWindowSec field. Old clients with cached JS still hit this path.
  // 4s=4000pt(神速) / 8s=3000pt(標準) / 10s=600pt / 12s+=0pt.
  mashTargetSec: 8,
  mashUnderBase: 3000,
  mashUnderPerSec: 250,
  mashOverWindowSec: 4,
  mashOverPerSec: 300,
  // v=152+ mash: fixed-window mode. mashTimeBonus = mashTaps * mashTapBonus.
  // greatCount attribution already gives +150/tap, so total per-mash-tap = 300.
  mashTapBonus: 150,
  // FEVER bonus per fever-zone hit (0.5x of base accuracy values)
  feverPerfectBonus: 200,
  feverGreatBonus: 75,
  feverGoodBonus: 45,
  // per-tap gain (matches TUNING; informational only — recomputeScore uses
  // counts not gains, so these are kept in sync for future use)
  gainPerfect: 2.95,
  gainGreat: 1.77,
  gainGood: 1.00,
};

// Sanity bounds for the submitted stats. Keep generous so we don't reject real plays.
const SANITY = {
  tapsMin: 1,
  tapsMax: 400,        // bumped for v=152 5s-window mash (rhythm 44 + mash up to ~100)
  clearTimeMin: 3,
  clearTimeMax: 120,   // bumped for 1.5x play time (v=147)
  hitScorePerTap: 300, // bumped to give FEVER's 1.5x multiplier headroom (v=147)
  decayTotalMax: 300,  // play time longer → more potential decay (v=147)
  maxComboFloor: 0,
  maxScore: 200_000,   // absolute ceiling for post-recalc rejection
  beatIntervalMin: 350,
  beatIntervalMax: 700,
  mashTimeMin: 0,
  mashTimeMax: 30,
  mashWindowMin: 3,
  mashWindowMax: 30,
  mashTapsMin: 0,
  mashTapsMax: 240,    // 6s window, ~40 taps/sec ceiling
  mashScoreMin: 0,
  mashScoreMax: 250_000, // 240 mashTaps × 800 = 192000 + headroom (v=155+)
  mashScoreVersionMin: 1,
  mashScoreVersionMax: 10,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const cors = buildCors(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (!env.RANKING) {
        return json({ error: 'kv_not_bound', message: 'RANKING KV namespace is not bound. See wrangler.toml.' }, 500, cors);
      }

      const { pathname } = url;

      if (request.method === 'GET' && pathname === '/api/health') {
        return json({ ok: true, time: new Date().toISOString() }, 200, cors);
      }
      if (request.method === 'GET' && pathname === '/api/top') {
        return await handleGetTop(env, cors);
      }
      if (request.method === 'POST' && pathname === '/api/score') {
        return await handlePostScore(request, env, ctx, cors);
      }
      const nameMatch = pathname.match(/^\/api\/score\/([A-Za-z0-9_-]{6,64})\/name$/);
      if (nameMatch && (request.method === 'PUT' || request.method === 'POST')) {
        return await handlePutName(request, env, nameMatch[1], cors);
      }

      return json({ error: 'not_found' }, 404, cors);
    } catch (err) {
      return json({ error: 'internal', message: String(err && err.message || err) }, 500, cors);
    }
  },
};

/* ------------------------------------------------------------------ handlers */

async function handleGetTop(env, cors) {
  const top = await readTop(env);
  const size = Number(env.TOP_RETURN_SIZE || 5);
  return json({ top: top.slice(0, size).map(publicEntry) }, 200, cors);
}

async function handlePostScore(request, env, ctx, cors) {
  const body = await safeJson(request);
  if (!body) return json({ error: 'bad_json' }, 400, cors);

  const validation = validateSubmission(body);
  if (!validation.ok) {
    return json({ error: 'invalid_submission', reason: validation.reason }, 400, cors);
  }

  const { stats, trackId, version } = validation.value;
  const serverScore = recomputeScore(stats);

  if (!Number.isFinite(serverScore) || serverScore < 0 || serverScore > SANITY.maxScore) {
    return json({ error: 'score_out_of_range', score: serverScore }, 400, cors);
  }

  const now = Date.now();
  const id = generateId();
  const top = await readTop(env);

  // Find insertion position, 1-based.
  let position = top.length + 1;
  for (let i = 0; i < top.length; i++) {
    if (serverScore > top[i].score) {
      position = i + 1;
      break;
    }
  }

  const listSize = Number(env.TOP_LIST_SIZE || 100);
  const topReturnSize = Number(env.TOP_RETURN_SIZE || 5);
  const willEnterList = position <= listSize;
  const isTop5 = position <= topReturnSize;

  let entry = null;
  if (willEnterList) {
    entry = {
      id,
      score: serverScore,
      name: null, // filled by PUT /name if top5, else anonymous
      at: now,
      trackId: Number.isFinite(trackId) ? trackId : null,
    };
    const next = top.slice();
    next.splice(position - 1, 0, entry);
    if (next.length > listSize) next.length = listSize;
    await writeTop(env, next);
  }

  // Record the submission so PUT /name can locate it by id.
  const submission = {
    id,
    score: serverScore,
    at: now,
    position,
    isTop5,
    inList: willEnterList,
    nameAdded: false,
  };
  await env.RANKING.put(`submission:${id}`, JSON.stringify(submission), {
    expirationTtl: Number(env.SUBMISSION_TTL_SECONDS || 600),
  });

  // best-effort counter (ignore failure)
  ctx.waitUntil(bumpCounter(env, 'stats:plays'));

  const finalTop = willEnterList ? await readTop(env) : top;
  const topSlice = finalTop.slice(0, topReturnSize).map(e => ({
    ...publicEntry(e),
    you: e.id === id,
  }));

  return json({
    submissionId: id,
    score: serverScore,
    position,
    isTop5,
    needsName: isTop5,
    top: topSlice,
    you: {
      score: serverScore,
      position,
      name: null,
    },
    version: version || null,
  }, 200, cors);
}

async function handlePutName(request, env, submissionId, cors) {
  const body = await safeJson(request);
  if (!body || typeof body.name !== 'string') {
    return json({ error: 'bad_json', field: 'name' }, 400, cors);
  }
  const name = sanitizeName(body.name, Number(env.NAME_MAX_LENGTH || 5));
  if (!name) {
    return json({ error: 'invalid_name' }, 400, cors);
  }

  const raw = await env.RANKING.get(`submission:${submissionId}`);
  if (!raw) {
    return json({ error: 'submission_not_found' }, 404, cors);
  }
  const submission = JSON.parse(raw);
  if (submission.nameAdded) {
    return json({ error: 'name_already_set' }, 409, cors);
  }
  if (!submission.inList) {
    return json({ error: 'not_in_list' }, 409, cors);
  }

  const top = await readTop(env);
  const idx = top.findIndex(e => e.id === submissionId);
  if (idx === -1) {
    // Pushed out by concurrent higher scores. Leave nameAdded=false so retries
    // keep returning 410 until the submission key expires, instead of flipping
    // to a misleading 409 name_already_set on the next call.
    return json({ error: 'entry_evicted' }, 410, cors);
  }
  top[idx].name = name;
  await writeTop(env, top);

  submission.nameAdded = true;
  await env.RANKING.put(`submission:${submissionId}`, JSON.stringify(submission), {
    expirationTtl: Number(env.SUBMISSION_TTL_SECONDS || 600),
  });

  const size = Number(env.TOP_RETURN_SIZE || 5);
  const topSlice = top.slice(0, size).map(e => ({
    ...publicEntry(e),
    you: e.id === submissionId,
  }));
  return json({
    top: topSlice,
    you: { score: top[idx].score, position: idx + 1, name },
  }, 200, cors);
}

/* ------------------------------------------------------------------ scoring */

function recomputeScore(stats) {
  const C = SCORE_CONSTANTS;
  const clearTime = Number(stats.clearTime);

  // Beat-normalized timeBonus (v=147+): convert clearTime to beats so faster
  // BGM tracks no longer earn a free seconds-bonus. beatIntervalMs comes from
  // the client; clamped to a sane range to block tampering.
  const intervalRaw = Number(stats.beatIntervalMs);
  const interval = Number.isFinite(intervalRaw)
    ? Math.min(SANITY.beatIntervalMax, Math.max(SANITY.beatIntervalMin, intervalRaw))
    : 458;
  const rhythmBeats = (clearTime * 1000) / interval;
  const rhythmTimeBonus = rhythmBeats <= C.targetBeats
    ? C.underTargetBase + Math.round((C.targetBeats - rhythmBeats) * C.underTargetPerBeat)
    : Math.max(0, Math.round((C.targetBeats + C.overTargetWindowBeats - rhythmBeats) * C.overTargetPerBeat));

  // Mash scoring — three modes:
  //   v=153+ (mashScoreVersion=2): mashScore is sent separately so each mash
  //     tap contributes exactly +400 (client puts mashTaps in goodCount → 0
  //     accuracyBonus, hitScore cap excludes mash, mashTimeBonus=0, mashScore
  //     directly added below). Strict +400/tap target.
  //   v=152 (mashWindowSec without v2 flag): cached older clients. mashTaps go
  //     into greatCount, mashTimeBonus = mashTaps * 150, hitScore cap unchanged.
  //   legacy (v<152): seconds-based reward, kept for very old cached clients.
  const mashTapsRaw = Number(stats.mashTaps);
  const mashTapsClamped = Number.isFinite(mashTapsRaw)
    ? Math.min(SANITY.mashTapsMax, Math.max(SANITY.mashTapsMin, mashTapsRaw))
    : 0;
  const isV2 = stats.mashScoreVersion === 2;
  let mashTimeBonus = 0;
  let mashScore = 0;
  let hitScoreCap = SANITY.hitScorePerTap * (stats.taps | 0);
  if (isV2) {
    const mashScoreRaw = Number(stats.mashScore);
    mashScore = Number.isFinite(mashScoreRaw)
      ? Math.min(SANITY.mashScoreMax, Math.max(0, mashScoreRaw | 0))
      : 0;
    // Strict ceiling: mashScore can't exceed 800 * mashTaps even if client says otherwise (v=155+)
    mashScore = Math.min(mashScore, mashTapsClamped * 800);
    // hitScore cap excludes mash taps so client's runningScore += 800 per mash
    // tap doesn't double-count — those points come exclusively from mashScore.
    hitScoreCap = SANITY.hitScorePerTap * Math.max(0, ((stats.taps | 0) - mashTapsClamped));
  } else if (stats.mashWindowSec !== undefined && stats.mashWindowSec !== null) {
    mashTimeBonus = mashTapsClamped * C.mashTapBonus;
  } else {
    const mashTimeRaw = Number(stats.mashTimeSec);
    const mashTimeSec = Number.isFinite(mashTimeRaw)
      ? Math.min(SANITY.mashTimeMax, Math.max(SANITY.mashTimeMin, mashTimeRaw))
      : C.mashTargetSec;
    mashTimeBonus = mashTimeSec <= C.mashTargetSec
      ? C.mashUnderBase + Math.round((C.mashTargetSec - mashTimeSec) * C.mashUnderPerSec)
      : Math.max(0, Math.round((C.mashTargetSec + C.mashOverWindowSec - mashTimeSec) * C.mashOverPerSec));
  }

  const timeBonus = rhythmTimeBonus + mashTimeBonus;

  const accuracyBase = (stats.perfectCount | 0) * C.perfectValue + (stats.greatCount | 0) * C.greatValue;
  // FEVER bonus: must match score.js feverBonus computation.
  const feverBonus = (stats.feverPerfectCount | 0) * C.feverPerfectBonus
                   + (stats.feverGreatCount | 0) * C.feverGreatBonus
                   + (stats.feverGoodCount | 0) * C.feverGoodBonus;
  const accuracyBonus = accuracyBase + feverBonus;
  const comboBonus = (stats.maxCombo | 0) * C.comboMultiplier;
  const noMissBonus = (stats.missCount | 0) === 0 ? C.noMissBonus : 0;

  // Clamp client-reported fields. hitScore cap differs in v=153 mode (excludes
  // mash taps so they don't double-count alongside mashScore).
  const hitScore = clampNonNeg(stats.hitScore, hitScoreCap);
  const decayPenalty = Math.round(clampNonNeg(stats.decayTotal, SANITY.decayTotalMax) * C.decayWeight);

  const taps = Math.max(stats.taps | 0, 1);
  const efficiencyFactor = Math.max(
    C.efficiencyFloor,
    Math.min(1.0, C.optimalTaps / Math.max(taps, C.optimalTaps))
  );

  // v=155+: mashScore bypasses efficiencyFactor so heavy mash players aren't
  // penalized by their own taps inflating the efficiency denominator. Each
  // mash tap contributes its full +800 to final score regardless of total tap count.
  // Rhythm-side raw still gets multiplied by efficiencyFactor as before.
  const rawWithoutMash = hitScore + timeBonus + accuracyBonus + comboBonus + noMissBonus - decayPenalty;
  return Math.max(0, Math.round(rawWithoutMash * efficiencyFactor) + mashScore);
}

/* ------------------------------------------------------------------ validation */

function validateSubmission(body) {
  if (!body || typeof body !== 'object') return fail('not_object');
  const stats = body.stats;
  if (!stats || typeof stats !== 'object') return fail('missing_stats');

  const keys = ['taps', 'clearTime', 'maxCombo', 'perfectCount', 'greatCount', 'goodCount', 'missCount', 'hitScore', 'decayTotal'];
  for (const k of keys) {
    if (!Number.isFinite(Number(stats[k]))) return fail(`field_not_number:${k}`);
  }

  const taps = stats.taps | 0;
  if (taps < SANITY.tapsMin || taps > SANITY.tapsMax) return fail('taps_range');

  const clearTime = Number(stats.clearTime);
  if (clearTime < SANITY.clearTimeMin || clearTime > SANITY.clearTimeMax) return fail('clear_time_range');

  const counts = ['perfectCount', 'greatCount', 'goodCount', 'missCount'].map(k => stats[k] | 0);
  const sumCounts = counts.reduce((a, b) => a + b, 0);
  if (sumCounts !== taps) return fail('counts_do_not_sum');

  const hits = counts[0] + counts[1] + counts[2]; // perfect+great+good
  const maxCombo = stats.maxCombo | 0;
  if (maxCombo < 0 || maxCombo > hits) return fail('max_combo_inconsistent');

  const hitScore = Number(stats.hitScore);
  if (hitScore < 0 || hitScore > SANITY.hitScorePerTap * taps) return fail('hit_score_out_of_range');

  const decayTotal = Number(stats.decayTotal);
  if (decayTotal < 0 || decayTotal > SANITY.decayTotalMax) return fail('decay_total_out_of_range');

  // v=147+ fields. Optional (default 0) so older client versions don't break,
  // but if present they must be consistent: each fever count <= the
  // corresponding rating count, and beatIntervalMs must be in sane range.
  const feverP = stats.feverPerfectCount | 0;
  const feverGr = stats.feverGreatCount | 0;
  const feverGo = stats.feverGoodCount | 0;
  if (feverP < 0 || feverP > counts[0]) return fail('fever_perfect_inconsistent');
  if (feverGr < 0 || feverGr > counts[1]) return fail('fever_great_inconsistent');
  if (feverGo < 0 || feverGo > counts[2]) return fail('fever_good_inconsistent');

  let beatIntervalMs = null;
  if (stats.beatIntervalMs !== undefined) {
    const bi = Number(stats.beatIntervalMs);
    if (!Number.isFinite(bi) || bi < SANITY.beatIntervalMin || bi > SANITY.beatIntervalMax) {
      return fail('beat_interval_out_of_range');
    }
    beatIntervalMs = bi;
  }

  let mashTimeSec = null;
  if (stats.mashTimeSec !== undefined) {
    const mt = Number(stats.mashTimeSec);
    if (!Number.isFinite(mt) || mt < SANITY.mashTimeMin || mt > SANITY.mashTimeMax) {
      return fail('mash_time_out_of_range');
    }
    mashTimeSec = mt;
  }

  // v=152+ optional fields. mashWindowSec presence flips recomputeScore into
  // tap-count mode. Both must be valid if either is sent.
  let mashWindowSec = null;
  if (stats.mashWindowSec !== undefined && stats.mashWindowSec !== null) {
    const mw = Number(stats.mashWindowSec);
    if (!Number.isFinite(mw) || mw < SANITY.mashWindowMin || mw > SANITY.mashWindowMax) {
      return fail('mash_window_out_of_range');
    }
    mashWindowSec = mw;
  }
  let mashTaps = null;
  if (stats.mashTaps !== undefined && stats.mashTaps !== null) {
    const mt = Number(stats.mashTaps);
    if (!Number.isFinite(mt) || mt < SANITY.mashTapsMin || mt > SANITY.mashTapsMax) {
      return fail('mash_taps_out_of_range');
    }
    mashTaps = mt | 0;
  }
  // mashTaps must not exceed total taps (sanity: can't have more mash hits than total).
  if (mashTaps !== null && mashTaps > taps) return fail('mash_taps_exceeds_taps');

  // v=153+ optional fields. mashScoreVersion=2 enables strict +400/tap mode where
  // mashScore is sent separately so the server can score mash phase deterministically.
  let mashScoreVersion = null;
  if (stats.mashScoreVersion !== undefined && stats.mashScoreVersion !== null) {
    const mv = Number(stats.mashScoreVersion);
    if (!Number.isFinite(mv) || mv < SANITY.mashScoreVersionMin || mv > SANITY.mashScoreVersionMax) {
      return fail('mash_score_version_out_of_range');
    }
    mashScoreVersion = mv | 0;
  }
  let mashScore = null;
  if (stats.mashScore !== undefined && stats.mashScore !== null) {
    const ms = Number(stats.mashScore);
    if (!Number.isFinite(ms) || ms < SANITY.mashScoreMin || ms > SANITY.mashScoreMax) {
      return fail('mash_score_out_of_range');
    }
    mashScore = ms | 0;
  }

  return {
    ok: true,
    value: {
      stats: {
        taps,
        clearTime,
        maxCombo,
        perfectCount: counts[0],
        greatCount: counts[1],
        goodCount: counts[2],
        missCount: counts[3],
        hitScore,
        decayTotal,
        feverPerfectCount: feverP,
        feverGreatCount: feverGr,
        feverGoodCount: feverGo,
        beatIntervalMs,
        mashTimeSec,
        mashWindowSec,
        mashTaps,
        mashScoreVersion,
        mashScore,
      },
      trackId: Number.isFinite(Number(body.trackId)) ? Number(body.trackId) : null,
      version: typeof body.version === 'string' ? body.version.slice(0, 16) : null,
    },
  };
}

function fail(reason) { return { ok: false, reason }; }

/* ------------------------------------------------------------------ name sanitation */

// Keep it simple: trim whitespace, strip control chars, cap to N visible code points.
// We intentionally allow Japanese / emoji code points — this is a JP-targeted game.
function sanitizeName(raw, maxLen) {
  if (typeof raw !== 'string') return null;
  // Strip control chars and zero-width, trim whitespace.
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    .trim();
  if (!cleaned) return null;
  // Count by code points, not UTF-16 units, to treat surrogate-pair emojis as 1 char.
  const codePoints = Array.from(cleaned);
  if (codePoints.length === 0) return null;
  const capped = codePoints.slice(0, maxLen).join('');
  return capped;
}

/* ------------------------------------------------------------------ KV helpers */

async function readTop(env) {
  const raw = await env.RANKING.get('top100');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeTop(env, list) {
  await env.RANKING.put('top100', JSON.stringify(list));
}

async function bumpCounter(env, key) {
  const raw = await env.RANKING.get(key);
  const n = raw ? Number(raw) | 0 : 0;
  await env.RANKING.put(key, String(n + 1));
}

/* ------------------------------------------------------------------ utils */

function publicEntry(e) {
  return {
    score: e.score,
    name: e.name || null,
    at: e.at,
  };
}

function clampNonNeg(v, cap) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, cap);
}

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function buildCors(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) ? origin : (allowed[0] || '*');
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

function generateId() {
  // 16 bytes of randomness, url-safe base64 (~22 chars). Works in Workers runtime.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
