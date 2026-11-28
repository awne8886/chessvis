// Pure clock helpers (no DOM): reading a clock text and turning the remaining time into an AggroChess budget.
// Units: AggroChess think(ms) and think_clock(soft, hard) both take MILLISECONDS (checked with a probe of the wasm).
// `hard` is a real cap of the search only when soft <= hard; soft is the normal budget, the search may use more
// (up to hard) when the position is unclear. A soft above hard ran 3.9 s with hard = 300 ms, so this is never sent.
(function (root) {
  'use strict';
  const CV = (root.CV = root.CV || {});

  // ---- constants (all ms unless noted) ----
  const CLOCK_FLOOR_MS = 100;            // smallest budget in normal mode
  const CLOCK_SOFT_DIV = 40;             // soft = remaining / 40 ...
  const CLOCK_INC_SHARE = 0.8;           // ... + 80% of the increment, capped by the user's think time
  const CLOCK_HARD_DIV = 8;              // hard = remaining / 8 ...
  const CLOCK_HARD_THINK_MULT = 3;       // ... and at most 3x the user's think time
  const CLOCK_LOW_MS = 10000;            // under this much time left: the very short fallback below
  const CLOCK_LOW_SOFT_DIV = 60;         // low: soft = remaining / 60 ...
  const CLOCK_LOW_HARD_DIV = 15;         // low: hard = remaining / 15
  const CLOCK_LOW_MIN_MS = 30;           // low: never below this (the engine needs a moment to answer at all)
  const CLOCK_SAFE_DIV = 4;              // whatever the rules above say, hard <= remaining / 4
  const CLOCK_DELAY_FRAC = 0.08;         // the human-like pause is capped at 8% of the remaining time
  const CLOCK_DELAY_FLOOR_MS = 40;

  // "10:00", "1:23:45", "0:09.8", "9.8" -> ms; null when it is not a clock.
  function parseClock(text) {
    if (text === null || text === undefined) return null;
    const t = String(text).replace(/\s+/g, '').replace(',', '.');
    const m = /^(?:(\d+):)?(?:(\d+):)?(\d+)(?:\.(\d+))?$/.exec(t);
    if (!m) return null;
    const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);   // [h, m, s] / [m, s] / [s]
    if (parts.length === 3 && (parts[1] > 59 || parts[2] > 59)) return null;
    if (parts.length === 2 && parts[1] > 59) return null;
    const secs = parts.reduce((acc, v) => acc * 60 + v, 0);
    const frac = m[4] ? Number('0.' + m[4]) : 0;
    const ms = Math.round((secs + frac) * 1000);
    return Number.isFinite(ms) ? ms : null;
  }

  // "+5", "5 sec", "10|5", "3+2" -> ms of increment, or 0 when none is readable.
  function parseIncrement(text) {
    const t = String(text || '');
    const m = /(?:\d+\s*[|+]\s*(\d+))|(?:\+\s*(\d+))|(?:^\s*(\d+)\s*(?:sec|s)\b)/i.exec(t);
    const v = m ? Number(m[1] || m[2] || m[3]) : 0;
    return Number.isFinite(v) && v > 0 && v < 3600 ? v * 1000 : 0;
  }

  // { soft, hard, mode } in ms, or null when the remaining time is not usable (the caller then uses its fixed think time).
  function clockBudget({ remainingMs, incrementMs, thinkMs }) {
    const rem = Number(remainingMs), inc = Math.max(0, Number(incrementMs) || 0);
    const think = Number.isFinite(Number(thinkMs)) && Number(thinkMs) > 0 ? Number(thinkMs) : 1000;
    if (!Number.isFinite(rem) || rem <= 0) return null;
    let soft, hard, mode = 'normal';
    if (rem < CLOCK_LOW_MS) {
      mode = 'low';
      soft = Math.max(CLOCK_LOW_MIN_MS, rem / CLOCK_LOW_SOFT_DIV);
      hard = Math.max(soft, rem / CLOCK_LOW_HARD_DIV);
    } else {
      soft = Math.max(CLOCK_FLOOR_MS, Math.min(think, rem / CLOCK_SOFT_DIV + CLOCK_INC_SHARE * inc));
      hard = Math.max(soft, Math.min(rem / CLOCK_HARD_DIV, CLOCK_HARD_THINK_MULT * think));
    }
    hard = Math.min(hard, rem / CLOCK_SAFE_DIV);          // never a budget that could lose on time
    soft = Math.min(soft, hard);                          // soft above hard is not safe to send (see the top)
    return { soft: Math.max(1, Math.round(soft)), hard: Math.max(1, Math.round(hard)), mode };
  }

  // Upper bound for the human-like pause so it cannot eat the clock; unchanged when plenty of time is left.
  function delayCap(delayMs, remainingMs) {
    const rem = Number(remainingMs);
    if (!Number.isFinite(rem) || rem <= 0) return delayMs;
    return Math.min(delayMs, Math.max(CLOCK_DELAY_FLOOR_MS, Math.round(rem * CLOCK_DELAY_FRAC)));
  }

  // ---- 2.0.4 (D3): which page clock is mine / the opponent's (the rules content.js used in 2.0.3, now pure) ----
  // cands: [{ ms, cls }] in document order, each element once (cls = its lower-case class string). That colour's clock
  // first ('clock-white' / 'clock-black'; works with a flipped board), then a class with that colour and not the other,
  // then the clock at the bottom (mine) / top (the opponent's). Returns the candidate or null.
  function pickClock(cands, myColor, which) {
    const mineC = myColor === 'w' ? 'white' : 'black', otherC = myColor === 'w' ? 'black' : 'white';
    const [want, avoid, side] = which === 'opp' ? [otherC, mineC, 'top'] : [mineC, otherC, 'bottom'];
    const sideRe = new RegExp('(^|[\\s-])' + side + '($|[\\s-])');
    return cands.find((c) => c.cls.includes('clock-' + want)) ||
           cands.find((c) => c.cls.includes(want) && !c.cls.includes(avoid)) ||
           cands.find((c) => sideRe.test(c.cls)) || null;
  }
  // Both clocks from ONE candidate list: { me, opp } (each a candidate or null).
  const pickClocks = (cands, myColor) => ({ me: pickClock(cands, myColor, 'me'), opp: pickClock(cands, myColor, 'opp') });
  // Player names: found = [{ t, top }] (distinct texts, document order); the topmost is the opponent, the lowest is me.
  // null with fewer than two. (Sort is stable: equal tops keep document order, as before.)
  function pickNames(found) {
    if (!found || found.length < 2) return null;
    const s = found.slice().sort((x, y) => x.top - y.top);
    return { opp: s[0].t, me: s[s.length - 1].t };
  }

  CV.clock = { parseClock, parseIncrement, clockBudget, delayCap, pickClock, pickClocks, pickNames, CLOCK_LOW_MS, CLOCK_FLOOR_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = CV.clock;
})(typeof window !== 'undefined' ? window : globalThis);
