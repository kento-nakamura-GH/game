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
 *   - key `rate:<ip>:<bucket>`    integer rate-limit counter (60-second buckets, TTL 120s)
 *
 * Anti-tampering (minimum viable):
 *   The server recomputes the deterministic parts of the score formula from the raw
 *   play stats sent by the client, then sanity-checks the client-reported hitScore
 *   and decayTotal against upper bounds. Replaying the per-tap timeline is NOT done;
 *   this is an LP hook, not a competitive leaderboard. Hard tampering is possible but
 *   casual dev-tools tampering is rejected.
 *
 * Security layers (post-audit 2026-04-28):
 *   M-1 (V-05): Origin allowlist enforce on POST/PUT
 *   M-2 (V-16): Content-Type strict check (block text/plain CSRF)
 *   M-3 (V-01): Extended physical-plausibility score validation
 *   M-4 (V-02): IP-based KV rate limit (60req/min) with optional Turnstile bypass
 *   M-5      : sanitizeName hardened against unicode whitespace + HTML special chars
 *   M-6 (V-08): trackId integer + range validation
 *   M-7      : Minimal security audit log via console.warn
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
  // M-3 (V-01) physical-plausibility extras
  humanMaxTapHz: 30,         // max sustained tap rate per second (very generous, sprinters tap ~25Hz)
  minTapDensityPerSec: 0.5,  // taps must be at least 0.5 per second of clearTime
  trackIdMin: 0,
  trackIdMax: 9999,          // M-6
};

// M-4: Default rate limit if env var not set
const DEFAULT_RATE_LIMIT_PER_MIN = 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const cors = buildCors(origin, env);

    // 2) OPTIONS preflight — short-circuit, no Origin enforce.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (!env.RANKING) {
        return json({ error: 'kv_not_bound', message: 'RANKING KV namespace is not bound. See wrangler.toml.' }, 500, cors);
      }

      const { pathname } = url;
      const method = request.method;

      // 3) GET endpoints — Origin lax, no Content-Type / rate-limit enforce.
      //    CORS allowlist is still applied via buildCors() so cross-origin reads
      //    return the safe ALLOWED_ORIGINS[0] header (legacy behaviour preserved).
      if (method === 'GET' && pathname === '/api/health') {
        return json({ ok: true, time: new Date().toISOString() }, 200, cors);
      }
      if (method === 'GET' && pathname === '/api/top') {
        return await handleGetTop(env, cors);
      }

      // From here on: state-changing requests (POST /api/score, PUT/POST /name).
      const isScorePost = method === 'POST' && pathname === '/api/score';
      const nameMatch = pathname.match(/^\/api\/score\/([A-Za-z0-9_-]{6,64})\/name$/);
      const isNamePut = nameMatch && (method === 'PUT' || method === 'POST');

      if (!isScorePost && !isNamePut) {
        return json({ error: 'not_found' }, 404, cors);
      }

      // 4) Origin allowlist enforce — security: M-1 (V-05).
      //    No Origin header (curl direct) and bogus Origin both rejected.
      const allowedOrigins = parseAllowedOrigins(env);
      if (!origin || !allowedOrigins.includes(origin)) {
        secLog('origin_denied', { origin, ip: clientIp(request), path: pathname });
        return json({ error: 'origin_not_allowed' }, 403, cors);
      }

      // 5) Content-Type strict check — security: M-2 (V-16).
      //    Block text/plain CSRF that bypasses preflight.
      const contentType = (request.headers.get('content-type') || '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        secLog('content_type_denied', { ct: contentType, ip: clientIp(request), path: pathname });
        return json({ error: 'unsupported_content_type' }, 415, cors);
      }

      // 7) Parse body (used by both rate-limit Turnstile bypass and handlers).
      const body = await safeJson(request);
      if (!body) {
        return json({ error: 'bad_json' }, 400, cors);
      }

      // 6) Rate limit — security: M-4 (V-02).
      //    Optionally bypassed when Turnstile is configured & token verifies.
      const turnstileOk = await maybeVerifyTurnstile(body, env, request);
      if (!turnstileOk) {
        const limited = await checkRateLimit(env, ctx, request);
        if (limited) {
          secLog('rate_limited', { ip: clientIp(request), path: pathname });
          return json(
            { error: 'rate_limited', retryAfter: 60 },
            429,
            { ...cors, 'retry-after': '60' }
          );
        }
      }

      // 8) Dispatch to handlers.
      if (isScorePost) {
        return await handlePostScore(body, env, ctx, cors, request);
      }
      // isNamePut — already validated by regex.
      return await handlePutName(body, env, nameMatch[1], cors, request);
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

async function handlePostScore(body, env, ctx, cors, request) {
  const validation = validateSubmission(body);
  if (!validation.ok) {
    secLog('validation_failed', {
      detail: validation.reason,
      ip: clientIp(request),
      path: '/api/score',
    });
    return json({ error: 'invalid_submission', reason: validation.reason }, 400, cors);
  }

  const { stats, trackId, version } = validation.value;
  const serverScore = recomputeScore(stats);

  if (!Number.isFinite(serverScore) || serverScore < 0 || serverScore > SANITY.maxScore) {
    secLog('score_out_of_range', { score: serverScore, ip: clientIp(request) });
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

async function handlePutName(body, env, submissionId, cors, request) {
  if (!body || typeof body.name !== 'string') {
    return json({ error: 'bad_json', field: 'name' }, 400, cors);
  }
  const name = sanitizeName(body.name, Number(env.NAME_MAX_LENGTH || 5));
  if (!name) {
    secLog('invalid_name', { ip: clientIp(request), path: '/api/score/:id/name' });
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

  // M-3 (V-01): minimum tap density. Real plays clear at ~2-15 taps/sec on
  // average. 0.5 taps/sec floor lets even slow ballad tracks pass while
  // rejecting near-empty payloads with bogus mashScore.
  if (taps < clearTime * SANITY.minTapDensityPerSec) return fail('tap_density_too_low');

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
  // M-3 (V-01): re-affirm fever total can't exceed taps. Each individual fever
  // counter is already <= its rating count above, and rating counts sum to
  // taps. So fever total <= taps is guaranteed transitively, but we add an
  // explicit guard for defense in depth.
  if (feverP + feverGr + feverGo > taps) return fail('fever_total_exceeds_taps');

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

  // M-3 (V-01): mashTimeSec <= mashWindowSec — you can't mash longer than the
  // window allows. Only enforce when both are present.
  // Client sends mashTimeSec = clearTime - rhythmClearSec, which includes UI
  // overhead between rhythm-clear (gauge=99) and triggerClear: ~350ms mash
  // startup delay + ~300ms finishMashMode→triggerClear settle + scheduler drift.
  // Allow MASH_TIME_TOLERANCE_SEC slack so legitimate plays aren't rejected.
  // mashScore inflation is already blocked by mashTaps * 800 cap and
  // mash_taps_exceed_human_rate, so this check is defense-in-depth.
  const MASH_TIME_TOLERANCE_SEC = 3;
  if (mashTimeSec !== null && mashWindowSec !== null && mashTimeSec > mashWindowSec + MASH_TIME_TOLERANCE_SEC) {
    return fail('mash_time_exceeds_window');
  }

  // M-3 (V-01): mashTaps physical-plausibility against mashTimeSec. Humans
  // cannot sustain >30 taps/sec, so mashTaps > mashTimeSec * 30 is impossible.
  // This blocks the audit's `mashTaps=240, mashTimeSec=5` cheese. Only enforce
  // when both fields are present and mashTimeSec > 0 (avoid div-by-zero traps
  // and protect legacy clients that send mashTimeSec=0).
  if (mashTaps !== null && mashTimeSec !== null && mashTimeSec > 0) {
    if (mashTaps > mashTimeSec * SANITY.humanMaxTapHz) {
      return fail('mash_taps_exceed_human_rate');
    }
  }

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

  // M-6 (V-08): trackId integer + range validation. Replaces previous
  // Number.isFinite-only check. Keep null fallback so legacy clients without
  // trackId still work (treated as anonymous track).
  let trackId = null;
  if (body.trackId !== undefined && body.trackId !== null) {
    const tid = Number(body.trackId);
    if (!Number.isInteger(tid) || tid < SANITY.trackIdMin || tid > SANITY.trackIdMax) {
      return fail('track_id_out_of_range');
    }
    trackId = tid;
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
      trackId,
      version: typeof body.version === 'string' ? body.version.slice(0, 16) : null,
    },
  };
}

function fail(reason) { return { ok: false, reason }; }

/* ------------------------------------------------------------------ name sanitation */

// M-5: hardened sanitizer. Strips control chars, zero-width, full-width space,
// NBSP, line/paragraph separators, and HTML special chars (defense in depth
// even though clients use textContent). Caps to N visible code points.
// Japanese / emoji code points pass through.
const NAME_STRIP_CONTROL_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2028\u2029\u205F\u2060\uFEFF]/g;
const NAME_STRIP_WHITESPACE_RE = /[\u00A0\u3000]/g;
const NAME_STRIP_HTML_RE = /[<>&"'`]/g;
const NAME_ALL_WHITESPACE_RE = /^[\s\u00A0\u3000]*$/;

function sanitizeName(raw, maxLen) {
  if (typeof raw !== 'string') return null;
  // Reject if every char is whitespace (ASCII / NBSP / full-width).
  if (NAME_ALL_WHITESPACE_RE.test(raw)) return null;
  const cleaned = raw
    .replace(NAME_STRIP_CONTROL_RE, '')
    .replace(NAME_STRIP_WHITESPACE_RE, '')
    .replace(NAME_STRIP_HTML_RE, '')
    .trim();
  if (!cleaned) return null;
  // Count by code points, not UTF-16 units, to treat surrogate-pair emojis as 1 char.
  const codePoints = Array.from(cleaned);
  if (codePoints.length === 0) return null;
  return codePoints.slice(0, maxLen).join('');
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

/* ------------------------------------------------------------------ rate limiting (M-4 / V-02) */

async function checkRateLimit(env, ctx, request) {
  const ip = clientIp(request);
  if (!ip || ip === 'unknown') {
    // Without an IP we can't rate-limit fairly. Fail-open rather than block all
    // wrangler-dev local traffic. Production traffic on Cloudflare always has
    // cf-connecting-ip set, so this branch only fires for local testing.
    return false;
  }
  const limit = Number(env.RATE_LIMIT_PER_MIN || DEFAULT_RATE_LIMIT_PER_MIN);
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `rate:${ip}:${bucket}`;
  const raw = await env.RANKING.get(key);
  const current = raw ? (Number(raw) | 0) : 0;
  if (current >= limit) {
    return true; // limited
  }
  // Increment with TTL 120s (covers current bucket + next bucket overlap).
  // Use waitUntil so the response isn't blocked by KV write latency.
  const next = current + 1;
  ctx.waitUntil(
    env.RANKING.put(key, String(next), { expirationTtl: 120 })
  );
  return false;
}

/* ------------------------------------------------------------------ Turnstile (M-4 stub) */

// Optional Turnstile token verification. Currently stubbed to always return
// false (no bypass). When env.TURNSTILE_SECRET is configured, real verify runs
// and a valid token bypasses the rate limit. Keep this hookable so we can flip
// it on without code changes other than `wrangler secret put TURNSTILE_SECRET`.
async function maybeVerifyTurnstile(body, env, request) {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return false; // Not configured → no bypass.
  const token = body && typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  if (!token) return false;
  return await verifyTurnstile(token, env, request);
}

async function verifyTurnstile(token, env, request) {
  try {
    const formData = new FormData();
    formData.append('secret', env.TURNSTILE_SECRET);
    formData.append('response', token);
    const ip = clientIp(request);
    if (ip && ip !== 'unknown') formData.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) return false;
    const result = await res.json();
    return result && result.success === true;
  } catch {
    return false;
  }
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

function parseAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function buildCors(origin, env) {
  const allowed = parseAllowedOrigins(env);
  const allow = allowed.includes(origin) ? origin : (allowed[0] || '*');
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

// M-7: minimal security audit log. wrangler tail picks these up.
function secLog(reason, fields) {
  try {
    const ts = new Date().toISOString();
    const parts = [`[SEC]`, `ts=${ts}`, `reason=${reason}`];
    if (fields) {
      for (const k of Object.keys(fields)) {
        const v = fields[k];
        if (v === undefined || v === null) continue;
        // Truncate to avoid log spam from giant payloads.
        const s = String(v).slice(0, 128).replace(/\s+/g, ' ');
        parts.push(`${k}=${s}`);
      }
    }
    console.warn(parts.join(' '));
  } catch {
    // Logging must never throw.
  }
}

function generateId() {
  // 16 bytes of randomness, url-safe base64 (~22 chars). Works in Workers runtime.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
