'use strict';
const api = typeof browser !== 'undefined' ? browser : chrome;

// ======================= Stockfish (UCI, WebAssembly with asm.js fallback) =======================
// SF_FILE: Stockfish.js 19, lite NNUE, single thread (no SharedArrayBuffer needed). Its loader and the .wasm of the
// same name (SF_WASM) are both in engine/. If it fails to start, SF_FALLBACK_FILE (asm.js, much slower) is used.
// Start order of every Stockfish worker: (1) engine/sf-worker.js, which loads the UNMODIFIED loader and hands it a wasm
// Module compiled once here (sfModuleFor), (2) the loader directly (it fetches and compiles the .wasm itself), (3) asm.js
// (main worker only). The threaded build SF_THREADED_FILE is used for the MAIN worker only, only when setting sfThreads > 1
// AND the runtime feature test (CV.sabSupport) passes; any failure there keeps the single-thread engine.
const SF_FILE = 'engine/stockfish-19-lite-single.js';
const SF_WASM = SF_FILE.replace(/\.js$/, '.wasm');
// 2.0.2 (B1): the same engine built with WebAssembly relaxed SIMD (its NNUE uses i32x4.relaxed_dot_i8x16_i7x16_add; same
// search, ~30% more nodes per second in Node). Used when WebAssembly.validate accepts RELAXED_PROBE (a module with that
// one instruction); any failure to compile or start it falls back to SF_FILE for good (sfDbg.rsimdFailed).
const SF_FILE_RSIMD = 'engine/stockfish-19-lite-single-rsimd.js';
const RELAXED_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 8, 1, 96, 3, 123, 123, 123, 1, 123, 3, 2, 1, 0, 10, 13, 1, 11, 0, 32, 0, 32, 1, 32, 2, 253, 147, 2, 11]);
const sfWasmOf = (file) => file.replace(/\.js$/, '.wasm');
const isSfSingle = (file) => file === SF_FILE || file === SF_FILE_RSIMD;
const SF_WRAPPER = 'engine/sf-worker.js';
const SF_THREADED_FILE = 'engine/stockfish-19-lite.js';
const SF_THREADED_WASM = SF_THREADED_FILE.replace(/\.js$/, '.wasm');
const SF_FALLBACK_FILE = 'engine/stockfish-19-asm.js';
const SF_THREADS = 1, SF_HASH_MB = 32;      // sent once after start-up
const SF_START_TIMEOUT_MS = 30000;          // no readyok within this long = the engine did not start
const SF_WRAPPER_TIMEOUT_MS = 15000;        // ... for the wrapper / shared-module start (then the direct loader is tried)
// "Imperfection" only considers alternatives within this many centipawns of the best line.
const IMPERFECTION_MARGIN_CP = 60;
const IMPERFECTION_LINES = 3; // MultiPV lines searched when imperfection > 0

let sf = null, sfReady = null, sfCurrent = null, sfNext = null;
let lastMainPv = null;  // 2.0.0: { startFen, moves, pv, depth, ponder } of the last main search (seeds the ponder table, CV.pvSeed)
let sfLast = null;      // 2.0.0: the last finished main search { mode, depthDone, softMs, hardMs, elapsedMs } (debug info)
const SF_CLOCK_EXTEND_MIN_MS = 30;  // 'clock' mode: a time-managed search that ends at least this long before softMs is continued
const SF_DELAY_GO = 'go depth 64';   // delay-matched search: effectively unbounded; stopped from JavaScript (CV.sfShouldStop)
let sfActive = null;    // engine file in use
let sfPrevCount = null; // pieces in the previous request; null = nothing searched yet (see CV.sfIsNewGame)
let sfMultiPvSent = null, sfThreadsSent = SF_THREADS;   // setoption is only sent when the value changes
const sfDbg = { moduleSendFailures: 0, workerStarts: 0, lastStart: null, harvested: 0, harvestFailed: 0, threadedFailed: null, threadedStarts: 0, pvSeeds: 0, rsimdFailed: null };
const sfRelaxedOk = (() => { try { return typeof WebAssembly !== 'undefined' && typeof WebAssembly.validate === 'function' && WebAssembly.validate(RELAXED_PROBE); } catch (e) { return false; } })();
// The single-thread builds to try, best first.
const sfCandidates = () => (sfRelaxedOk && !sfDbg.rsimdFailed ? [SF_FILE_RSIMD, SF_FILE] : [SF_FILE]);
const sfSab = (() => { try { return CV.sabSupport(typeof globalThis !== 'undefined' ? globalThis : {}); } catch (e) { return { ok: false, reason: 'test failed: ' + e, checks: {} }; } })();

// The .wasm compiled once (per build); every Stockfish worker that starts through the wrapper only instantiates it.
// Resolves a WebAssembly.Module, or null when compiling is not possible here (then every worker loads the file itself).
const sfModuleP = new Map();
const sfModuleInfo = { shared: false, ms: null, how: null, error: null, file: null, relaxedProbe: sfRelaxedOk };
function sfModuleFor(file) {
  file = file || SF_FILE;
  if (!sfModuleP.has(file)) {
    sfModuleP.set(file, (async () => {
      if (typeof WebAssembly === 'undefined' || typeof fetch === 'undefined') { sfModuleInfo.error = 'WebAssembly or fetch not available'; return null; }
      const t0 = Date.now(), url = api.runtime.getURL(sfWasmOf(file));
      try {
        let m;
        try { sfModuleInfo.how = 'compileStreaming'; m = await WebAssembly.compileStreaming(fetch(url)); }
        catch (e) { sfModuleInfo.how = 'arrayBuffer'; m = await WebAssembly.compile(await (await fetch(url)).arrayBuffer()); }
        sfModuleInfo.shared = true; sfModuleInfo.ms = Date.now() - t0; sfModuleInfo.file = file;
        return m;
      } catch (e) {
        if (file !== SF_FILE) { sfDbg.rsimdFailed = 'compile: ' + String((e && e.message) || e); return null; }
        sfModuleInfo.error = String((e && e.message) || e);
        console.error('[ChessVision] Stockfish: could not compile the module, workers will load the file themselves', e);
        return null;
      }
    })());
  }
  return sfModuleP.get(file);
}

// Starts one engine file and resolves { worker, notes } once it has answered `readyok` after the options were sent.
// Rejects on a worker error, a start timeout or a failure to create the worker.
// opts (all optional): wrapper + module = start SF_FILE through SF_WRAPPER with that compiled Module; hashMb; threads; timeoutMs.
function sfSpawn(file, opts) {
  opts = opts || {};
  const hashMb = opts.hashMb || SF_HASH_MB, threads = opts.threads || SF_THREADS;
  const viaWrapper = isSfSingle(file) && !!opts.wrapper;
  return new Promise((resolve, reject) => {
    let w = null, done = false, stage = 'uci';
    const spin = {};      // option name -> { min, max } for the spin options the engine lists
    const notes = [];     // what happened with the options, for the log
    const fail = (why) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { if (w) w.terminate(); } catch (e) { /* ignore */ }
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail('no readyok within ' + (opts.timeoutMs || SF_START_TIMEOUT_MS) + ' ms (waiting for ' + stage + ')'), opts.timeoutMs || SF_START_TIMEOUT_MS);
    try {
      // The wasm loader finds its .wasm from "#<url>,worker"; passing it explicitly avoids relying on location.origin.
      const wasmFile = file === SF_THREADED_FILE ? SF_THREADED_WASM : sfWasmOf(file);
      w = new Worker(api.runtime.getURL(viaWrapper ? SF_WRAPPER : file) + (isSfSingle(file) || file === SF_THREADED_FILE ? '#' + encodeURIComponent(api.runtime.getURL(wasmFile)) + ',worker' : ''));
    } catch (e) { return fail('could not create worker: ' + ((e && e.message) || e)); }
    w.onerror = (e) => fail('worker error: ' + ((e && e.message) || 'unknown'));
    w.onmessage = (e) => {
      if (done) return;
      const line = typeof e.data === 'string' ? e.data : '';
      if (stage === 'uci') {
        const m = /^option name (.+?) type spin default \S+ min (-?\d+) max (-?\d+)/.exec(line);
        if (m) spin[m[1]] = { min: +m[2], max: +m[3] };
        if (line === 'uciok') {
          stage = 'readyok';
          for (const [name, value] of [['Threads', threads], ['Hash', hashMb]]) {
            const o = spin[name];
            if (!o) notes.push(name + ': option not offered');
            else if (value < o.min || value > o.max) notes.push(name + ': ' + value + ' outside ' + o.min + '-' + o.max + ', not sent');
            else { w.postMessage('setoption name ' + name + ' value ' + value); notes.push(name + ' = ' + value + ' sent'); }
          }
          w.postMessage('isready');
        }
      } else if (/^no such option/i.test(line)) {
        notes.push('engine refused an option: ' + line);
      } else if (line === 'readyok') {
        done = true; clearTimeout(timer);
        resolve({ worker: w, notes });
      }
    };
    if (viaWrapper) {       // first message: the compiled module (null = the wrapper fetches the file itself)
      const init = { type: 'sfinit', module: opts.module || null, loader: file.replace(/^engine\//, '') };
      try { w.postMessage(init); }
      catch (e) { sfDbg.moduleSendFailures++; try { w.postMessage({ ...init, module: null }); } catch (e2) { return fail('could not start worker: ' + ((e2 && e2.message) || e2)); } }
    }
    w.postMessage('uci');
  });
}

// Every single-thread Stockfish worker (main and ponder): 2.0.2 the relaxed-SIMD build through the wrapper + its shared
// module when the probe validates, then the plain build through the wrapper + shared module, then the plain loader
// directly (then asm.js, main worker only, in initStockfish). Resolves { worker, notes, how, file }.
async function sfSpawnWasm(opts) {
  for (const file of sfCandidates()) {
    const module = await sfModuleFor(file);
    if (module) {
      try { const r = await sfSpawn(file, { ...opts, wrapper: true, module, timeoutMs: Math.min(SF_START_TIMEOUT_MS, SF_WRAPPER_TIMEOUT_MS) }); r.how = 'shared module'; r.file = file; return r; }
      catch (e) {
        if (file !== SF_FILE) { sfDbg.rsimdFailed = 'start: ' + ((e && e.message) || e); console.error('[ChessVision] Stockfish: the relaxed-SIMD build did not start (' + sfDbg.rsimdFailed + '); using ' + SF_FILE); continue; }
        console.error('[ChessVision] Stockfish: start through ' + SF_WRAPPER + ' failed (' + ((e && e.message) || e) + '); trying ' + SF_FILE + ' directly');
      }
    }
  }
  const r = await sfSpawn(SF_FILE, opts); r.how = 'direct'; r.file = SF_FILE; return r;
}

function sfAttach(worker) {
  sf = worker;
  sfMultiPvSent = null; sfThreadsSent = null;
  sf.onmessage = (e) => {
    const line = typeof e.data === 'string' ? e.data : '';
    if (line.startsWith('info ')) sfInfo(line);
    else if (line.startsWith('bestmove')) sfBestMove(line);
  };
  sf.onerror = (e) => console.error('[ChessVision] Stockfish error', e.message);
}

function initStockfish() {
  sfReady = (async () => {
    let r;
    try {
      r = await sfSpawnWasm();
      sfActive = r.file || SF_FILE;
    } catch (e) {
      console.error('[ChessVision] Stockfish: ' + SF_FILE + ' did not start (' + ((e && e.message) || e) + '); falling back to ' + SF_FALLBACK_FILE);
      r = await sfSpawn(SF_FALLBACK_FILE);
      sfActive = SF_FALLBACK_FILE;
    }
    // 2.0.0 (T10): warm the main worker like the ponder workers before sfReady resolves: the first search of a fresh engine
    // pays for its own lazy set-up. Measured in Node: ~20 ms here, first depth-10 search 56 -> 39 ms. Never fatal.
    sfDbg.mainWarmMs = await sfWarmMain(r.worker);
    sfAttach(r.worker);
    sfThreadsSent = SF_THREADS;
    sfDbg.workerStarts++; sfDbg.lastStart = { label: 'main', file: sfActive, how: r.how || 'direct' };
    // Threads missing on the asm fallback is expected (it is single-threaded); anything else is worth a look.
    const notes = sfActive === SF_FALLBACK_FILE ? r.notes.filter((n) => n !== 'Threads: option not offered') : r.notes;
    console.log('[ChessVision] Stockfish active:', sfActive, isSfSingle(sfActive) ? '(WebAssembly' + (r.how ? ', ' + r.how : '') + ')' : '(asm.js fallback)', notes.join('; '));
  })();
  sfReady.catch((e) => console.error('[ChessVision] Stockfish could not be started', e));
}

// go movetime SF_WARM_MS on SF_WARM_FEN, then ucinewgame + isready. Resolves the time it took, or null (timeout / error:
// the engine is used as it is).
function sfWarmMain(w) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stage = 'bestmove';
    const done = (v) => { clearTimeout(timer); w.onmessage = null; resolve(v); };
    const timer = setTimeout(() => done(null), SF_MAIN_WARM_TIMEOUT_MS);
    w.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (stage === 'bestmove' && line.startsWith('bestmove')) { stage = 'readyok'; w.postMessage('ucinewgame'); w.postMessage('isready'); }
      else if (stage === 'readyok' && line === 'readyok') done(Date.now() - t0);
    };
    try { w.postMessage('position fen ' + SF_WARM_FEN); w.postMessage('go movetime ' + SF_WARM_MS); } catch (e) { done(null); }
  });
}
const SF_MAIN_WARM_TIMEOUT_MS = 2000;

// Optional: the threaded build for the main worker (setting sfThreads > 1). Needs SharedArrayBuffer (runtime test, sfSab).
// Any failure keeps the single-thread engine and is remembered (no retry loop). Returns the thread count in use.
async function sfApplyThreads(setting) {
  const want = CV.sfThreadCount(setting, typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined, sfSab.ok);
  if (sfActive === SF_THREADED_FILE) {
    if (want !== sfThreadsSent && !sfCurrent) { sf.postMessage('setoption name Threads value ' + want); sfThreadsSent = want; }
    return sfThreadsSent;
  }
  if (want <= 1 || sfDbg.threadedFailed || sfCurrent || sfNext) return 1;
  try {
    const r = await sfSpawn(SF_THREADED_FILE, { threads: want });
    if (sfCurrent) { try { r.worker.terminate(); } catch (e) { /* ignore */ } return 1; }     // a search started meanwhile: keep the old engine
    const old = sf; sfAttach(r.worker); sfActive = SF_THREADED_FILE; sfThreadsSent = want; sfPrevCount = null;
    try { if (old) old.terminate(); } catch (e) { /* ignore */ }
    sfDbg.threadedStarts++; sfDbg.lastStart = { label: 'main', file: sfActive, how: 'threaded, Threads ' + want };
    console.log('[ChessVision] Stockfish threaded build active:', SF_THREADED_FILE, 'Threads', want, r.notes.join('; '));
    return want;
  } catch (e) {
    sfDbg.threadedFailed = String((e && e.message) || e);
    console.error('[ChessVision] Stockfish threaded build did not start (' + sfDbg.threadedFailed + '); keeping ' + sfActive);
    return 1;
  }
}

function sfStart(job) {
  sfCurrent = job;
  // The search state (hash table) is kept between the moves of one game; cleared only when a new game starts.
  if (CV.sfIsNewGame(sfPrevCount, job.fen)) sf.postMessage('ucinewgame');
  sfPrevCount = CV.sfPieceCount(job.fen);
  if (sfMultiPvSent !== job.multipv) { sf.postMessage('setoption name MultiPV value ' + job.multipv); sfMultiPvSent = job.multipv; }   // only when it changes
  sf.postMessage(CV.sfPositionCommand(job.fen, job.startFen, job.moves));   // with history: the engine sees repetitions / the 50-move counter
  job.startedAt = Date.now();
  if (job.mode === 'delay') {
    // 2.0.0 delay-matched search: no depth limit; stopped from here once softMs is used and the minimum depth is done, or at
    // hardMs. Checked on every info line and on timers (a search can be silent for a while).
    sf.postMessage(SF_DELAY_GO);
    job.softTimer = setTimeout(() => sfCheckStop(job), job.softMs);
    job.hardTimer = setTimeout(() => sfCheckStop(job), job.hardMs);
  } else if (job.mode === 'clock') {
    sf.postMessage(job.clockGo);
    job.hardTimer = setTimeout(() => sfCheckStop(job), job.hardMs);
  } else sf.postMessage(CV.sfGoCommand(job.depth, job.maxMs));
}

// Sends `stop` (once) when CV.sfShouldStop says so; the normal bestmove handling then resolves the job.
function sfCheckStop(job) {
  if (sfCurrent !== job || job.stopSent) return;
  if (job.mode === 'clock') { if (Date.now() - job.startedAt >= job.hardMs) { job.stopSent = true; sf.postMessage('stop'); } return; }
  if (job.mode !== 'delay') return;
  if (CV.sfShouldStop({ elapsedMs: Date.now() - job.startedAt, softMs: job.softMs, depthDone: job.depthDone, minDepth: job.depth, hardMs: job.hardMs })) {
    job.stopSent = true;
    sf.postMessage('stop');
  }
}
const sfClearTimers = (job) => { if (job) { clearTimeout(job.softTimer); clearTimeout(job.hardTimer); } };

// Keeps the deepest exact score/line for each MultiPV index of the running job, and (2.0.0) the depth and principal
// variation of the latest exact MultiPV-1 line: `depthDone` drives the delay-matched stop, `pv` seeds the ponder table.
function sfInfo(line) {
  const job = sfCurrent;
  if (!job) return;
  const p = CV.sfParseInfo(line);
  if (!p || p.bound) return;                                     // lowerbound / upperbound lines are not exact
  if (p.mpv === 1) { job.depthDone = p.depth; job.pv = CV.sfParsePv(line); job.pvDepth = p.depth; (job.depthAt || (job.depthAt = [])).push([p.depth, Date.now() - job.startedAt]); }
  if (job.multipv >= 2) job.lines.set(p.mpv, { uci: p.uci, depth: p.depth, cp: p.cp, mate: p.mate });
  if (job.mode === 'delay') sfCheckStop(job);
}

// Occasionally returns a near-best alternative instead of the best move. Never when a mate is found.
function chooseMove(job, best) {
  if (!job.imperfection || job.lines.size < 2) return best;
  const lines = [...job.lines.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  const top = lines[0];
  if (top.mate !== null && top.mate > 0) return best;
  if (top.cp === null) return best;
  if (Math.random() * 100 >= job.imperfection) return best;
  const alts = lines.slice(1).filter((l) => l.cp !== null && top.cp - l.cp <= IMPERFECTION_MARGIN_CP && l.uci !== best);
  return alts.length ? alts[Math.floor(Math.random() * alts.length)].uci : best;
}

function sfBestMove(line) {
  const parts = String(line).split(' ');
  const move = parts[1], ponderTok = parts[2] === 'ponder' ? parts[3] || null : null;
  const job = sfCurrent;
  // 'clock' mode: Stockfish's time manager answered before the human-like pause was used: keep searching the same position
  // as a delay-matched search until softMs (same job, same start time, the hash carries the tree over).
  if (job && job.mode === 'clock' && !job.stopSent && !sfNext && Date.now() - job.startedAt < job.softMs - SF_CLOCK_EXTEND_MIN_MS) {
    job.mode = 'delay'; job.extended = true;
    sf.postMessage(CV.sfPositionCommand(job.fen, job.startFen, job.moves));
    sf.postMessage(SF_DELAY_GO);
    clearTimeout(job.softTimer);
    job.softTimer = setTimeout(() => sfCheckStop(job), Math.max(0, job.softMs - (Date.now() - job.startedAt)));
    return;
  }
  sfCurrent = null;
  sfClearTimers(job);
  if (job) sfLast = { mode: job.mode + (job.extended ? ' (clock, extended)' : ''), depthDone: job.depthDone || 0, softMs: job.softMs, hardMs: job.hardMs, elapsedMs: Date.now() - job.startedAt, superseded: !!sfNext, topUp: !!job.topUp };
  if (job && job.mode === 'delay' && job.depthAt && job.depthAt.length) { sfDepthSamples.push(job.depthAt); if (sfDepthSamples.length > 8) sfDepthSamples.shift(); }   // 2.0.2: CV.expectedDepth
  if (sfNext) {
    const n = sfNext;
    sfNext = null;
    if (job) job.resolve(null); // superseded
    sfStart(n);
  } else if (job) {
    const chosen = chooseMove(job, move);
    job.resolve({ uci: chosen, best: move, imperfect: chosen !== move, depth: job.depthDone || 0, pv: job.pv || [], pvDepth: job.pvDepth || 0, ponder: ponderTok });
  }
}

// The real Stockfish request. `msg` (optional, 7th argument) carries the pondering fields (ponder, sfThreads).
async function analyzeStockfish(fen, depth, imperfection, maxMs, startFen, moves, msg) {
  aggroThinking++;                     // while a real search runs, no spare ponder worker is made (see ponderTopUp)
  try { return await analyzeStockfishNow(fen, depth, imperfection, maxMs, startFen, moves, msg || {}); } finally { aggroThinking--; ponderTopUp(); }
}
async function analyzeStockfishNow(fen, depth, imperfection, maxMs, startFen, moves, msg) {
  const t0 = Date.now();
  try { await sfReady; } catch (e) { return { error: 'Stockfish: could not start (' + ((e && e.message) || e) + ')' }; }
  // 1) a reply already found while pondering wins; anything else stops the ponder workers at once (stop + isready, never waited for)
  if (!msg.ponder) { if (ponderKind === 'sf') ponderCancel(); }
  else {
    const hist = typeof startFen === 'string' && Array.isArray(moves);
    const d = ponder.decide(hist ? startFen : null, hist ? moves : null);
    if (d.decision === 'hit') {
      // 2.0.0 harvest upgrade: a deepening pass may be searching exactly this move right now and already be deeper than the
      // stored reply. Stop it and use its bestmove if it answers within SF_HARVEST_MS; otherwise the stored reply.
      const opp = moves[moves.length - 1];
      const w = ponderKind === 'sf' ? ponderActive.find((x) => x.kind === 'sf' && x.task && x.task.key === opp && x.task.deepen && x.task.depth > (d.result.depth || 0)) : null;
      const tp = w && w.task.promise;
      ponderStop(); lastMainPv = null;
      let e = d.result;
      if (tp) {
        const res = await Promise.race([tp, new Promise((r) => setTimeout(() => r(null), SF_HARVEST_MS))]).catch(() => null);
        if (res && res.best && res.best !== '(none)' && res.key === opp && res.depth > (e.depth || 0)) { e = { uci: res.best, depth: res.depth }; ponderDbg.harvestUpgrades++; }
      }
      noteHitDepth(e.depth);
      const res = { uci: e.uci, best: e.uci, depth: e.depth, ponderHit: true };
      // 2.0.2 (C2): search on through the pause the page waits anyway when the main worker should get deeper
      const left = hitLeftMs(msg, t0);
      const plan = left > 0 ? CV.hitTopUp({ engine: 'sf', storedDepth: e.depth, hitSoftMs: left, expectedDepth: CV.expectedDepth(sfDepthSamples, left) }) : null;
      if (plan && plan.search) {
        res.topUp = startHitTopUp('sf', e, plan.ms, async () => {
          const r = await sfHitSearch(fen, startFen, moves, plan.ms);
          if (r && r.uci && r.pv && r.pv[0] === r.uci && r.depth > (e.depth || 0)) lastMainPv = { startFen, moves: moves.slice(), pv: r.pv.slice(), depth: r.pvDepth, ponder: r.ponder };
          return r ? { uci: r.uci, best: r.uci, depth: r.depth } : null;
        });
      }
      return res;
    }
    if (d.decision === 'late' && d.running && ponderKind === 'sf') {          // a worker is on exactly this move: take what it has if it is deep enough
      const opp = moves[moves.length - 1], w = ponderActive.find((x) => x.kind === 'sf' && x.task && x.task.key === opp), tp = w && w.task.promise;
      ponderStop();                                                           // halts the job, sends `stop` to every worker
      if (tp) {
        const res = await Promise.race([tp, new Promise((r) => setTimeout(() => r(null), SF_HARVEST_MS))]).catch(() => null);
        if (res && res.best && res.best !== '(none)' && res.depth >= SF_PARTIAL_MIN_DEPTH && res.key === opp) { sfDbg.harvested++; lastMainPv = null; noteHitDepth(res.depth); return { uci: res.best, best: res.best, depth: res.depth, ponderHit: true, partial: true }; }
        sfDbg.harvestFailed++;
      }
    }
    ponderCancel();                                                           // miss, late or no entry yet: the ponder workers never delay a real search
  }
  if (msg.sfThreads !== undefined) { try { await sfApplyThreads(msg.sfThreads); } catch (e) { /* keep the engine we have */ } }
  const res = await new Promise((resolve) => {
    const imp = Math.max(0, Math.min(100, imperfection || 0));
    const softMs = Math.max(0, Math.min(AGGRO_HARD_MAX_MS, Math.round(Number(msg.softMs)) || 0));
    const job = {
      fen, resolve, startFen: typeof startFen === 'string' ? startFen : null, moves: Array.isArray(moves) ? moves : null,
      depth: Math.max(1, Math.min(20, depth || 10)),
      maxMs: Math.max(0, Math.min(CV.LIMITS.sfMaxMs[1], Number(maxMs) || 0)),
      imperfection: imp,
      multipv: imp > 0 ? IMPERFECTION_LINES : 1,
      lines: new Map(),
      // 2.0.0: 'delay' = search through the human-like pause (softMs from the page, depth = minimum); 'depth' = 1.8.0.
      // A soft budget of 0 (no pause left, or a quick look) searches like 'depth'.
      // 'clock' (T9) = Stockfish's own time manager with both clocks; JS stops it at hardMs, and a search that ends before
      // softMs continues as a delay-matched search (the hash carries over), so the pause stays a lower bound.
      mode: msg.sfSearchMode === 'clock' && CV.sfClockGo(msg.uciClock) ? 'clock' : (msg.sfSearchMode === 'delay' || msg.sfSearchMode === 'clock') && softMs > 0 ? 'delay' : 'depth',
      clockGo: CV.sfClockGo(msg.uciClock),
      softMs, depthDone: 0, pv: [], pvDepth: 0,
    };
    job.hardMs = CV.sfHardMs(softMs, job.maxMs);
    if (sfCurrent) {
      if (sfNext) sfNext.resolve(null);
      sfNext = job;
      sf.postMessage('stop');
    } else {
      sfStart(job);
    }
  });
  // 2.0.0: remember the principal variation when the move played is its first move (no imperfection substitution); the
  // next ponder job takes pv[1] as the predicted opponent move and pv[2] as a ready reply (CV.pvSeed / CV.pvPredict).
  if (res && res.uci && !res.imperfect && typeof startFen === 'string' && Array.isArray(moves)) {
    const pv = res.pv && res.pv[0] === res.uci ? res.pv : res.ponder ? [res.uci, res.ponder] : null;
    lastMainPv = pv ? { startFen, moves: moves.slice(), pv: pv.slice(), depth: res.pv && res.pv[0] === res.uci ? res.pvDepth : 0, ponder: res.ponder } : null;
  } else if (res) lastMainPv = null;
  return res ? { uci: res.uci, best: res.best, imperfect: res.imperfect, depth: res.depth } : res;
}

// ======================= Ponder-hit top-up (2.0.2, C2) =======================
// On a ponder hit the page waits a human-like pause anyway (it drew it up front and sent hitSoftMs). When CV.hitTopUp
// says the main worker can get deeper than the prepared reply within that time, the hit is answered at once with the
// prepared move (provisional: the cursor aims at it) plus { topUp: { id, ms } }, and the main worker searches the same
// position meanwhile. The page asks for the final move ({ type: 'hitTopUp', id }) before it clicks: the deeper of the
// two (Stockfish: a deeper completed depth; AggroChess: at least the stored depth). Stockfish runs a delay-mode search
// (soft = hard = ms), AggroChess think(ms). While it runs no spare ponder worker is made (aggroThinking), as for any real search.
const hitJobs = new Map();
let hitSeq = 0;
const sfDepthSamples = [];      // [[depth, ms], ...] per recent delay-mode main search (CV.expectedDepth)
const hitLeftMs = (msg, t0) => Math.max(0, Math.min(AGGRO_HARD_MAX_MS, Math.round(Number(msg.hitSoftMs) || 0)) - (Date.now() - t0));
function startHitTopUp(engine, stored, ms, run) {
  const id = ++hitSeq;
  ponderDbg.topUps++;
  aggroThinking++;
  const p = (async () => {
    let r = null;
    try { r = await run(); } catch (e) { r = null; }
    const d0 = stored.depth || 0;
    const deeper = !!(r && r.uci && r.uci !== '(none)' && (engine === 'aggro' ? (r.depth || 0) >= d0 : (r.depth || 0) > d0));
    const out = deeper ? { ...r, before: d0, changed: r.uci !== stored.uci, used: true }
      : { uci: stored.uci, best: stored.uci, san: stored.san, sacrifice: stored.sacrifice, depth: d0, before: d0, changed: false, used: false };
    if (deeper) ponderDbg.topUpUsed++;
    if (out.changed) ponderDbg.hitChanged++;
    ponderDbg.topUpDepths.push([d0, out.depth || 0, r ? r.depth || 0 : null]);
    if (ponderDbg.topUpDepths.length > 20) ponderDbg.topUpDepths.shift();
    return out;
  })().finally(() => { aggroThinking--; ponderTopUp(); });
  hitJobs.set(id, p);
  while (hitJobs.size > 8) hitJobs.delete(hitJobs.keys().next().value);
  return { id, ms };
}
// The final move of a top-up (null when unknown); resolves when its search has ended.
function hitFinal(id) {
  const p = hitJobs.get(Number(id));
  hitJobs.delete(Number(id));
  return p || Promise.resolve(null);
}
// A delay-mode search of exactly ms on the main Stockfish worker (no minimum depth); resolves like analyzeStockfishNow's job.
function sfHitSearch(fen, startFen, moves, ms) {
  return new Promise((resolve) => {
    const job = { fen, resolve, startFen, moves, depth: 1, maxMs: 0, imperfection: 0, multipv: 1, lines: new Map(), mode: 'delay', clockGo: null,
      softMs: ms, hardMs: ms, depthDone: 0, pv: [], pvDepth: 0, topUp: true };
    if (sfCurrent) { if (sfNext) sfNext.resolve(null); sfNext = job; sf.postMessage('stop'); } else sfStart(job);
  });
}

// ======================= Icon download (brilliant layer c) =======================
// The page cannot read chess.com's icon images (another origin taints a canvas), the background page can fetch them with
// the host permission for chess.com's image domain and hands the bytes over. Only https images on chess.com domains.
const IMAGE_MAX_BYTES = 300 * 1024;
async function fetchImage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)(chess\.com|chesscomfiles\.com)$/.test(u.hostname)) return { ok: false, error: 'host not allowed' };
    const r = await fetch(u.href, { credentials: 'omit' });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength > IMAGE_MAX_BYTES) return { ok: false, error: 'too large' };
    return { ok: true, type: r.headers.get('content-type') || 'image/png', bytes };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// ======================= AggroChess (WebAssembly, Tal-style) =======================
// Two kinds of worker, both made by spawnAggroWorker (same failure handling):
//   main   - the real think / verify / ponderMove / clear requests. Never used for idle work.
//   ponder - 1-3 more workers for idle time (evaluation line and pondering; setting aggroPonderWorkers). wasm think()
//            blocks its worker and cannot be interrupted, and workers do not share a hash table, so cancelling = terminate()
//            of ALL of them; replacements are made (and warmed up) in advance, see the pool below.
// The .wasm is compiled once here (compileAggroModule) and the Module is posted to every worker, which only instantiates it.
const AGGRO_WORKER = 'engine/aggro-worker.js';
const AGGRO_WASM = 'engine/aggrochess.wasm';
const AGGRO_WASM_FALLBACK = 'aggrochess.wasm';        // file name inside engine/ that the worker loads itself when no module reaches it
const AGGRO_WASM_SIMD = 'engine/aggrochess-simd.wasm';   // same engine built with simd128; used when the browser validates SIMD, else AGGRO_WASM
// A tiny module that only validates where WebAssembly SIMD is supported (v128.const + i8x16.popcnt-style op).
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const PONDER_STEPPED = false;          // see runIdleJob: reply searches one depth at a time (think_depth). Off: not compared with think(ms) for strength.
const PONDER_STEP_MAX_DEPTH = 40;
const PONDER_STEP_MIN_MS = 15;         // no step is started with less time than this left in its slice
const AGGRO_START_TIMEOUT_MS = 15000;     // no 'ready' within this long = the worker did not start
const AGGRO_ERROR_COOLDOWN_MS = 15000;    // after a failed start, answer with the same error instead of re-creating at once
const AGGRO_THINK_FACTOR = 3;             // a think request may take this many times the requested ms ...
const AGGRO_THINK_MARGIN_MS = 4000;       // ... plus this, before the worker is declared stuck and re-created
const AGGRO_QUICK_REQ_MS = 3000;          // timeout for the cheap requests (position, ponderMove, clear)
const AGGRO_EVAL_MS = 300;                // budget of the idle evaluation line (inside the ponder time)
const AGGRO_HARD_MAX_MS = 60000;          // upper bound for any search budget that arrives in a message

// Creates one worker. Returns { ready, request(msg, timeoutMs), kill(), dead }.
// `ready` rejects on a worker 'error' message before 'ready', on worker.onerror and after AGGRO_START_TIMEOUT_MS.
function spawnAggroWorker(label, ttMb) {
  // 2.0.2 (C1): gen = the game (ponderGen) its hash belongs to; isReady once 'ready' arrived; searched = the positions
  // (history keys after an opponent move) whose replies it searched in its last job, so the next job can give the line
  // that was played to the worker whose hash holds it.
  const h = { kind: 'aggro', label, ttMb: ttMb || null, steps: false, worker: null, dead: false, pending: new Map(), seq: 0,
    gen: typeof ponderGen === 'number' ? ponderGen : 0, isReady: false, searched: new Set() };
  if (label === 'ponder') ponderDbg.aggroSpawns++;
  const failAll = (why) => {
    for (const [id, p] of h.pending) { h.pending.delete(id); clearTimeout(p.timer); p.reject(new Error(why)); }
  };
  h.ready = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, v) => { if (settled) return false; settled = true; clearTimeout(timer); fn(v); return true; };
    const fail = (why) => { settle(reject, new Error(why)); failAll(why); };
    const timer = setTimeout(() => fail('worker did not start within ' + AGGRO_START_TIMEOUT_MS + ' ms'), AGGRO_START_TIMEOUT_MS);
    try { h.worker = new Worker(api.runtime.getURL(AGGRO_WORKER)); } catch (e) { fail('could not create worker: ' + ((e && e.message) || e)); return; }
    h.worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'ready') { h.how = m.how || null; h.warmMs = m.warmMs; h.steps = !!m.steps; h.isReady = true; aggroDbg.workerStarts++; aggroDbg.lastStart = { label, how: h.how, warmMs: h.warmMs }; settle(resolve); return; }
      if (m.type === 'error' && !settled) { fail(m.message || 'worker error'); return; }
      const p = h.pending.get(m.id);
      if (m.type === 'error') console.error('[ChessVision] AggroChess (' + label + ') error', m.message);
      if (!p) return;
      h.pending.delete(m.id); clearTimeout(p.timer);
      if (m.type === 'error') p.reject(new Error(m.message || 'worker error')); else p.resolve(m);
    };
    h.worker.onerror = (e) => fail('worker error: ' + ((e && e.message) || 'unknown'));
    // First message: the compiled module (or null: the worker loads the file itself). If the Module cannot be cloned,
    // or compiling failed, send null so the worker falls back.
    aggroModuleFor().then((module) => {
      if (h.dead || settled) return;
      const init = { type: 'init', module, file: aggroModuleInfo.file || AGGRO_WASM_FALLBACK, ttMb: h.ttMb };
      try { h.worker.postMessage(init); }
      catch (e) {
        aggroDbg.moduleSendFailures++;
        try { h.worker.postMessage({ ...init, module: null }); } catch (e2) { fail('could not start worker: ' + ((e2 && e2.message) || e2)); }
      }
    });
  });
  h.ready.catch(() => {});      // a start failure is reported by whoever awaits ready; never an unhandled rejection
  // Posts a message and resolves with the worker's reply. Rejects on timeout or when the worker fails.
  h.request = (msg, timeoutMs) => new Promise((resolve, reject) => {
    if (h.dead) { reject(new Error('worker was terminated')); return; }
    const id = ++h.seq;
    const timer = setTimeout(() => { h.pending.delete(id); reject(new Error('no answer within ' + timeoutMs + ' ms')); }, timeoutMs);
    h.pending.set(id, { resolve, reject, timer, think: msg.type === 'think' });
    try { h.worker.postMessage({ ...msg, id }); } catch (e) { h.pending.delete(id); clearTimeout(timer); reject(e); }
  });
  h.kill = () => {
    if (h.dead) return;
    h.dead = true;
    try { if (h.worker) h.worker.terminate(); } catch (e) { /* ignore */ }
    failAll('worker was terminated');
  };
  // 2.0.2 (C1): a request in flight = the worker is (or is about to be) inside wasm and cannot be interrupted.
  h.busy = () => h.pending.size > 0;
  // A new game began since this worker's last search: empty its hash before the next request (messages run in order).
  h.newGame = (gen) => { h.gen = gen; h.request({ type: 'clear' }, AGGRO_QUICK_REQ_MS).catch(() => {}); };
  return h;
}

let aggroMain = null, aggroFailure = null;     // aggroFailure = { message, at }: why the last start failed
const aggroDbg = { verifyChecks: 0, verifyWarnings: 0, lastVerify: null, restarts: 0, moduleSendFailures: 0, workerStarts: 0, lastStart: null };

// Compiles aggrochess.wasm once; resolves { module, ms, how, error }. Never rejects: module is null when compiling is not
// possible here (no WebAssembly / fetch, a fetch or compile error) and every worker then loads the file itself.
let aggroModuleP = null;
const aggroModuleInfo = { shared: false, ms: null, how: null, error: null, file: null, simd: false };
function aggroSimdOk() { try { return typeof WebAssembly !== 'undefined' && typeof WebAssembly.validate === 'function' && WebAssembly.validate(SIMD_PROBE); } catch (e) { return false; } }
async function compileFile(file) {
  const url = api.runtime.getURL(file);
  try { aggroModuleInfo.how = 'compileStreaming'; return await WebAssembly.compileStreaming(fetch(url)); }
  catch (e) {                                          // wrong MIME type or no streaming: compile the bytes
    aggroModuleInfo.how = 'arrayBuffer';
    return await WebAssembly.compile(await (await fetch(url)).arrayBuffer());
  }
}
function aggroModuleFor() {
  if (!aggroModuleP) {
    aggroModuleP = (async () => {
      if (typeof WebAssembly === 'undefined' || typeof fetch === 'undefined') { aggroModuleInfo.error = 'WebAssembly or fetch not available'; return null; }
      const t0 = Date.now();
      let m = null;
      if (aggroSimdOk()) {                                // the SIMD build, if this browser can run it; any problem -> the plain build
        try { m = await compileFile(AGGRO_WASM_SIMD); aggroModuleInfo.file = AGGRO_WASM_SIMD; aggroModuleInfo.simd = true; }
        catch (e) { aggroModuleInfo.error = 'simd build: ' + String((e && e.message) || e); m = null; }
      }
      try {
        if (!m) { m = await compileFile(AGGRO_WASM); aggroModuleInfo.file = AGGRO_WASM; aggroModuleInfo.simd = false; }
        aggroModuleInfo.shared = true; aggroModuleInfo.ms = Date.now() - t0;
        return m;
      } catch (e) {
        aggroModuleInfo.error = String((e && e.message) || e);
        console.error('[ChessVision] AggroChess: could not compile the module, workers will load the file themselves', e);
        return null;
      }
    })();
  }
  return aggroModuleP;
}

// The main worker, created on demand. Throws the last start error while it is cooling down.
function aggroGet() {
  if (aggroFailure && Date.now() - aggroFailure.at < AGGRO_ERROR_COOLDOWN_MS) throw new Error(aggroFailure.message);
  if (!aggroMain || aggroMain.dead) {
    if (aggroMain) aggroDbg.restarts++;
    aggroMain = spawnAggroWorker('main');
    const h = aggroMain;
    h.ready.then(() => { if (aggroFailure) aggroFailure = null; }, (e) => {
      aggroFailure = { message: (e && e.message) || String(e), at: Date.now() };
      console.error('[ChessVision] AggroChess could not start', e);
      h.kill();
    });
  }
  return aggroMain;
}
function initAggro() { try { aggroGet(); } catch (e) { /* cooling down: nothing to start */ } }

// What think wants: the fen/moves of the request (history when reliable, else the bare FEN as a set-up position).
function aggroPosition(msg) {
  const hist = typeof msg.startFen === 'string' && msg.startFen && Array.isArray(msg.moves);
  if (!hist) return { fen: msg.fen, moves: [] };
  return { fen: msg.startFen === CV.STANDARD_START_FEN ? undefined : msg.startFen, moves: msg.moves };   // from the standard start: no fen (opening book)
}
const posFor = (startFen, moves) => ({ fen: startFen === CV.STANDARD_START_FEN ? undefined : startFen, moves });

const aggroResult = (m) => (m && m.type === 'bestmove' && m.uci
  ? { uci: m.uci, best: m.uci, san: m.san, sacrifice: !!m.sacrifice, depth: m.depth, score: m.score } : null);

// Compares the engine's idea of the position with chessmini's; returns a warning text or null. Never throws.
async function aggroVerifyPosition(h, msg) {
  try {
    const p = aggroPosition(msg);
    const r = await h.request({ type: 'position', ...p }, AGGRO_QUICK_REQ_MS);
    const hist = typeof msg.startFen === 'string' && Array.isArray(msg.moves);
    const mine = hist ? CV.replayUci(msg.startFen, msg.moves) : { ok: true, pos: CV.chess.parseFen(msg.fen) };
    if (!mine.ok) return 'verify skipped: the move history does not replay';
    const mineLegal = CV.chess.legalMoves(mine.pos).map((m) => m.uci).sort().join(' ');
    const theirs = (r.legal || []).map((m) => m.uci).sort().join(' ');
    aggroDbg.verifyChecks++;
    let warn = null;
    if (!r.ok) warn = 'engine rejected the position';
    else if (r.stm !== mine.pos.turn) warn = 'side to move differs (engine ' + r.stm + ', page ' + mine.pos.turn + ')';
    else if (mineLegal !== theirs) warn = 'legal moves differ (engine ' + (r.legal || []).length + ', page ' + mineLegal.split(' ').filter(Boolean).length + ')';
    if (warn) { aggroDbg.verifyWarnings++; console.warn('[ChessVision] AggroChess verify:', warn); }
    aggroDbg.lastVerify = warn || 'ok';
    return warn;
  } catch (e) { return null; }     // a verify problem must never block play
}

// ---- pondering: state (pure, in settings.js) and the idle job ----
// While the opponent thinks, the ponder workers work through a list of opponent moves (one shared queue: whichever worker
// is free takes the next move) and keep, for each one, the reply it found. The whole job stays inside the ponder time.
// When the opponent moves, whatever was already found is used.
const PONDER_SCAN_MS = 12;          // ranking pass: a very short search after each legal opponent move
const PONDER_SCAN_SHARE = 0.35;     // the ranking pass may use at most this share of the ponder time
const PONDER_OVERRUN_MS = CV.PONDER_OVERRUN_MS;       // 70: a search can overrun its ms a little (seen: +50 ms); never start one that could end late
const PONDER_MIN_SLICE_MS = CV.PONDER_MIN_SLICE_MS;   // 80: no search shorter than this is worth using as a reply
const PONDER_SLICE_MIN_MS = 120, PONDER_SLICE_MAX_MS = 600;
const ponder = CV.createPonderState();
let idleToken = 0, idleInfo = { pondering: false, evalLine: null };
// 2.0.0 debug: passes of the latest ponder job, and the depth of the reply used on each recent hit (newest last)
// AggroChess reply searches in flight (2.0.0, `late` wait): opponent move -> { promise, w, token } of the think request
const aggroRunning = new Map();
const ponderDbg = { lastPasses: 0, hitDepths: [], harvestUpgrades: 0, lateWaits: 0, lateWaitHits: 0,
  // 2.0.2 (C1): AggroChess ponder workers created / recycled with their hash / terminated (busy); ponder jobs; workers a
  // job got that were still starting (cold); jobs whose first worker had searched the line that was played (warm line)
  aggroSpawns: 0, aggroRecycled: 0, aggroKilled: 0, jobs: 0, claimCold: 0, claimWarmLine: 0,
  // 2.0.2 (C2): ponder-hit top-ups started / whose result was deeper and used / that changed the move; the last 20 as
  // [depth of the prepared reply, depth played, depth the top-up reached]
  topUps: 0, topUpUsed: 0, hitChanged: 0, topUpDepths: [] };
const noteHitDepth = (d) => { ponderDbg.hitDepths.push(d || 0); if (ponderDbg.hitDepths.length > 20) ponderDbg.hitDepths.shift(); };

// The job's ceiling (ms): the *PonderMs budget (1.8.0), or with ponderUntilMove (2.0.0) max(budget, ponderMaxMs): the job
// then keeps deepening until the opponent moves (any real search cancels it) or this ceiling.
function ponderCeiling(msg, budget) {
  if (!msg.ponderUntilMove) return budget;
  const lim = CV.LIMITS.ponderMaxMs;
  return Math.max(budget, Math.min(lim[1], Math.max(lim[0], Number(msg.ponderMaxMs) || CV.DEFAULTS.ponderMaxMs)));
}

// Reply searches of one ponder job, pass by pass (2.0.0). Pass 1 is the 1.8.0 reply queue (every ranked move, one slice
// each, most likely first). With `until`, more passes follow from CV.ponderDeepenPlan (the likely moves again with longer
// slices) until the token changes or the deadline. A pass starts when the previous one has finished (its results feed the
// planner). Worker affinity: a move is given back to the worker that searched it last while that worker is free (its hash
// holds that tree), otherwise to any free worker.
//   claim(w) -> { u, ms, pass, done() } | null; done() must be called when that search ended (finally).
// opts: { token, ranked, firstSlice, left(), until, workers, depthCap, single, skipFirst() }
function createReplyPasses(opts) {
  let pass = 0, queue = [], running = 0, waiters = [];
  const lastWorker = new Map(), busy = new Set();
  const wake = () => { const w = waiters; waiters = []; for (const r of w) r(); };
  const nextPass = () => {
    if (pass >= 1 && !opts.until) return false;
    const p = ponder.get();
    let items = CV.ponderDeepenPlan({ ranked: opts.ranked, results: p ? p.results : null, pass: pass + 1, workers: opts.workers.length, firstSlice: opts.firstSlice, leftMs: opts.left(), depthCap: pass >= 1 ? opts.depthCap : 0 });
    if (pass === 0 && opts.skipFirst) { const skip = opts.skipFirst(); if (skip) items = items.filter((it) => it.uci !== skip); }
    if (!items.length) return false;
    pass++; queue = items;
    if (pass > 1) ponderDbg.lastPasses = pass - 1;
    return true;
  };
  const free = (w) => !w.dead && !busy.has(w) && opts.workers.includes(w);
  return {
    passes: () => pass,
    async claim(w) {
      for (;;) {
        if (opts.token !== idleToken) return null;
        if (queue.length) {
          let i = queue.findIndex((it) => lastWorker.get(it.uci) === w);
          if (i < 0) i = queue.findIndex((it) => { const lw = lastWorker.get(it.uci); return !lw || !free(lw); });
          if (i < 0) i = 0;
          const it = queue.splice(i, 1)[0];
          const room = opts.left() - PONDER_OVERRUN_MS;
          const ms = opts.single ? room : Math.min(it.ms, room);
          if (ms < PONDER_MIN_SLICE_MS) { queue = []; continue; }        // nothing fits any more
          running++; busy.add(w); lastWorker.set(it.uci, w);
          let ended = false;
          return { u: it.uci, ms, pass, done: () => { if (ended) return; ended = true; running--; busy.delete(w); if (!running) wake(); } };
        }
        if (running > 0) { await new Promise((r) => waiters.push(r)); continue; }    // the pass is still finishing on other workers
        if (!nextPass()) { ponderDbg.lastPasses = Math.max(0, pass); wake(); return null; }
      }
    },
  };
}

// ---- the ponder worker pool ----
// ponderActive: the workers of the running job. ponderSpares: idle workers that are already instantiated AND warmed up, so
// the next job starts at once; together they never exceed ponderCap (the setting, capped by the CPU count). A spare is
// only made while pondering / the evaluation line is on (ponderWanted) and while no real search is running, because
// instantiating and warming a worker would take CPU from that search.
let ponderActive = [], ponderSpares = [];
let ponderCap = 1, ponderWanted = false, ponderSpawnFailedAt = 0;
// 1.8.0: the same pool also holds Stockfish workers (kind 'sf', see the Stockfish ponder section). ponderKind is the kind the
// current settings want; spares of the other kind are killed. Stockfish workers are cancelled with `stop` instead of being
// terminated, so for a moment they are neither active nor spare: ponderCancelling counts them against the cap.
let ponderKind = 'aggro', ponderCancelling = [], ponderGen = 0;
let ponderHashMb = 32;          // hash table size of the ponder workers (setting aggroPonderHashMb; the main worker always uses the engine's 32)
let aggroThinking = 0;          // real searches in flight

const ponderSpawn = () => (ponderKind === 'sf' ? spawnSfWorker('ponder', ponderHashMb) : spawnAggroWorker('ponder', ponderHashMb));
function ponderTopUp() {
  ponderSpares = ponderSpares.filter((w) => !w.dead);
  if (!ponderWanted) { for (const w of ponderSpares) w.kill(); ponderSpares = []; return; }
  for (const w of ponderSpares) if (w.ttMb !== ponderHashMb || w.kind !== ponderKind) w.kill();   // made for another hash size / another engine
  ponderSpares = ponderSpares.filter((w) => !w.dead);
  while (ponderActive.length + ponderSpares.length + ponderCancelling.length > ponderCap && ponderSpares.length) ponderSpares.pop().kill();   // setting lowered
  if (aggroThinking > 0 || Date.now() - ponderSpawnFailedAt < AGGRO_ERROR_COOLDOWN_MS) return;
  while (ponderActive.length + ponderSpares.length + ponderCancelling.length < ponderCap) {
    const w = ponderSpawn();
    w.ready.then(null, () => { ponderSpawnFailedAt = Date.now(); w.kill(); ponderSpares = ponderSpares.filter((x) => x !== w); });
    ponderSpares.push(w);
  }
}
// n workers for a job: warmed spares first, then new ones. The caller never asks for more than ponderCap.
// prefer (2.0.2, optional): a history key; a spare whose last job searched that position comes first (its hash holds
// the line that was played, and the first worker of a job searches the first reply).
function ponderClaim(n, prefer) {
  for (const w of ponderSpares) if (w.ttMb !== ponderHashMb || w.kind !== ponderKind) w.kill();
  ponderSpares = ponderSpares.filter((w) => !w.dead);
  if (prefer) {
    const i = ponderSpares.findIndex((w) => w.searched && w.searched.has(prefer));
    if (i > 0) ponderSpares.unshift(ponderSpares.splice(i, 1)[0]);
    if (i >= 0) ponderDbg.claimWarmLine++;
  }
  const got = [];
  while (got.length < n && ponderSpares.length) got.push(ponderSpares.shift());
  while (got.length < n) got.push(ponderSpawn());
  for (const w of got) {
    if (w.gen !== ponderGen) w.newGame(ponderGen);       // a new game began since this worker last searched (sf: ucinewgame, aggro: clear)
    if (w.kind === 'aggro') { if (!w.isReady) ponderDbg.claimCold++; w.searched = new Set(); }
  }
  ponderActive.push(...got);
  return got;
}
// 2.0.2 (C1): an AggroChess job worker is done with this job. Idle (no request in flight): back to the spares with its
// hash, like a Stockfish worker; busy (a wasm think running, which cannot be interrupted): terminated. A worker that is
// not wanted any more (pondering off, another engine or hash size, cap reached) is terminated too.
// CV.AGGRO_PONDER_RECYCLE = false: every job worker is terminated (2.0.0); ponderTopUp makes warm replacements.
function aggroRelease(w) {
  ponderActive = ponderActive.filter((x) => x !== w);
  if (w.dead) return;
  ponderSpares = ponderSpares.filter((x) => !x.dead && x !== w);
  const keep = CV.AGGRO_PONDER_RECYCLE && !w.busy() && ponderWanted && ponderKind === 'aggro' && w.ttMb === ponderHashMb &&
    ponderActive.length + ponderSpares.length + ponderCancelling.length < ponderCap;
  if (!keep) { w.kill(); ponderDbg.aggroKilled++; return; }
  ponderSpares.push(w);
  ponderDbg.aggroRecycled++;
}
function ponderDrop(w) {          // a job worker is finished: Stockfish workers are stopped and recycled, AggroChess ones recycled when idle (aggroRelease)
  if (w.kind === 'sf') { sfRelease(w); return; }
  aggroRelease(w);
}
function ponderFail(w) {          // a job worker failed (error, timeout): never reused
  if (w.kind === 'sf') { sfRelease(w); return; }
  w.kill();
  ponderActive = ponderActive.filter((x) => x !== w);
}
// The effective number of ponder workers for a setting value: the setting, but at most max(1, hardwareConcurrency - 1).
const ponderEffectiveCount = (setting) => CV.ponderWorkerCount(setting, typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined);

function ponderStop() {             // stop working (ALL job workers), keep what was found (used after a hit)
  idleToken++;
  idleInfo.pondering = false;
  const act = ponderActive;
  ponderActive = [];
  for (const w of act) { if (w.kind === 'sf') sfRelease(w, true); else aggroRelease(w); }   // 2.0.2: idle AggroChess workers are kept
  ponder.setRunning(null);
  ponderTopUp();
}
function ponderCancel() {           // stop and forget everything
  ponderStop();
  ponder.invalidate();
  idleInfo = { pondering: false, evalLine: null };
}

function formatEval(a, myColor) {
  if (!a || a.none) return null;
  const mineSign = myColor === 'b' ? -1 : 1;                 // the worker reports White's point of view
  const v = a.value * mineSign;
  const score = a.kind === 'mate' ? (v < 0 ? '-M' : '+M') + Math.abs(a.value) : (v >= 0 ? '+' : '\u2212') + (Math.abs(v) / 100).toFixed(2);
  return 'Eval ' + score + ' (you) d' + a.depth + ' \u00b7 opp best ' + (a.bestSan || a.bestUci) + (a.book ? ' (book)' : '');
}

// Score of an analysis from OUR point of view (higher = better for us); mates become +-100000.
function ourScore(a, myColor) {
  const v = a.value * (myColor === 'b' ? -1 : 1);
  return a.kind === 'mate' ? (v > 0 ? 100000 - Math.abs(a.value) : -100000 + Math.abs(a.value)) : v;
}

// The idle job: after our move, while the opponent thinks. Runs detached; every step re-checks its token.
async function runIdle(msg, token) {
  if (msg.ponder) idleInfo.pondering = true;                   // the job has started (the workers may still be loading)
  try { await runIdleJob(msg, token); } finally { if (token === idleToken) idleInfo.pondering = false; }
}
async function runIdleJob(msg, token) {
  const t0 = Date.now();
  const budget = Math.max(200, Math.min(AGGRO_HARD_MAX_MS, Number(msg.ponderMs) || 1500));
  const deadline = t0 + ponderCeiling(msg, budget);              // 2.0.0: up to ponderMaxMs with ponderUntilMove
  const left = () => deadline - Date.now();
  ponderDbg.lastPasses = 0;
  const main = aggroGet();
  await main.ready;
  let predicted = null;
  try {
    const r = await main.request({ type: 'ponderMove', ...posFor(msg.startFen, msg.moves) }, AGGRO_QUICK_REQ_MS);
    predicted = r.uci && r.uci !== 'none' ? r.uci : null;      // a hint for ranking only
  } catch (e) { predicted = null; }
  if (token !== idleToken) return;
  const after = CV.replayUci(msg.startFen, msg.moves);
  if (!after.ok) return;
  const legal = CV.chess.legalMoves(after.pos);                // the opponent's possible moves

  // the workers of this job: ponderCap of them when pondering, one for the evaluation line alone. 2.0.2: a recycled
  // worker that searched the opponent's move just played (the position before our move) comes first.
  if (msg.ponder) ponderDbg.jobs++;
  const pool = ponderClaim(msg.ponder ? Math.max(1, ponderCap) : 1, msg.moves.length >= 1 ? CV.ponderKey(msg.startFen, msg.moves.slice(0, -1)) : null);
  const doPonder = !!msg.ponder && legal.length > 0;
  if (doPonder) ponder.begin(msg.startFen, msg.moves, legal.map((m) => m.uci));
  const req = (w, m, ms) => w.request(m, ms * AGGRO_THINK_FACTOR + AGGRO_THINK_MARGIN_MS + 200);

  // shared queue 1 - ranking: how good is each opponent move for the opponent? (a very short search after each)
  const scoreOf = new Map();
  const scanMs = Math.max(5, Math.min(PONDER_SCAN_MS, Math.floor((budget * PONDER_SCAN_SHARE) / Math.max(1, legal.length))));
  let scanEnd = null;                                          // the ranking window starts with the first ranking search (2.0.0: the predicted reply may come first)
  const rank = { next: 0, pending: 0, ended: false };
  let rankedList = null, resolveRanked = null;
  const ranked = new Promise((r) => { resolveRanked = r; });
  const finishRanking = () => {
    if (rankedList || !rank.ended || rank.pending > 0) return;
    rankedList = legal.map((m) => m.uci).filter((u) => scoreOf.get(u) !== null)
      .sort((x, y) => (scoreOf.has(x) ? scoreOf.get(x) : Infinity) - (scoreOf.has(y) ? scoreOf.get(y) : Infinity));
    resolveRanked();
  };
  const rankClaim = () => {
    if (scanEnd === null) scanEnd = Date.now() + budget * PONDER_SCAN_SHARE;
    if (!rank.ended && (rank.next >= legal.length || Date.now() > scanEnd || left() < PONDER_OVERRUN_MS || token !== idleToken)) rank.ended = true;
    if (rank.ended) { finishRanking(); return null; }
    rank.pending++;
    return legal[rank.next++];
  };
  // shared queue 2 - replies, most likely opponent move first, each with its own slice; nothing starts after the deadline
  const slice = Math.max(PONDER_SLICE_MIN_MS, Math.min(PONDER_SLICE_MAX_MS, Math.round(budget / 6)));
  let replyNext = 0;
  // 2.0.0: AggroChess's own predicted move gets its reply first, on the first worker that is ready, while the others start
  // ranking; the reply queue then skips it.
  const predictedOk = doPonder && !!predicted && legal.some((m) => m.uci === predicted);
  let predictedTaken = false, passes = null;
  const getPasses = () => passes || (passes = createReplyPasses({ token, ranked: rankedList, firstSlice: slice, left, until: !!msg.ponderUntilMove,
    workers: pool, depthCap: 0, single: false, skipFirst: () => (predictedTaken ? predicted : null) }));
  const replySearch = async (w, c) => {
    ponder.addRunning(c.u, { startedAt: Date.now(), ms: c.ms });
    if (w.searched) w.searched.add(CV.ponderKey(msg.startFen, [...msg.moves, c.u]));
    try {
      if (PONDER_STEPPED && w.steps) {                      // one depth at a time: every finished depth is a usable (partial) reply
        const sliceEnd = Date.now() + c.ms;
        for (let d = 1; d <= PONDER_STEP_MAX_DEPTH; d++) {
          const ms = Math.min(sliceEnd - Date.now(), left() - PONDER_OVERRUN_MS);
          if (ms < PONDER_STEP_MIN_MS || token !== idleToken) break;
          const r = await req(w, { type: 'think', ...posFor(msg.startFen, [...msg.moves, c.u]), depth: d, ms }, ms);
          if (token !== idleToken) return;
          const res = aggroResult(r);
          if (!res) break;
          ponder.addResult(c.u, { ...res, ms: c.ms });
          if (res.depth < d || /^mate/.test(String(res.score))) break;   // cut by the clock, or a forced mate: deeper adds nothing
        }
      } else {
        const p = req(w, { type: 'think', ...posFor(msg.startFen, [...msg.moves, c.u]), ms: c.ms }, c.ms);
        const run = { promise: p, w, token };
        aggroRunning.set(c.u, run);                           // a real search may wait for exactly this one (`late`, CV.lateWaitMs)
        let r;
        try { r = await p; } finally { if (aggroRunning.get(c.u) === run) aggroRunning.delete(c.u); }
        if (token !== idleToken) return;
        const res = aggroResult(r);
        if (res) ponder.addResult(c.u, { ...res, ms: c.ms });
      }
    } finally { ponder.removeRunning(c.u); }
  };

  const work = async (w, first) => {
    try {
      await w.ready;
      if (token !== idleToken) return;
      idleInfo.pondering = !!msg.ponder;
      if (predictedOk && !predictedTaken) {                    // the first ready worker: the predicted move's reply before anything else
        const ms = Math.min(slice, left() - PONDER_OVERRUN_MS);
        if (ms >= PONDER_MIN_SLICE_MS) { predictedTaken = true; await replySearch(w, { u: predicted, ms }); }
        if (token !== idleToken) return;
      }
      if (first && msg.showEval) {                             // the evaluation line runs on the first worker, the others start ranking meanwhile
        const next = predicted && legal.some((m) => m.uci === predicted) ? predicted : undefined;
        const a = await req(w, { type: 'analyze', ...posFor(msg.startFen, msg.moves), ms: AGGRO_EVAL_MS, next }, AGGRO_EVAL_MS);
        if (token === idleToken) idleInfo.evalLine = formatEval(a, msg.myColor);
      }
      if (!doPonder) return;
      for (let m = rankClaim(); m; m = rankClaim()) {
        try {
          const a = await req(w, { type: 'analyze', ...posFor(msg.startFen, [...msg.moves, m.uci]), ms: scanMs, floor: CV.AGGRO_SCAN_FLOOR_MS }, scanMs);
          if (!a || a.none) scoreOf.set(m.uci, null);          // we would have no move there (game over): nothing to prepare
          else scoreOf.set(m.uci, ourScore(a, msg.myColor) - (m.uci === predicted ? 30 : 0));   // lowest = best for the opponent
        } finally { rank.pending--; finishRanking(); }
      }
      await ranked;                                            // the replies are taken in ranked order, so wait for the last ranking search
      for (let c = await getPasses().claim(w); c; c = await getPasses().claim(w)) {
        try { await replySearch(w, c); } finally { c.done(); }
        if (token !== idleToken) return;
      }
    } catch (e) {
      if (token === idleToken) { console.error('[ChessVision] AggroChess ponder worker stopped', e); ponderFail(w); }   // the other workers go on
    }
  };
  try {
    await Promise.all(pool.map((w, i) => work(w, i === 0)));
  } finally {
    if (token === idleToken) {
      ponder.setRunning(null); idleInfo.pondering = false;
      for (const w of pool) ponderDrop(w);                     // finished or failed: free the workers, keep the results
      ponderTopUp();                                           // ... and warm replacements for the next job
    }
  }
}

function aggroIdle(msg) {
  if (msg.engine === 'stockfish') return sfIdle(msg);
  ponderKind = 'aggro';
  ponderWanted = !!(msg.ponder || msg.showEval);               // before ponderCancel: its top-up uses these
  ponderCap = msg.ponder ? ponderEffectiveCount(msg.ponderWorkers) : 1;
  ponderHashMb = CV.sanitize({ aggroPonderHashMb: msg.ponderHashMb }).aggroPonderHashMb || CV.DEFAULTS.aggroPonderHashMb;
  ponderCancel();
  const token = idleToken;
  if (!(msg.ponder || msg.showEval) || typeof msg.startFen !== 'string' || !Array.isArray(msg.moves)) return { state: 'off' };
  runIdle(msg, token).catch((e) => { if (token === idleToken) console.error('[ChessVision] AggroChess idle job failed', e); });
  return { state: 'started' };
}

// The real request. Never throws: failures come back as { error } .
async function analyzeAggro(msg) {
  aggroThinking++;                     // while a real search runs, no spare ponder worker is made (see ponderTopUp)
  try { return await analyzeAggroNow(msg); } finally { aggroThinking--; ponderTopUp(); }
}
async function analyzeAggroNow(msg) {
  const t0 = Date.now();
  try {
    // 1) an answer already found while pondering wins; anything else stops the ponder worker at once
    const hist = typeof msg.startFen === 'string' && Array.isArray(msg.moves);
    // the think budget (pure, CV.aggroBudget): a fixed budget, or the clock budget (soft/hard) when the page sent one; 2.0.0:
    // stretched to the human-like pause (msg.softMs) when that is longer, never above the clock's hard limit. T10: a quick
    // look that turned out not obvious already used msg.spentMs of the think time.
    const b = CV.aggroBudget({ thinkMs: msg.ms, softMs: msg.softMs, spentMs: msg.spentMs, clock: Number(msg.hard) > 0 && Number(msg.soft) > 0 ? { soft: msg.soft, hard: msg.hard } : null });
    if (!msg.ponder) ponderCancel();
    else {
      const d = ponder.decide(hist ? msg.startFen : null, hist ? msg.moves : null);
      if (d.decision === 'hit') {
        ponderStop(); const e = d.result; noteHitDepth(e.depth);
        const res = { uci: e.uci, best: e.uci, san: e.san, sacrifice: e.sacrifice, depth: e.depth, ponderHit: true };
        // 2.0.2 (C2): think(pause) on the main worker when the pause is at least the slice the reply was searched with
        const left = hitLeftMs(msg, t0);
        const plan = left > 0 ? CV.hitTopUp({ engine: 'aggro', storedDepth: e.depth, storedMs: e.ms, hitSoftMs: left }) : null;
        if (plan && plan.search) {
          res.topUp = startHitTopUp('aggro', e, plan.ms, async () => {
            const h = aggroGet();
            await h.ready;
            const r = await h.request({ type: 'think', ...aggroPosition(msg), ms: plan.ms }, plan.ms * AGGRO_THINK_FACTOR + AGGRO_THINK_MARGIN_MS);
            return aggroResult(r);
          });
        }
        return res;
      }
      // 2.0.0 `late`: a ponder worker is on exactly this move and almost done. Wait for it (bounded) instead of thinking from
      // scratch; the other ponder workers are killed at once. This is the only case where a real search waits for pondering.
      const opp = hist ? msg.moves[msg.moves.length - 1] : null;
      const run = d.decision === 'late' && d.running && ponderKind === 'aggro' ? aggroRunning.get(opp) : null;
      const wait = run && run.token === idleToken ? CV.lateWaitMs(d.runningMeta, Date.now(), b.hard ? b.soft : b.ms) : null;
      if (wait !== null) {
        ponderDbg.lateWaits++;
        idleToken++; idleInfo.pondering = false;              // the job stops taking work; only this worker keeps running
        for (const x of ponderActive.filter((y) => y !== run.w)) aggroRelease(x);   // 2.0.2: idle ones are kept, busy ones terminated
        const r = await Promise.race([run.promise.catch(() => null), new Promise((res) => setTimeout(() => res(null), wait + 100))]);
        aggroRelease(run.w); ponder.setRunning(null);         // answered: kept; still searching: terminated
        const res = aggroResult(r);
        if (res) { ponderDbg.lateWaitHits++; ponderCancel(); noteHitDepth(res.depth); return { ...res, ponderHit: true, late: true }; }
      }
      ponderCancel();                                          // miss, late or no entry yet: the ponder workers never delay a real think
    }
    const h = aggroGet();
    await h.ready;
    // 2) older requests' results would be stale
    for (const [id, p] of h.pending) { if (p.think) { h.pending.delete(id); clearTimeout(p.timer); p.resolve({ type: 'bestmove', uci: null }); } }
    const warn = msg.verify ? await aggroVerifyPosition(h, msg) : null;
    // 3) think with the budget computed above
    const pos = aggroPosition(msg);
    const req = b.hard ? { type: 'think', ...pos, soft: b.soft, hard: b.hard, ms: b.hard } : { type: 'think', ...pos, ms: b.ms };
    const reqMs = b.hard ? req.hard : req.ms;
    aggroDbg.lastBudget = b;
    const r = await h.request(req, reqMs * AGGRO_THINK_FACTOR + AGGRO_THINK_MARGIN_MS).catch((e) => {
      if (/no answer within/.test(e.message)) { h.kill(); if (aggroMain === h) aggroMain = null; }   // wasm think() blocks: only a new worker helps
      throw e;
    });
    const res = aggroResult(r);
    if (res && warn) res.verifyWarning = warn;
    return res;
  } catch (e) {
    const why = (e && e.message) || String(e);
    console.error('[ChessVision] AggroChess:', why);
    return { error: 'AggroChess: ' + why };
  }
}

// ======================= Stockfish pondering (1.8.0) =======================
// The same pool (ponderActive / ponderSpares / ponderCap, one shared `ponder` state, one idle token) now also runs Stockfish
// workers. Differences from AggroChess, all because Stockfish can be stopped while it searches and keeps its hash:
//   - a worker is cancelled with `stop` + `isready` (about 20 ms) and goes back to the spares; terminate() is only the escape
//     hatch when it does not answer within SF_STOP_TIMEOUT_MS. The MAIN Stockfish worker is never used for idle work.
//   - ranking: ONE MultiPV search of the position the opponent faces ranks their moves (SF_RANK_MODE 'multipv'), or, as before
//     for AggroChess, a very short search after every legal move ('scan'). Chosen with tests/bench-stockfish.js (--only rank).
//   - a reply search that is still running when the opponent plays exactly that move can be stopped and used if it already
//     reached SF_PARTIAL_MIN_DEPTH (the final bestmove belongs to exactly that position).
const SF_RANK_MODE = 'multipv';        // 'multipv' | 'scan'
const SF_RANK_LINES = 8;               // MultiPV lines of the ranking search (at most the number of legal moves)
const SF_RANK_MS = 120;                // ... and its time
const SF_SCAN_MS = 20;                 // 'scan' mode: time per legal opponent move
const SF_WARM_FEN = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';   // a non-book middlegame, as for AggroChess
const SF_WARM_MS = 10;                 // warm-up search before a worker counts as ready
const SF_STOP_TIMEOUT_MS = 1500;       // no bestmove / readyok after `stop` + `isready` within this long = terminate the worker
const SF_SEARCH_MARGIN_MS = 3000;      // a search may take its movetime plus this before the worker is declared stuck
const SF_PARTIAL_MIN_DEPTH = CV.SF_PARTIAL_MIN_DEPTH;   // 8: a stopped reply search is used only if it reached this depth (also the PV seed minimum)
const SF_HARVEST_MS = 150;             // ... and `stop` must answer within this long (a real search never waits longer)
const SF_PONDER_SCAN_SHARE = 0.35;     // the ranking pass may use at most this share of the ponder time

// One Stockfish ponder worker: { kind:'sf', ready, search(), cancel(), newGame(gen), kill(), dead, task }.
// At most one search is in flight; `task` is set from `go` until its `bestmove`. A new `go` is only sent after the previous
// bestmove (and, after a cancel, a readyok), so a bestmove can never be taken for another position's.
function spawnSfWorker(label, hashMb) {
  const h = { kind: 'sf', label, ttMb: hashMb || null, worker: null, dead: false, task: null, syncWait: null, multipv: null, gen: ponderGen, how: null, warmMs: null };
  h.kill = () => {
    if (h.dead) return;
    h.dead = true;
    try { if (h.worker) h.worker.terminate(); } catch (e) { /* ignore */ }
    if (h.task) { const t = h.task; h.task = null; clearTimeout(t.timer); t.reject(new Error('worker was terminated')); }
    if (h.syncWait) { const x = h.syncWait; h.syncWait = null; clearTimeout(x.timer); x.resolve(false); }
  };
  // isready -> readyok; false after the timeout (the caller terminates)
  h.sync = (ms) => new Promise((resolve) => {
    if (h.dead) { resolve(false); return; }
    const x = { resolve, timer: setTimeout(() => { h.syncWait = null; resolve(false); }, ms) };
    h.syncWait = x;
    try { h.worker.postMessage('isready'); } catch (e) { clearTimeout(x.timer); h.syncWait = null; resolve(false); }
  });
  const onLine = (line) => {
    if (line === 'readyok') { const x = h.syncWait; if (x) { h.syncWait = null; clearTimeout(x.timer); x.resolve(true); } return; }
    const t = h.task;
    if (!t) return;
    if (line.startsWith('info ')) { const p = CV.sfParseInfo(line); if (p && !p.bound) { t.lines.set(p.mpv, p); if (p.mpv === 1) t.depth = p.depth; } return; }
    if (line.startsWith('bestmove')) {
      h.task = null; clearTimeout(t.timer);
      t.resolve({ best: line.split(' ')[1], depth: t.depth, lines: t.lines, stopped: t.stopped, key: t.key });
    }
  };
  h.ready = (async () => {
    const r = await sfSpawnWasm({ hashMb });             // 2.0.2: the same build order as the main worker
    h.how = r.how; h.file = r.file;
    if (h.dead) { try { r.worker.terminate(); } catch (e) { /* ignore */ } throw new Error('worker was terminated'); }
    h.worker = r.worker;
    h.worker.onmessage = (e) => onLine(typeof e.data === 'string' ? e.data : '');
    h.worker.onerror = (e) => { console.error('[ChessVision] Stockfish (' + label + ') error', e && e.message); h.kill(); };
    // warm-up: the first search of a fresh engine pays for its own lazy set-up; do it before the worker counts as ready
    const t0 = Date.now();
    h.worker.postMessage('ucinewgame');
    if (!(await h.sync(SF_STOP_TIMEOUT_MS))) throw new Error('no readyok after ucinewgame');
    await h.search(SF_WARM_FEN, [], 'go movetime ' + SF_WARM_MS, 'warm');
    h.worker.postMessage('ucinewgame');
    if (!(await h.sync(SF_STOP_TIMEOUT_MS))) throw new Error('no readyok after the warm-up');
    h.warmMs = Date.now() - t0;
    sfDbg.workerStarts++; sfDbg.lastStart = { label, file: h.file, how: h.how, warmMs: h.warmMs };
  })();
  h.ready = h.ready.catch((e) => { h.kill(); throw e; });      // a worker that failed to start or warm up is never reused
  h.ready.catch(() => {});
  // Searches one position. key = what the result is for (an opponent move, 'rank', 'warm'); movetime comes from `go`.
  h.search = (startFen, moves, go, key, multipv, extra) => new Promise((resolve, reject) => {
    if (h.dead || !h.worker) { reject(new Error('worker was terminated')); return; }
    if (h.task) { reject(new Error('worker is busy')); return; }
    const ms = Number((/movetime (\d+)/.exec(go) || [])[1]) || 1000;
    const t = { key, lines: new Map(), depth: 0, stopped: false, ...(extra || {}) };   // extra: { deepen } (2.0.0, the harvest upgrade)
    let settle; t.promise = new Promise((res) => { settle = res; });      // resolves with the result, or null when the search failed (cancel() and the harvest wait on it)
    t.resolve = (v) => { resolve(v); settle(v); };
    t.reject = (e) => { reject(e); settle(null); };
    t.timer = setTimeout(() => { h.task = null; t.reject(new Error('no answer within ' + (ms + SF_SEARCH_MARGIN_MS) + ' ms')); h.kill(); }, ms + SF_SEARCH_MARGIN_MS);
    h.task = t;
    try {
      const mpv = multipv || 1;
      if (h.multipv !== mpv) { h.worker.postMessage('setoption name MultiPV value ' + mpv); h.multipv = mpv; }
      h.worker.postMessage(CV.sfPositionCommand(startFen, startFen, moves));
      h.worker.postMessage(go);
    } catch (e) { h.task = null; clearTimeout(t.timer); t.reject(e); }
  });
  // stop + isready. true = idle again; false = it did not answer and was terminated.
  h.cancel = async () => {
    if (h.dead) return false;
    const t = h.task;
    if (t) {
      t.stopped = true;
      try { h.worker.postMessage('stop'); } catch (e) { h.kill(); return false; }
      const got = await Promise.race([t.promise, new Promise((r) => setTimeout(() => r(null), SF_STOP_TIMEOUT_MS))]).catch(() => null);
      if (!got) { h.kill(); return false; }
    }
    if (!(await h.sync(SF_STOP_TIMEOUT_MS))) { h.kill(); return false; }
    return true;
  };
  h.newGame = (gen) => { h.gen = gen; try { if (h.worker && !h.dead) h.worker.postMessage('ucinewgame'); } catch (e) { /* ignore */ } };   // runs in order, before the next position
  return h;
}

// A job worker is finished or the job was cancelled: stop it, wait for readyok (it never blocks anyone: only the worker is
// busy), then it is a warm spare again, or it is killed when it did not answer / is no longer wanted.
async function sfRelease(w) {
  ponderActive = ponderActive.filter((x) => x !== w);
  if (ponderCancelling.includes(w) || w.dead) return;
  ponderCancelling.push(w);
  let ok = false;
  try { ok = await w.cancel(); } catch (e) { ok = false; }
  ponderCancelling = ponderCancelling.filter((x) => x !== w);
  if (!ok || w.dead) { w.kill(); ponderTopUp(); return; }
  ponderSpares = ponderSpares.filter((x) => !x.dead);
  if (!ponderWanted || ponderKind !== 'sf' || w.ttMb !== ponderHashMb || ponderActive.length + ponderSpares.length + ponderCancelling.length >= ponderCap) { w.kill(); return; }
  ponderSpares.push(w);
}

// The idle job for Stockfish: after our move, while the opponent thinks. Detached; every step re-checks its token.
async function runIdleSf(msg, token) {
  idleInfo.pondering = true;
  try { await runIdleSfJob(msg, token); } finally { if (token === idleToken) idleInfo.pondering = false; }
}
async function runIdleSfJob(msg, token) {
  const t0 = Date.now();
  const budget = Math.max(200, Math.min(AGGRO_HARD_MAX_MS, Number(msg.ponderMs) || 1500));
  const deadline = t0 + ponderCeiling(msg, budget), left = () => deadline - Date.now();   // 2.0.0: up to ponderMaxMs with ponderUntilMove
  ponderDbg.lastPasses = 0;
  const after = CV.replayUci(msg.startFen, msg.moves);
  if (!after.ok) return;
  const legal = CV.chess.legalMoves(after.pos).map((m) => m.uci);          // the opponent's possible moves
  if (!legal.length) return;
  const depth = Math.max(1, Math.min(CV.LIMITS.depth[1], Number(msg.depth) || CV.DEFAULTS.depth));
  const mode = legal.length < 2 ? 'single' : SF_RANK_MODE;
  const pool = ponderClaim(Math.max(1, ponderCap));
  ponder.begin(msg.startFen, msg.moves, legal);
  // 2.0.0: the main search's PV is a free first result (an instant hit candidate) and a prediction: pv[1] goes first.
  const seed = CV.pvSeed(lastMainPv, msg.startFen, msg.moves);
  if (seed && legal.includes(seed.opp) && ponder.addResult(seed.opp, { uci: seed.reply, depth: seed.depth, ms: 0 })) sfDbg.pvSeeds++;
  const predicted = CV.pvPredict(lastMainPv, msg.startFen, msg.moves);
  const goFor = (ms) => CV.sfGoCommand(depth, ms);
  const req = (w, startFen, moves, ms, key, mpv) => w.search(startFen, moves, goFor(ms), key, mpv);
  // 2.0.0: pass 1 keeps the 1.8.0 search (go depth N movetime slice: many moves, quickly); deepening passes have no depth
  // cap in 'delay' / 'clock' mode (go movetime ms). In 'depth' mode they keep the cap and stop once everything has depth N.
  const depthMode = !(msg.sfSearchMode === 'delay' || msg.sfSearchMode === 'clock');
  const goPass = (pass, ms) => (pass >= 2 && !depthMode ? 'go movetime ' + Math.max(1, Math.round(ms)) : goFor(ms));

  const slice = Math.max(PONDER_SLICE_MIN_MS, Math.min(PONDER_SLICE_MAX_MS, Math.round(budget / 6)));
  // ranking: lists the opponent's moves, most likely first
  const scoreOf = new Map();
  const rank = { owner: null, next: 0, pending: 0, ended: false };
  let rankedList = null, resolveRanked = null;
  const ranked = new Promise((r) => { resolveRanked = r; });
  const setRanked = (list) => { if (!rankedList) { rankedList = CV.moveFirst(list, predicted); resolveRanked(); } };
  if (mode === 'single') setRanked(legal.slice());
  let passes = null;
  const getPasses = () => passes || (passes = createReplyPasses({ token, ranked: rankedList, firstSlice: slice, left, until: !!msg.ponderUntilMove,
    workers: pool, depthCap: depthMode ? depth : 0, single: mode === 'single' }));
  const scanMs = Math.max(5, Math.min(SF_SCAN_MS, Math.floor((budget * SF_PONDER_SCAN_SHARE) / Math.max(1, legal.length))));
  const scanEnd = t0 + budget * SF_PONDER_SCAN_SHARE;
  const scanClaim = () => {
    if (!rank.ended && (rank.next >= legal.length || Date.now() > scanEnd || left() < PONDER_OVERRUN_MS || token !== idleToken)) rank.ended = true;
    if (rank.ended) { if (rank.pending === 0) setRanked(CV.sfRankFromScan(legal, scoreOf)); return null; }
    rank.pending++;
    return legal[rank.next++];
  };
  // replies: most likely opponent move first, each with its own slice; nothing starts after the deadline (createReplyPasses;
  // one legal move: think about it for the whole time)

  const work = async (w) => {
    try {
      await w.ready;
      if (token !== idleToken) return;
      idleInfo.pondering = true;
      if (mode === 'multipv') {
        if (!rank.owner) {                                      // the first worker that is ready ranks; the others wait for the list
          rank.owner = w;
          const k = Math.min(legal.length, SF_RANK_LINES), ms = Math.max(30, Math.min(SF_RANK_MS, Math.floor(budget * SF_PONDER_SCAN_SHARE)));
          try {
            const r = await w.search(msg.startFen, msg.moves, 'go movetime ' + ms, 'rank', k);   // not depth-limited: the ranking should use its time
            if (token !== idleToken) return;
            setRanked(CV.sfRankFromLines(legal, r.lines));
          } catch (e) { setRanked(legal.slice()); throw e; }    // unranked (legal order) so the others still work; this worker drops out
        }
      } else if (mode === 'scan') {
        for (let m = scanClaim(); m; m = scanClaim()) {
          try {
            const r = await req(w, msg.startFen, [...msg.moves, m], scanMs, 'scan');
            if (token !== idleToken) return;
            const top = r.lines.get(1);
            scoreOf.set(m, !r.best || r.best === '(none)' || !top ? null : CV.sfScoreValue(top.cp, top.mate));   // our score (we are to move): lowest = best for the opponent
          } finally { rank.pending--; if (rank.ended && rank.pending === 0) setRanked(CV.sfRankFromScan(legal, scoreOf)); }
        }
      }
      await ranked;
      for (let c = await getPasses().claim(w); c; c = await getPasses().claim(w)) {
        ponder.addRunning(c.u, { startedAt: Date.now(), ms: c.ms });
        try {
          const r = await w.search(msg.startFen, [...msg.moves, c.u], goPass(c.pass, c.ms), c.u, undefined, { deepen: c.pass >= 2 });
          if (token !== idleToken) return;
          if (!r.stopped && r.best && r.best !== '(none)') ponder.addResult(c.u, { uci: r.best, depth: r.depth, ms: c.ms });
        } finally { ponder.removeRunning(c.u); c.done(); }
      }
    } catch (e) {
      if (token === idleToken) { console.error('[ChessVision] Stockfish ponder worker stopped', e); ponderDrop(w); }   // the other workers go on
    }
  };
  try {
    await Promise.all(pool.map((w) => work(w)));
  } finally {
    if (token === idleToken) {
      ponder.setRunning(null); idleInfo.pondering = false;
      for (const w of pool) ponderDrop(w);                     // finished or failed: stop them (they stay warm), keep the results
      ponderTopUp();
    }
  }
}

function sfIdle(msg) {
  ponderKind = 'sf';
  ponderWanted = !!msg.ponder;                                 // before ponderCancel: its top-up uses these
  ponderCap = msg.ponder ? ponderEffectiveCount(msg.ponderWorkers) : 1;
  ponderHashMb = CV.sanitize({ sfPonderHashMb: msg.ponderHashMb }).sfPonderHashMb || CV.DEFAULTS.sfPonderHashMb;
  ponderCancel();
  const token = idleToken;
  if (!msg.ponder || typeof msg.startFen !== 'string' || !Array.isArray(msg.moves)) return { state: 'off' };
  runIdleSf(msg, token).catch((e) => { if (token === idleToken) console.error('[ChessVision] Stockfish idle job failed', e); });
  return { state: 'started' };
}

// New game (or the panel's button): clear the hash of the main worker and forget the ponder state.
function aggroClear() {
  ponderGen++;                         // Stockfish ponder workers send ucinewgame before their next job (see ponderClaim)
  ponderCancel();
  if (aggroMain && !aggroMain.dead) aggroMain.request({ type: 'clear' }, AGGRO_QUICK_REQ_MS).catch(() => {});
}
function clearEngines() {
  aggroClear();
  if (sf && !sfCurrent) sf.postMessage('ucinewgame');         // Stockfish: new game now ...
  else sfPrevCount = null;                                    // ... or before its next search if it is busy
}

// ======================= Allowed pages =======================
// Content scripts can't read extension files directly, so the background page serves the list.
let allowlistText = null;
async function loadAllowlist() {
  if (allowlistText === null) {
    try {
      allowlistText = await (await fetch(api.runtime.getURL('allowed-pages.txt'))).text();
    } catch (e) {
      console.error('[ChessVision] could not read allowed-pages.txt', e);
      return '';
    }
  }
  return allowlistText;
}

// ======================= Messaging =======================
api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'allowlist') return loadAllowlist();
  if (msg && msg.type === 'fetchImage') return fetchImage(msg.url);
  if (msg && msg.type === 'aggroClear') { aggroClear(); return Promise.resolve({ ok: true }); }
  if (msg && msg.type === 'clearEngines') { clearEngines(); return Promise.resolve({ ok: true }); }
  if (msg && msg.type === 'aggroInvalidate') { ponderWanted = false; ponderCancel(); return Promise.resolve({ ok: true }); }   // also frees the spares
  if (msg && msg.type === 'aggroIdle') return Promise.resolve(aggroIdle(msg));
  if (msg && msg.type === 'hitTopUp') return hitFinal(msg.id);
  if (msg && msg.type === 'aggroIdleStatus') return Promise.resolve({ pondering: idleInfo.pondering, evalLine: idleInfo.evalLine, found: ponder.found() });
  if (msg && msg.type === 'aggroDebug') {
    return Promise.resolve({ ponder: { ...ponder.counters, passes: ponderDbg.lastPasses, hitDepths: ponderDbg.hitDepths.slice(), harvestUpgrades: ponderDbg.harvestUpgrades, lateWaits: ponderDbg.lateWaits, lateWaitHits: ponderDbg.lateWaitHits,
      hitTopUp: { started: ponderDbg.topUps, used: ponderDbg.topUpUsed, changed: ponderDbg.hitChanged, depths: ponderDbg.topUpDepths.slice() },
      aggroWorkers: { jobs: ponderDbg.jobs, spawns: ponderDbg.aggroSpawns, respawnsPerMove: ponderDbg.jobs ? +(ponderDbg.aggroSpawns / ponderDbg.jobs).toFixed(2) : null, recycled: ponderDbg.aggroRecycled, killed: ponderDbg.aggroKilled, coldClaims: ponderDbg.claimCold, warmLineFirst: ponderDbg.claimWarmLine, recycle: !!CV.AGGRO_PONDER_RECYCLE } },
      verify: { checks: aggroDbg.verifyChecks, warnings: aggroDbg.verifyWarnings, last: aggroDbg.lastVerify },
      aggroWorkerAlive: !!(aggroMain && !aggroMain.dead), aggroRestarts: aggroDbg.restarts, aggroFailure: aggroFailure ? aggroFailure.message : null,
      ponderPool: { cap: ponderCap, active: ponderActive.filter((w) => !w.dead).length, spares: ponderSpares.filter((w) => !w.dead).length, wanted: ponderWanted },
      module: { ...aggroModuleInfo, sendFailures: aggroDbg.moduleSendFailures }, ponderHashMb, ponderStepped: PONDER_STEPPED, workerStarts: aggroDbg.workerStarts, lastWorkerStart: aggroDbg.lastStart,
      stockfish: { active: sfActive, relaxedSimd: { probe: sfRelaxedOk, failed: sfDbg.rsimdFailed }, threads: sfThreadsSent, threadedFailed: sfDbg.threadedFailed, threadedStarts: sfDbg.threadedStarts, sab: sfSab, module: { ...sfModuleInfo, sendFailures: sfDbg.moduleSendFailures },
        poolKind: ponderKind, cancelling: ponderCancelling.length, harvested: sfDbg.harvested, harvestFailed: sfDbg.harvestFailed, workerStarts: sfDbg.workerStarts, lastWorkerStart: sfDbg.lastStart, rankMode: SF_RANK_MODE,
        searchMode: sfLast ? sfLast.mode : null, depthDone: sfLast ? sfLast.depthDone : null, softMs: sfLast ? sfLast.softMs : null, elapsedMs: sfLast ? sfLast.elapsedMs : null,
        lastSearch: sfLast, pvSeeds: sfDbg.pvSeeds, mainWarmMs: sfDbg.mainWarmMs === undefined ? null : sfDbg.mainWarmMs },
      aggroLastBudget: aggroDbg.lastBudget || null });
  }
  if (!msg || msg.type !== 'analyze') return;
  return msg.engine === 'stockfish'
    ? analyzeStockfish(msg.fen, msg.depth, msg.imperfection, msg.sfMaxMs, msg.startFen, msg.moves, msg)
    : analyzeAggro(msg);
});

initStockfish();
initAggro();
