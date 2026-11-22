// Human-like behaviour: move classification for quick replies, pre-move delays,
// cursor paths and input-method choice. Pure functions, no DOM access.
(function (root) {
  'use strict';
  const CV = (root.CV = root.CV || {});
  const C = CV.chess || (typeof require !== 'undefined' ? require('./chessmini.js') : null);

  // A position counts as an endgame when both sides together have at most this many
  // pieces that are neither pawns nor kings.
  const ENDGAME_MAX_PIECES = 6;
  // Chance of a long "thinking" pause per move when hesitation is enabled.
  const HESITATION_CHANCE = 0.04;
  // Chance of choosing a drag instead of two clicks when inputMode is 'mixed'.
  const MIXED_DRAG_CHANCE = 0.35;

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const randn = () => {
    let u = 0;
    while (u === 0) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  };

  // ---------------- Quick-reply classification ----------------

  function nonPawnPieces(pos) {
    let n = 0;
    for (const p of pos.b) if (p && !'pPkK'.includes(p)) n++;
    return n;
  }

  // Pawn pushing a passed pawn within two steps of promotion, in an endgame, with a clear road.
  function isPawnRun(pos, m) {
    if (m.piece.toLowerCase() !== 'p' || m.capture || m.promo) return false;
    if (nonPawnPieces(pos) > ENDGAME_MAX_PIECES) return false;
    const white = m.piece === 'P';
    const f = C.fileOf(m.from), r0 = C.rankOf(m.from), r1 = C.rankOf(m.to);
    if (white ? r1 < 5 : r1 > 2) return false;                       // not yet near promotion
    const step = white ? 1 : -1, last = white ? 7 : 0;
    for (let r = r1 + step; white ? r <= last : r >= last; r += step) {
      if (pos.b[C.idx(f, r)]) return false;                          // road blocked
    }
    const enemyPawn = white ? 'p' : 'P';
    for (let ff = Math.max(0, f - 1); ff <= Math.min(7, f + 1); ff++) {
      for (let r = r0 + step; white ? r <= last : r >= last; r += step) {
        if (pos.b[C.idx(ff, r)] === enemyPawn) return false;        // not a passed pawn
      }
    }
    return true;
  }

  // Returns 'only' | 'promotion' | 'pawn-run' | 'mate' | 'recapture' | null
  // pos: parsed position, m: legal move object, ctx: { opponentCaptured, lastTo }
  function classify(pos, m, ctx, cfg, legalCount) {
    if (!cfg.quickReplies || !m) return null;
    if (cfg.quickOnlyMove && legalCount === 1) return 'only';
    if (cfg.quickPromotion) {
      if (m.promo) return 'promotion';
      if (isPawnRun(pos, m)) return 'pawn-run';
    }
    if (cfg.quickMate && C.isMate(C.apply(pos, m))) return 'mate';
    if (cfg.quickRecapture && ctx && ctx.opponentCaptured && m.capture && m.to === ctx.lastTo) return 'recapture';
    return null;
  }

  // True when at least one legal move would qualify as a quick reply.
  function likelyObvious(pos, legal, ctx, cfg) {
    if (!cfg.quickReplies) return false;
    return legal.some((m) => classify(pos, m, ctx, cfg, legal.length) !== null);
  }

  // ---------------- Delays ----------------

  // Pre-move delay in ms. Engine time runs in parallel, so the real wait is max(delay, engine time).
  function delayFor(cfg, info = {}) {
    const { legalCount = 30, category = null } = info;
    if (category && cfg.quickReplies) return rand(cfg.quickMinDelay, Math.max(cfg.quickMinDelay, cfg.quickMaxDelay));
    const lo = cfg.minDelay, hi = Math.max(cfg.minDelay, cfg.maxDelay);
    if (!cfg.humanize || cfg.delayStyle === 'uniform') return rand(lo, hi);
    // Natural: right-skewed (log-normal) around a typical value, longer in complex positions.
    const span = hi - lo;
    const complexity = clamp(0.75 + legalCount / 80, 0.75, 1.3);
    let d = lo + span * 0.4 * complexity * Math.exp(0.6 * randn());
    if (d > hi) d = hi - rand(0, span * 0.15);                        // soft cap, avoids a spike at exactly max
    d = clamp(d, lo, hi);
    if (cfg.hesitation && Math.random() < HESITATION_CHANCE) d = hi * rand(1.4, 2.2);
    return d;
  }

  // ---------------- Cursor paths ----------------

  // Points from (x0,y0) to (x1,y1): [{x, y, dt}] where dt is the pause before the next point.
  // opts.linear = straight line, no jitter (used when only the drag needs intermediate points).
  // opts.speed  = cursor speed multiplier (quick replies use a faster hand).
  function buildPath(x0, y0, x1, y1, opts = {}) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = opts.steps || clamp(Math.round(dist / 14), 8, 38);
    const totalMs = clamp(150 + dist * 0.55, 160, 520) / (opts.speed || 1);   // opts.speed > 1 = faster cursor
    const ux = dist ? (x1 - x0) / dist : 0, uy = dist ? (y1 - y0) / dist : 0;
    const nx = -uy, ny = ux;
    const bend = opts.linear ? 0 : dist * rand(-0.12, 0.12);
    const c1 = [x0 + (x1 - x0) * 0.3 + nx * bend, y0 + (y1 - y0) * 0.3 + ny * bend];
    const c2 = [x0 + (x1 - x0) * 0.7 + nx * bend * rand(0.4, 1.2), y0 + (y1 - y0) * 0.7 + ny * bend * rand(0.4, 1.2)];
    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const raw = i / steps;
      const t = opts.linear ? raw : raw * raw * (3 - 2 * raw);        // ease in/out
      const m = 1 - t;
      let x = m * m * m * x0 + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * x1;
      let y = m * m * m * y0 + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * y1;
      if (!opts.linear && i < steps) { x += rand(-0.8, 0.8); y += rand(-0.8, 0.8); }
      pts.push({ x, y, dt: (totalMs / steps) * rand(0.7, 1.3) });
    }
    if (!opts.linear && dist > 150 && Math.random() < 0.25) {          // small overshoot and correction
      const o = rand(4, 9);
      pts[pts.length - 1] = { x: x1 + ux * o, y: y1 + uy * o, dt: rand(30, 70) };
      pts.push({ x: x1, y: y1, dt: 0 });
    }
    return pts;
  }

  // ---------------- Input method ----------------

  function pickInput(cfg) {
    if (!cfg.humanize) return 'click';
    if (cfg.inputMode === 'mixed') return Math.random() < MIXED_DRAG_CHANCE ? 'drag' : 'click';
    return cfg.inputMode;
  }

  CV.human = { ENDGAME_MAX_PIECES, classify, likelyObvious, delayFor, buildPath, pickInput, rand };
  if (typeof module !== 'undefined' && module.exports) module.exports = CV.human;
})(typeof window !== 'undefined' ? window : globalThis);
