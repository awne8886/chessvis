// Shared settings: defaults, limits and validation.
// Loaded by the content scripts and by the popup (isolated world, shared `CV` namespace).
(function (root) {
  'use strict';
  const CV = (root.CV = root.CV || {});

  CV.DEFAULTS = {
    // --- core ---
    enabled: false,
    engine: 'aggro',          // 'aggro' | 'stockfish'
    depth: 10,                // Stockfish search depth
    sfMaxMs: 0,               // Stockfish max think time per move in ms (0 = off: search to the full depth)
    thinkMs: 1000,            // AggroChess think time
    minDelay: 300,            // ms, lower bound of the pre-move delay
    maxDelay: 800,            // ms, upper bound of the pre-move delay

    // --- human-like play ---
    humanize: true,           // master switch for the block below
    delayStyle: 'natural',    // 'natural' | 'uniform'
    hesitation: true,         // rare, longer pauses
    mouseMove: true,          // cursor glides along a curved path
    clickOffset: true,        // click a random spot inside the square, not the centre
    inputMode: 'click',       // 'click' | 'drag' | 'mixed'
    imperfection: 0,          // % chance per move of a near-best alternative (Stockfish only)

    // --- quick replies ---
    quickReplies: true,       // master switch for the block below
    quickOnlyMove: true,      // only one legal move
    quickRecapture: true,     // retake the piece that just captured
    quickPromotion: true,     // promotion and passed-pawn runs in endgames
    quickMate: true,          // mate in one
    quickMinDelay: 80,        // ms
    quickMaxDelay: 300,       // ms
    quickThinkMs: 300,        // ms, reduced AggroChess budget when a move looks obvious

    // --- watchdog ---
    watchdogMs: 1000,         // how often the board is re-read, whatever the DOM says

    // --- AggroChess options (shown only when the engine is AggroChess) ---
    aggroUseClock: true,      // size the search from my chess.com clock (think_clock) when a clock can be read
    aggroPonder: true,        // think on the opponent's time with a second, killable worker (2.0.2: on by default; false = 2.0.0)
    aggroPonderMs: 1500,      // ms of pondering per opponent move
    aggroPonderHashMb: 32,    // hash table of each ponder worker in MB (32 = the engine's own size; lower fits more workers on a phone)
    aggroPonderWorkers: 1,    // ponder workers working through the opponent's moves together (~50 MiB each; capped by the CPU count)
    aggroShowEval: false,     // show a short evaluation line while the opponent is thinking
    aggroVerify: false,       // compare the engine's position with the page's (warn only)

    // --- Stockfish options (shown only when the engine is Stockfish) ---
    sfUseClock: false,        // cap the search with a budget sized from my chess.com clock (never more than a quarter of what is left)
    sfPonder: true,           // think on the opponent's time with extra Stockfish workers, never the main one (2.0.2: on by default; false = 2.0.0)
    sfPonderMs: 1500,         // ms of pondering per opponent move (a ceiling)
    sfPonderWorkers: 1,       // ponder workers sharing the opponent's moves (capped by the CPU count; each costs wasm memory + its hash)
    sfPonderHashMb: 16,       // hash table of each ponder worker in MB (the main worker keeps 32)
    sfThreads: 1,             // search threads of the MAIN worker; above 1 only with the threaded build and only if the browser allows SharedArrayBuffer

    // --- 2.0.0: speed (both engines unless noted) ---
    earlyPonder: true,        // start pondering the moment our move is decided, not when the board shows it (false = 1.8.0)
    boardDebounceMs: 40,      // wait after a board change before the stable-read check (2.0.2: 40; 80 = 2.0.0, 250 = the 1.8.0 timing)
    ponderUntilMove: true,    // keep pondering (deepening the likely replies) until the opponent moves, up to ponderMaxMs (false = the *PonderMs budget, 1.8.0)
    ponderMaxMs: 8000,        // ceiling of a ponder job with ponderUntilMove
    ponderHitFast: true,      // a ponder hit is answered with the quick delay and the faster hand (false = 1.8.0: normal delay)
    ponderHitTopUp: true,     // 2.0.2: on a ponder hit the main worker searches on through that pause when it can go deeper than the prepared reply (false = 2.0.0)
    sfSearchMode: 'delay',    // Stockfish full search: 'depth' (1.8.0: go depth N) | 'delay' (search through the human-like pause, depth = minimum) | 'clock'

    // --- game recording and saving ---
    saveWithSacrifices: false,       // save a finished game when its counted sacrifices reach the threshold
    saveSacrificeThreshold: 3,
    saveEveryGame: false,            // save every finished game
    sacrificeTypePawn: true,         // which sacrificed piece types are counted (the type of the piece that moved)
    sacrificeTypeKnight: true,
    sacrificeTypeBishop: true,
    sacrificeTypeRook: true,
    sacrificeTypeQueen: true,
    maxSavedGames: 50,
    countBrilliants: false,          // best effort: read chess.com's post-game popup
    brilliantWaitSec: 4,

    // --- overlay UI ---
    overlayOpen: true,
    overlayX: null,           // null = default corner
    overlayY: null,
  };

  // [min, max, step]
  CV.LIMITS = {
    depth: [1, 20, 1],
    sfMaxMs: [0, 10000, 100],
    thinkMs: [200, 5000, 100],
    minDelay: [100, 3000, 50],
    maxDelay: [100, 3000, 50],
    imperfection: [0, 30, 1],
    quickMinDelay: [40, 1000, 10],
    quickMaxDelay: [40, 1500, 10],
    quickThinkMs: [100, 2000, 50],
    watchdogMs: [200, 5000, 100],
    boardDebounceMs: [0, 300, 10],
    aggroPonderMs: [200, 5000, 100],
    aggroPonderWorkers: [1, 3, 1],
    aggroPonderHashMb: [4, 64, 4],
    sfPonderMs: [200, 5000, 100],
    sfPonderWorkers: [1, 3, 1],
    sfPonderHashMb: [4, 64, 4],
    sfThreads: [1, 4, 1],
    ponderMaxMs: [1000, 30000, 500],
    saveSacrificeThreshold: [1, 20, 1],
    maxSavedGames: [5, 200, 1],
    brilliantWaitSec: [1, 15, 1],
  };

  CV.ENUMS = {
    engine: ['aggro', 'stockfish'],
    delayStyle: ['natural', 'uniform'],
    inputMode: ['click', 'drag', 'mixed'],
    sfSearchMode: ['depth', 'delay', 'clock'],
  };

  // Returns a cleaned copy of `obj`: unknown keys dropped, numbers clamped, enums checked.
  CV.sanitize = function (obj) {
    const out = {};
    for (const k of Object.keys(CV.DEFAULTS)) {
      if (!(k in obj)) continue;
      const v = obj[k], def = CV.DEFAULTS[k];
      if (CV.LIMITS[k]) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        const [lo, hi, step] = CV.LIMITS[k];
        const dec = (String(step).split('.')[1] || '').length;   // 0.05 -> 2: avoids 0.30000000000000004
        out[k] = +Math.min(hi, Math.max(lo, Math.round(n / step) * step)).toFixed(dec);
      } else if (CV.ENUMS[k]) {
        if (CV.ENUMS[k].includes(v)) out[k] = v;
      } else if (typeof def === 'boolean') {
        out[k] = !!v;
      } else if (k === 'overlayX' || k === 'overlayY') {
        out[k] = Number.isFinite(Number(v)) && v !== null ? Number(v) : null;
      }
    }
    return out;
  };

  // ---- Stockfish helpers (pure; used by background.js) ----
  const SF_START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  const fenPlacement = (fen) => String(fen || '').split(' ')[0];

  // Number of pieces on the board in a FEN.
  CV.sfPieceCount = function (fen) {
    return (fenPlacement(fen).match(/[a-zA-Z]/g) || []).length;
  };

  // True when a request starts a new game: the engine has not searched yet, the position is the standard
  // start position, or there are more pieces than in the previous request (pieces never come back in one game).
  // Only then is `ucinewgame` sent; within a game the search state (hash table) is kept.
  CV.sfIsNewGame = function (prevCount, fen) {
    if (prevCount === null || prevCount === undefined) return true;
    return fenPlacement(fen) === SF_START_PLACEMENT || CV.sfPieceCount(fen) > prevCount;
  };

  // The UCI `go` command. maxMs 0/invalid = depth only; otherwise whichever limit is reached first stops the search.
  CV.sfGoCommand = function (depth, maxMs) {
    const [dlo, dhi] = CV.LIMITS.depth, [mlo, mhi] = CV.LIMITS.sfMaxMs;
    const d = Math.min(dhi, Math.max(dlo, Math.round(Number(depth)) || CV.DEFAULTS.depth));
    const m = Math.min(mhi, Math.max(mlo, Math.round(Number(maxMs)) || 0));
    return 'go depth ' + d + (m > 0 ? ' movetime ' + m : '');
  };

  // Keeps min <= max for the two delay pairs.
  CV.fixRanges = function (c) {
    if (c.minDelay > c.maxDelay) c.maxDelay = c.minDelay;
    if (c.quickMinDelay > c.quickMaxDelay) c.quickMaxDelay = c.quickMinDelay;
    return c;
  };



  // ---- backup: export / import ----
  // Not part of a backup: panel position/state (per device) and Auto-play, so importing can never start play.
  const UI_KEYS = ['overlayOpen', 'overlayX', 'overlayY', 'enabled'];
  CV.exportSettings = function (cfg) {
    const out = {};
    for (const k of Object.keys(CV.DEFAULTS)) if (!UI_KEYS.includes(k) && k in cfg) out[k] = cfg[k];
    return JSON.stringify({ type: 'chessvision-settings', version: 1, settings: out }, null, 2);
  };

  // Parses pasted JSON. Unknown keys are ignored and values are clamped; returns { ok, values, count, error }.
  CV.importSettings = function (text) {
    let obj;
    try { obj = JSON.parse(String(text)); } catch (e) { return { ok: false, error: 'not valid JSON' }; }
    if (!obj || obj.type !== 'chessvision-settings' || typeof obj.settings !== 'object' || obj.settings === null) {
      return { ok: false, error: 'not a ChessVision settings export' };
    }
    const raw = {};
    for (const k of Object.keys(obj.settings)) if (!UI_KEYS.includes(k)) raw[k] = obj.settings[k];
    const values = CV.sanitize(raw);
    return { ok: true, values, count: Object.keys(values).length };
  };


  // ---- history, engine messages and pondering (pure; used by background.js and the page scripts) ----
  CV.STANDARD_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Plays one UCI move on a chessmini position; { move, pos } or null if it is not legal there.
  CV.applyUci = function (pos, uci) {
    const m = CV.chess.legalMoves(pos).find((x) => x.uci === uci);
    return m ? { move: m, pos: CV.chess.apply(pos, m) } : null;
  };

  // Replays a move list from a FEN: { ok, pos, failedAt }.
  CV.replayUci = function (startFen, moves) {
    let pos = CV.chess.parseFen(startFen);
    const list = moves || [];
    for (let i = 0; i < list.length; i++) {
      const r = CV.applyUci(pos, list[i]);
      if (!r) return { ok: false, pos, failedAt: i };
      pos = r.pos;
    }
    return { ok: true, pos };
  };

  // The Stockfish `position` command. With a usable history: `position fen <startFen> moves m1 m2 ...`
  // (so the engine sees repetitions and the 50-move counter); without: the old `position fen <fen>`.
  CV.sfPositionCommand = function (fen, startFen, moves) {
    if (typeof startFen === 'string' && startFen && Array.isArray(moves) && moves.length) {
      return 'position fen ' + startFen + ' moves ' + moves.join(' ');
    }
    return 'position fen ' + (typeof startFen === 'string' && startFen && Array.isArray(moves) ? startFen : fen);
  };

  // How many ponder workers may run: the setting (1-3), at most max(1, hardwareConcurrency - 1) so the main worker and the
  // page keep a core. An unknown CPU count (undefined, 0, not a number) counts as 1 core: one worker, the old behaviour.
  CV.ponderWorkerCount = function (setting, hardwareConcurrency) {
    const lim = CV.LIMITS.aggroPonderWorkers;
    const want = Math.min(lim[1], Math.max(lim[0], Math.round(Number(setting)) || lim[0]));
    const hc = Math.floor(Number(hardwareConcurrency));
    const cap = Number.isFinite(hc) && hc > 0 ? Math.max(1, hc - 1) : 1;
    return Math.min(want, cap);
  };

  // Identity of a position by its history: same start and same moves = same key.
  CV.ponderKey = function (startFen, moves) {
    return String(startFen || '') + '|' + (moves || []).join(' ');
  };

  // Why pondering must be cancelled when settings change: 'engineSwitch', 'ponderOff' or null.
  CV.ponderCfgChange = function (prev, next) {
    if (prev.engine === 'aggro' && next.engine !== 'aggro') return 'engineSwitch';
    if (prev.engine === 'stockfish' && next.engine !== 'stockfish' && prev.sfPonder) return 'engineSwitch';   // 1.8.0: Stockfish pondering
    if ((prev.aggroPonder && !next.aggroPonder) || (prev.aggroShowEval && !next.aggroShowEval)) return 'ponderOff';
    if (prev.sfPonder && !next.sfPonder) return 'ponderOff';
    return null;
  };

  // Is pondering wanted for this engine and these settings? (content.js and the debug info use it)
  CV.ponderWanted = function (cfg) {
    return cfg.engine === 'aggro' ? !!cfg.aggroPonder : cfg.engine === 'stockfish' ? !!cfg.sfPonder : false;
  };

  // Pondering state (pure). One entry per opponent turn: the position after OUR move (startFen + base moves), the
  // opponent moves that are planned (every legal one) and, per opponent move, the reply found so far. Replies arrive
  // one by one while the opponent thinks; when the opponent moves, whatever was already found is used.
  // decide() -> { decision, result }:
  //   'none' no entry | 'miss' other position / no history | 'hit' that move has a finished reply
  //   'late' that move is planned but its search has not finished (it is dropped by the caller).
  // Several ponder workers can run at once, so the state keeps a SET of running opponent moves (the moves whose reply
  // search is under way). setRunning(uci) is the old single-move call (it replaces the set; null clears it);
  // addRunning / removeRunning are used by the pool. 'late' = planned, no finished reply yet (whether or not it is
  // running); decide() also says in `running` whether a worker was on that very move when the opponent played it.
  CV.createPonderState = function () {
    const counters = { attempts: 0, hits: 0, misses: 0, late: 0, skipped: 0, lastLeadMs: null, avgLeadMs: null, leadSamples: 0 };
    let entry = null, leadSum = 0;
    const sameBase = (e, startFen, moves) => Array.isArray(moves) && startFen === e.startFen && moves.length === e.base.length + 1 &&
      e.base.every((m, i) => moves[i] === m);
    const syncRunning = (e) => { e.running = e.runningSet.size ? [...e.runningSet].pop() : null; };   // old field: the latest started one
    return {
      counters,
      get: () => entry,
      begin(startFen, base, planned) {
        counters.attempts++;
        entry = { startFen, base: base.slice(), planned: new Set(planned), results: {}, running: null, runningSet: new Set(), runningMeta: new Map(), counted: new Set(), beganAt: Date.now() };
        return entry;
      },
      skip() { counters.skipped++; },
      setRunning(uci) { if (entry) { entry.runningSet.clear(); entry.runningMeta.clear(); if (uci) entry.runningSet.add(uci); syncRunning(entry); } },
      // meta (2.0.0, optional): { startedAt, ms } of that reply search; decide() hands it back as runningMeta (CV.lateWaitMs)
      addRunning(uci, meta) { if (entry && uci) { entry.runningSet.add(uci); if (meta) entry.runningMeta.set(uci, { startedAt: meta.startedAt, ms: meta.ms }); else entry.runningMeta.delete(uci); syncRunning(entry); } },
      removeRunning(uci) { if (entry) { entry.runningSet.delete(uci); entry.runningMeta.delete(uci); syncRunning(entry); } },
      runningMoves: () => (entry ? [...entry.runningSet] : []),
      // Stores the reply found for one opponent move. False if the entry is gone or the answer is empty, or (2.0.0) when a
      // DEEPER reply is already stored for that move (a seed from the main search's PV, or an earlier deepening pass, is never
      // replaced by a shallower search; equal or greater depth replaces it as before).
      addResult(oppUci, r) {
        if (!entry || !entry.planned.has(oppUci) || !r || !r.uci) return false;
        const old = entry.results[oppUci];
        if (old && old.depth > (r.depth || 0)) return false;
        entry.results[oppUci] = { uci: r.uci, san: r.san || null, depth: r.depth || 0, sacrifice: !!r.sacrifice, ms: r.ms || 0 };
        return true;
      },
      found: () => (entry ? Object.keys(entry.results).length : 0),
      decide(startFen, moves) {
        if (!entry) return { decision: 'none', result: null, running: false, runningMeta: null };
        let decision = 'miss', result = null, running = false, runningMeta = null;
        if (sameBase(entry, startFen, moves)) {
          const opp = moves[moves.length - 1];
          if (entry.results[opp]) { decision = 'hit'; result = entry.results[opp]; }
          else if (entry.planned.has(opp)) { decision = 'late'; running = entry.runningSet.has(opp); runningMeta = (running && entry.runningMeta.get(opp)) || null; }
        }
        const key = String(startFen) + '|' + (Array.isArray(moves) ? moves.join(' ') : '');
        let leadMs = null;
        if (decision !== 'miss') leadMs = Date.now() - entry.beganAt;   // 2.0.0: how long before the opponent's move the job began (early ponder makes it longer)
        if (!entry.counted.has(key)) {
          entry.counted.add(key); counters[decision === 'hit' ? 'hits' : decision === 'late' ? 'late' : 'misses']++;
          if (leadMs !== null) { counters.lastLeadMs = leadMs; leadSum += leadMs; counters.leadSamples++; counters.avgLeadMs = Math.round(leadSum / counters.leadSamples); }
        }
        return { decision, result, running, runningMeta, leadMs };
      },
      // Drops the entry (new game, takeback, setting off, engine switch, miss...). True if there was one.
      invalidate() { const had = !!entry; entry = null; return had; },
    };
  };

  // ---- Stockfish 1.8.0 helpers (pure; used by background.js and content.js) ----
  // Can this browser context run the threaded Stockfish build? It needs SharedArrayBuffer, Atomics and shared WebAssembly
  // memory. `env` is what the caller sees (globalThis in a browser); a test passes a fake. crossOriginIsolated is reported
  // but not required: an extension page may have SharedArrayBuffer without it (not verified for Firefox, hence this test).
  CV.sabSupport = function (env) {
    env = env || {};
    const checks = {
      sharedArrayBuffer: typeof env.SharedArrayBuffer === 'function',
      atomics: typeof env.Atomics === 'object' && env.Atomics !== null,
      sharedMemory: false,
      crossOriginIsolated: env.crossOriginIsolated === true,
    };
    try {
      const W = env.WebAssembly;
      if (W && typeof W.Memory === 'function') { const m = new W.Memory({ initial: 1, maximum: 1, shared: true }); checks.sharedMemory = !!(m && m.buffer); }
    } catch (e) { checks.sharedMemory = false; }
    const failed = ['sharedArrayBuffer', 'atomics', 'sharedMemory'].find((k) => !checks[k]) || null;
    return { ok: !failed, reason: failed ? failed + ' missing' : null, checks };
  };

  // Search threads for the main worker: the setting (1-4), at most max(1, hardwareConcurrency - 1) so the page keeps a core,
  // and 1 whenever the threaded build cannot run (sabOk false). Unknown CPU count -> 1.
  CV.sfThreadCount = function (setting, hardwareConcurrency, sabOk) {
    const lim = CV.LIMITS.sfThreads;
    const want = Math.min(lim[1], Math.max(lim[0], Math.round(Number(setting)) || lim[0]));
    if (!sabOk) return 1;
    const hc = Math.floor(Number(hardwareConcurrency));
    const cap = Number.isFinite(hc) && hc > 0 ? Math.min(lim[1], Math.max(1, hc - 1)) : 1;
    return Math.min(want, cap);
  };

  // The time cap of a Stockfish search (ms, 0 = none): the smaller of the user's cap (sfMaxMs) and the clock budget (soft),
  // ignoring whichever is 0 / unusable. The clock budget is already <= remaining / 4 (clock.js).
  CV.sfSearchCap = function (sfMaxMs, clockSoftMs) {
    const a = Math.max(0, Math.round(Number(sfMaxMs)) || 0), b = Math.max(0, Math.round(Number(clockSoftMs)) || 0);
    return a && b ? Math.min(a, b) : (a || b);
  };

  // Score as one number from the side to move's point of view (mates +-100000 - plies).
  CV.sfScoreValue = function (cp, mate) {
    if (mate !== null && mate !== undefined) return mate > 0 ? 100000 - mate : -100000 - mate;
    return cp;
  };

  // One UCI `info` line -> { mpv, depth, cp, mate, uci, nodes, bound } or null when it carries no score / pv.
  CV.sfParseInfo = function (line) {
    if (typeof line !== 'string' || !line.startsWith('info ')) return null;
    const sc = /\bscore (cp|mate) (-?\d+)/.exec(line), pv = / pv (\S+)/.exec(line), d = /\bdepth (\d+)/.exec(line);
    if (!sc || !pv || !d) return null;
    const mpv = /\bmultipv (\d+)/.exec(line), n = /\bnodes (\d+)/.exec(line);
    return {
      mpv: mpv ? +mpv[1] : 1, depth: +d[1], uci: pv[1], nodes: n ? +n[1] : 0,
      cp: sc[1] === 'cp' ? +sc[2] : null, mate: sc[1] === 'mate' ? +sc[2] : null,
      bound: line.includes(' lowerbound') ? 'lower' : line.includes(' upperbound') ? 'upper' : null,
    };
  };

  // The opponent's moves in the order a MultiPV search of the position they face ranked them (best for the opponent first),
  // followed by the other legal moves (in the order given). `lines`: Map or array of { uci, cp, mate } from the OPPONENT's view.
  CV.sfRankFromLines = function (legal, lines) {
    const arr = (lines instanceof Map ? [...lines.values()] : Array.from(lines || [])).filter((l) => l && l.uci && legal.includes(l.uci));
    arr.sort((a, b) => CV.sfScoreValue(b.cp, b.mate) - CV.sfScoreValue(a.cp, a.mate));
    const seen = new Set(), out = [];
    for (const l of arr) if (!seen.has(l.uci)) { seen.add(l.uci); out.push(l.uci); }
    for (const u of legal) if (!seen.has(u)) { seen.add(u); out.push(u); }
    return out;
  };

  // Ranking by the per-move scan: `scores` Map uci -> our score after that opponent move (null = game over, nothing to prepare).
  // Lowest first = best for the opponent; unscanned moves go last.
  CV.sfRankFromScan = function (legal, scores) {
    return legal.filter((u) => scores.get(u) !== null)
      .sort((x, y) => (scores.has(x) ? scores.get(x) : Infinity) - (scores.has(y) ? scores.get(y) : Infinity));
  };

  // ---- 2.0.0: delay-matched search (pure; content.js and background.js) ----
  // The bot waits max(human-like delay, engine time) anyway, so the full search may use the pause: the page draws the delay
  // BEFORE asking the engine and sends softMs = delay - SF_DELAY_MARGIN_MS - time already spent on this move. The margin
  // covers the message round trip and the engine's answer to `stop`, so the move is not later than in 1.8.0.
  CV.SF_DELAY_MARGIN_MS = 40;
  // AggroChess uses the same pause (CV.aggroBudget). false = the 1.8.0 AggroChess budget (thinkMs / the clock budget only).
  CV.AGGRO_DELAY_MATCH = true;
  CV.SF_DELAY_HARD_MIN_MS = 3000;       // hard cap of a delay-matched search without a user / clock cap: max(this, 3 x softMs)

  // Should a delay-matched Stockfish search be stopped now? Yes once the soft budget is used AND the minimum depth is
  // complete, or whatever the depth once the hard cap is reached. depthDone = depth of the latest exact MultiPV-1 line.
  CV.sfShouldStop = function ({ elapsedMs, softMs, depthDone, minDepth, hardMs }) {
    const e = Number(elapsedMs) || 0, soft = Math.max(0, Number(softMs) || 0), d = Number(depthDone) || 0;
    const min = Math.max(1, Number(minDepth) || 1), hard = Number(hardMs) > 0 ? Number(hardMs) : Infinity;
    return (e >= soft && d >= min) || e >= hard;
  };

  // Hard cap of a delay-matched search: the cap the page sent (sfMaxMs, already combined with the clock cap when
  // sfUseClock is on, see CV.sfSearchCap) when there is one, else max(SF_DELAY_HARD_MIN_MS, 3 x softMs).
  CV.sfHardMs = function (softMs, capMs) {
    const cap = Math.max(0, Math.round(Number(capMs)) || 0);
    if (cap > 0) return cap;
    return Math.max(CV.SF_DELAY_HARD_MIN_MS, 3 * Math.max(0, Math.round(Number(softMs)) || 0));
  };

  // AggroChess think budget. thinkMs = the fixed budget, softMs = the delay-matched budget from the page (0 = none),
  // clock = { soft, hard } from clock.js or null. Without a clock: { ms: max(thinkMs, softMs) }; with a clock:
  // { soft: max(clock soft, min(softMs, hard)), hard } - never above hard, so the clock rules stay intact.
  CV.AGGRO_BUDGET_MAX_MS = 60000;
  // spentMs (T10): time a quick look already used on this move when it turned out not obvious; it is taken off the think
  // time (floor 100 ms, or the clock soft when that is lower) so quick look + full think stay within the configured budget.
  CV.AGGRO_BUDGET_FLOOR_MS = 100;
  CV.aggroBudget = function ({ thinkMs, softMs, clock, spentMs }) {
    const max = CV.AGGRO_BUDGET_MAX_MS, floor = CV.AGGRO_BUDGET_FLOOR_MS;
    const extra = Math.max(0, Math.round(Number(softMs)) || 0);
    const spent = Math.max(0, Math.round(Number(spentMs)) || 0);
    if (clock && Number(clock.hard) > 0 && Number(clock.soft) > 0) {
      let hard = Math.min(max, Math.round(clock.hard));
      let soft = Math.min(hard, Math.round(clock.soft));
      if (spent) { const s0 = Math.max(Math.min(floor, soft), soft - spent); hard = Math.max(s0, hard - spent); soft = s0; }
      soft = Math.max(soft, Math.min(extra, hard));
      return { soft, hard };
    }
    let think = Math.max(floor, Math.min(max, Math.round(Number(thinkMs)) || 1000));
    if (spent) think = Math.max(floor, think - spent);
    return { ms: Math.min(max, Math.max(think, extra)) };
  };

  // The principal variation of an `info ... pv m1 m2 ...` line as an array ([] when there is none).
  CV.sfParsePv = function (line) {
    const m = / pv ((?:\S+ ?)+)$/.exec(String(line || '').trim());
    return m ? m[1].trim().split(/\s+/) : [];
  };

  // ---- 2.0.0: deepening passes while the opponent thinks (pure; background.js) ----
  CV.PONDER_OVERRUN_MS = 70;            // a search can overrun its ms a little (seen: +50 ms); never start one that could end late
  CV.PONDER_MIN_SLICE_MS = 80;          // no search shorter than this is worth using as a reply
  CV.PONDER_DEEPEN_MAX_SLICE_MS = 4000; // longest slice of a deepening pass
  // The reply searches of one pass: [{ uci, ms }], most likely opponent move first; [] = stop.
  //   pass 1    = the 1.8.0 reply queue: every ranked move, firstSlice each (the caller still clamps each slice to the deadline)
  //   pass k>=2 = the top K = min(ranked, max(2, 2 x workers)) moves again, slice min(4000, firstSlice x 2^(k-1))
  // Stops when the time left (leftMs, minus the overrun allowance) cannot fit PONDER_MIN_SLICE_MS, and, with a depth cap
  // (Stockfish 'depth' mode: every search is `go depth N ...`), after pass 1 once every top-K result already has depth >= N.
  CV.ponderDeepenPlan = function ({ ranked, results, pass, workers, firstSlice, leftMs, depthCap }) {
    const list = Array.isArray(ranked) ? ranked : [];
    const room = leftMs === undefined || leftMs === null ? Infinity : Number(leftMs) - CV.PONDER_OVERRUN_MS;
    if (!list.length || !(room >= CV.PONDER_MIN_SLICE_MS)) return [];
    const first = Math.max(CV.PONDER_MIN_SLICE_MS, Number(firstSlice) || CV.PONDER_MIN_SLICE_MS);
    const k = Math.max(1, Math.floor(Number(pass)) || 1);
    if (k === 1) return list.map((uci) => ({ uci, ms: first }));
    const top = list.slice(0, Math.min(list.length, Math.max(2, 2 * Math.max(1, Math.floor(Number(workers)) || 1))));
    const cap = Number(depthCap) || 0;
    if (cap > 0 && top.every((u) => results && results[u] && results[u].depth >= cap)) return [];
    const ms = Math.min(CV.PONDER_DEEPEN_MAX_SLICE_MS, first * Math.pow(2, k - 1), room);
    return ms >= CV.PONDER_MIN_SLICE_MS ? top.map((uci) => ({ uci, ms })) : [];
  };

  // ---- 2.0.2: AggroChess ponder workers ----
  // A ponder worker whose job ended or was cancelled while it had no request in flight goes back to the spares with its
  // hash (busy ones are terminated: a wasm think cannot be interrupted); a new game sends it `clear` before its next
  // job. false = 2.0.0: every AggroChess ponder worker is terminated when its job ends or is cancelled.
  CV.AGGRO_PONDER_RECYCLE = true;
  // The ranking pass of an AggroChess ponder job asks for 5-12 ms per opponent move; the engine's analyze() never
  // searched less than 20 ms, so a pass over 30 moves took >= 600 ms and ran out of its window (budget x 0.35) before the
  // last moves. 2.0.2 engines take a floor with the request (analyze_floor). 20 = 2.0.0.
  // Measured (tests/bench-ponder-rank.js, 80 positions, opponent AggroChess 150 ms, budget 1500): moves ranked in the
  // window 24.8 -> 33.5 of 33.9; opponent's move in the top 1 / 3 / 5 / 8: 44 / 68 / 73 / 75% -> 55 / 74 / 85 / 88%.
  CV.AGGRO_SCAN_FLOOR_MS = 3;
  // The watchdog's board read goes through the stable read (two reads a frame + 20 ms apart must agree), like a
  // mutation's. false = 2.0.0: the watchdog reads the board directly (content.js).
  CV.WATCHDOG_STABLE_READ = true;
  // 2.0.2 (A7): AggroChess workers that report `interruptible` (JSPI in the browser and a 2.0.2 engine) are stopped
  // instead of terminated: a cancelled job's busy worker is stopped and recycled like a Stockfish one, and a `late`
  // reply search far from done is stopped and its move used from this depth on. false = 2.0.0 (terminate).
  CV.AGGRO_INTERRUPT = true;
  CV.AGGRO_PARTIAL_MIN_DEPTH = 8;

  // ---- 2.0.2: ponder hits never lose depth (pure; background.js) ----
  // A prepared reply is often shallower than what the main worker reaches in the pause a hit is played after anyway
  // (Stockfish pass-1 replies: go depth N movetime slice, depth <= 10; PV seeds: depth - 2). The page draws that pause up
  // front and sends hitSoftMs = pause - SF_DELAY_MARGIN_MS - time spent; on a hit the background searches the position
  // on the main worker within hitSoftMs when that is expected to go deeper, and plays the deeper of the two results.
  CV.HIT_TOPUP_MIN_MS = 30;             // shorter than this, the main worker adds nothing (a fresh search, message round trips)
  // { search, ms, reason }. engine 'sf': search when expectedDepth (CV.expectedDepth of the recent main searches; null =
  // not known yet) is above storedDepth. engine 'aggro': search when hitSoftMs is at least storedMs, the slice the stored
  // reply was searched with (its depth is not comparable across budgets; 0 / unknown = search).
  CV.hitTopUp = function ({ engine, storedDepth, storedMs, hitSoftMs, expectedDepth }) {
    const ms = Math.max(0, Math.round(Number(hitSoftMs)) || 0);
    if (ms < CV.HIT_TOPUP_MIN_MS) return { search: false, ms, reason: 'no time' };
    if (engine === 'aggro') {
      const slice = Math.max(0, Number(storedMs) || 0);
      return slice > ms ? { search: false, ms, reason: 'slice longer' } : { search: true, ms, reason: 'pause >= slice' };
    }
    if (expectedDepth === null || expectedDepth === undefined) return { search: true, ms, reason: 'no model yet' };
    return Number(expectedDepth) > (Number(storedDepth) || 0) ? { search: true, ms, reason: 'deeper expected' } : { search: false, ms, reason: 'not deeper' };
  };
  // The depth a main search is expected to complete within ms: for each recent search (samples = [[[depth, ms], ...], ...],
  // the time each depth was completed at), the deepest depth done by ms; the median over the searches. null = no samples.
  CV.expectedDepth = function (samples, ms) {
    const list = (Array.isArray(samples) ? samples : []).filter((s) => Array.isArray(s) && s.length);
    if (!list.length) return null;
    const reach = list.map((s) => s.reduce((d, [depth, t]) => (t <= ms && depth > d ? depth : d), 0)).sort((a, b) => a - b);
    const n = reach.length;
    return n % 2 ? reach[(n - 1) / 2] : (reach[n / 2 - 1] + reach[n / 2]) / 2;
  };

  // ---- 2.0.0: AggroChess `late` with the move's reply search almost done (pure; background.js) ----
  // meta = { startedAt, ms } of the running reply search, mainBudgetMs = the think budget a normal search would get.
  // Returns how long to wait for that search (ms, >= 0), or null = do not wait (think from scratch as in 1.8.0). Waiting is
  // only worth it when the search ends (with its overrun allowance) within min(400, half the main budget).
  CV.LATE_WAIT_MAX_MS = 400;
  CV.lateWaitMs = function (meta, now, mainBudgetMs) {
    if (!meta || !Number.isFinite(Number(meta.startedAt)) || !(Number(meta.ms) > 0)) return null;
    const remaining = Number(meta.startedAt) + Number(meta.ms) + CV.PONDER_OVERRUN_MS - Number(now);
    const limit = Math.min(CV.LATE_WAIT_MAX_MS, 0.5 * Math.max(0, Number(mainBudgetMs) || 0));
    return remaining <= limit ? Math.max(0, Math.round(remaining)) : null;
  };

  // ---- 2.0.0: seeding the ponder table from the main search's principal variation (pure; background.js) ----
  // lastMainPv = { startFen, moves, pv, depth, ponder } of the last main Stockfish search: `moves` led to the position we
  // searched, pv[0] is the move we played, pv[1] the opponent's expected reply, pv[2] our answer to it. A reply from a
  // PV at depth d is worth a depth d - 2 search of the position after pv[1].
  CV.SF_PARTIAL_MIN_DEPTH = 8;          // shallower ponder replies are not used (also the harvest minimum in background.js)
  const pvFollows = (lmp, startFen, moves) => !!lmp && Array.isArray(lmp.pv) && lmp.pv.length >= 1 && Array.isArray(lmp.moves) &&
    Array.isArray(moves) && startFen === lmp.startFen && moves.length === lmp.moves.length + 1 &&
    lmp.moves.every((m, i) => moves[i] === m) && moves[moves.length - 1] === lmp.pv[0];
  // { opp, reply, depth } for an instant ponder result, or null: other start / other move played / PV too short / too shallow.
  CV.pvSeed = function (lmp, startFen, moves) {
    if (!pvFollows(lmp, startFen, moves) || lmp.pv.length < 3) return null;
    const depth = (Number(lmp.depth) || 0) - 2;
    if (depth < CV.SF_PARTIAL_MIN_DEPTH) return null;
    return { opp: lmp.pv[1], reply: lmp.pv[2], depth };
  };
  // The opponent move the main search expects (pv[1], else the `ponder` token of its bestmove), or null.
  CV.pvPredict = function (lmp, startFen, moves) {
    if (!pvFollows(lmp, startFen, moves)) return null;
    return lmp.pv[1] || lmp.ponder || null;
  };
  // `list` with `first` moved to the front (when it is in the list).
  CV.moveFirst = function (list, first) {
    return first && list.includes(first) ? [first, ...list.filter((u) => u !== first)] : list.slice();
  };

  // The `go` command of Stockfish's own time manager ('clock' mode, 2.0.0) from { wtime, btime, winc, binc } in ms, or null
  // when the clocks are not usable.
  CV.sfClockGo = function (c) {
    if (!c) return null;
    const n = (v) => Math.max(0, Math.round(Number(v)) || 0);
    const w = n(c.wtime), b = n(c.btime);
    if (!(w > 0) || !(b > 0)) return null;
    return 'go wtime ' + w + ' btime ' + b + ' winc ' + n(c.winc) + ' binc ' + n(c.binc);
  };

  // ---- allowed pages (allowed-pages.txt) ----
  // Turns the file's text into a list of normalised entries.
  CV.parseAllowlist = function (text) {
    return String(text || '').split(/\r?\n/)
      .map((l) => l.replace(/(^|\s)#.*$/, '').trim().toLowerCase())
      .filter(Boolean)
      .map((l) => l.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, ''))
      .filter(Boolean);
  };

  // True if host + path matches any entry (entry = page or anything below it; "*" is a wildcard).
  CV.matchPage = function (entries, hostname, pathname) {
    const page = (String(hostname).toLowerCase().replace(/^www\./, '') + String(pathname).toLowerCase()).replace(/\/+$/, '');
    return entries.some((e) => {
      const re = new RegExp('^' + e.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '(?:/.*)?$');
      return re.test(page);
    });
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CV;
})(typeof window !== 'undefined' ? window : globalThis);
