'use strict';
const api = typeof browser !== 'undefined' ? browser : chrome;

// ======================= Stockfish (UCI, WebAssembly with asm.js fallback) =======================
// SF_FILE: Stockfish.js 19, lite NNUE, single thread (no SharedArrayBuffer needed). Its loader and the .wasm of the
// same name (SF_WASM) are both in engine/. If it fails to start, SF_FALLBACK_FILE (asm.js, much slower) is used.
// Start order of every Stockfish worker: (1) engine/sf-worker.js, which loads the UNMODIFIED loader and hands it a wasm
// Module compiled once here (sfModuleFor), (2) the loader directly (it fetches and compiles the .wasm itself), (3) asm.js
// (main worker only). The threaded builds (2.0.6: SF_THREADED_FILE_RSIMD, then SF_THREADED_FILE) are used for the MAIN
// worker only, only when setting sfThreads > 1 AND the runtime feature test (CV.sabSupport) passes; any failure there falls
// back one step (relaxed-SIMD threaded -> npm threaded -> the single-thread engine) and is remembered.
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
// 2.0.6 (C): the threaded build with WebAssembly relaxed SIMD (tools/build-stockfish.sh; the same search, Threads 1 gives the
// depth-14 bench signature of the single builds). Its loader gets its own .wasm in "#<url>,worker" (sfWasmOf), and its
// pthread workers load the same URL, so they never see the plain .wasm (tests/bench-threads.js --only load).
const SF_THREADED_FILE_RSIMD = 'engine/stockfish-19-lite-rsimd.js';
const isSfThreaded = (file) => file === SF_THREADED_FILE || file === SF_THREADED_FILE_RSIMD;
const SF_FALLBACK_FILE = 'engine/stockfish-19-asm.js';
const SF_THREADS = 1, SF_HASH_MB = 32;      // sent once after start-up (2.0.6: the main worker's Hash is the setting sfHashMb, see sfHashWant)
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
// 2.0.6 (B): the main worker's hash (MB): the latest setting value from the page (sfHashWant, used at the next start) and
// what the running main worker has (sfHashSent; null = the engine's default); sfSpin = the spin options the main engine
// listed ({ name: { min, max } }), so a runtime setoption stays inside them.
let sfHashWant = CV.DEFAULTS.sfHashMb, sfHashSent = null, sfSpin = {};
const sfDbg = { moduleSendFailures: 0, workerStarts: 0, lastStart: null, harvested: 0, harvestFailed: 0, threadedFailed: null, threadedStarts: 0, pvSeeds: 0, rsimdFailed: null,
  // 2.0.6: the relaxed-SIMD threaded build failed to start (why; then the npm threaded build is used); Hash changes sent to
  // the main worker; main searches that waited for stopping ponder workers (CV.SF_MAIN_WAIT_STOP_MS) and the last waits (ms)
  rsimdThreadedFailed: null, hashChanges: 0, mainWaits: 0, mainWaitMs: [],
  // 2.0.3 (seen on a phone: a main search ran 4 752 ms with a 3 000 ms cap, and 27 Stockfish workers were started for 31
  // ponder jobs): main searches that ended more than SF_OVERRUN_MS after their cap (count, the last 5 in full); Stockfish
  // workers terminated, by reason; the last 20 ponder cancels (stop + readyok, ms)
  overruns: 0, lastOverruns: [], kills: {}, cancelMs: [], claimedWhileStopping: 0, claimReplaced: 0 };
const SF_OVERRUN_MS = 250;
const noteSfKill = (reason) => { sfDbg.kills[reason] = (sfDbg.kills[reason] || 0) + 1; };
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
// 2.0.6: also resolves `spin` (the spin options the engine listed) and `sent` ({ Threads, Hash }: the values sent, or null).
function sfSpawn(file, opts) {
  opts = opts || {};
  const hashMb = opts.hashMb || SF_HASH_MB, threads = opts.threads || SF_THREADS;
  const viaWrapper = isSfSingle(file) && !!opts.wrapper;
  return new Promise((resolve, reject) => {
    let w = null, done = false, stage = 'uci';
    const spin = {};      // option name -> { min, max } for the spin options the engine lists
    const notes = [];     // what happened with the options, for the log
    const sent = { Threads: null, Hash: null };
    const fail = (why) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { if (w) w.terminate(); } catch (e) { /* ignore */ }
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail('no readyok within ' + (opts.timeoutMs || SF_START_TIMEOUT_MS) + ' ms (waiting for ' + stage + ')'), opts.timeoutMs || SF_START_TIMEOUT_MS);
    try {
      // The wasm loader finds its .wasm from "#<url>,worker"; passing it explicitly avoids relying on location.origin.
      // 2.0.6: every wasm loader (single and threaded, plain and relaxed SIMD) gets the .wasm of its own name.
      w = new Worker(api.runtime.getURL(viaWrapper ? SF_WRAPPER : file) + (isSfSingle(file) || isSfThreaded(file) ? '#' + encodeURIComponent(api.runtime.getURL(sfWasmOf(file))) + ',worker' : ''));
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
            else { w.postMessage('setoption name ' + name + ' value ' + value); notes.push(name + ' = ' + value + ' sent'); sent[name] = value; }
          }
          w.postMessage('isready');
        }
      } else if (/^no such option/i.test(line)) {
        notes.push('engine refused an option: ' + line);
      } else if (line === 'readyok') {
        done = true; clearTimeout(timer);
        resolve({ worker: w, notes, spin, sent });
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
  const gen = engineGen;
  engineDbg.starts.stockfish++;
  sfReady = (async () => {
    let r, file;
    try {
      r = await sfSpawnWasm({ hashMb: sfHashWant });            // 2.0.6 (B): the main worker's hash is the setting sfHashMb
      file = r.file || SF_FILE;
    } catch (e) {
      if (gen !== engineGen) throw e;
      console.error('[ChessVision] Stockfish: ' + SF_FILE + ' did not start (' + ((e && e.message) || e) + '); falling back to ' + SF_FALLBACK_FILE);
      r = await sfSpawn(SF_FALLBACK_FILE, { hashMb: sfHashWant });
      file = SF_FALLBACK_FILE;
    }
    // 2.0.0 (T10): warm the main worker like the ponder workers before sfReady resolves: the first search of a fresh engine
    // pays for its own lazy set-up. Measured in Node: ~20 ms here, first depth-10 search 56 -> 39 ms. Never fatal.
    const warmMs = await sfWarmMain(r.worker);
    // 2.0.4 (B1): the engines were shut down while this one started (cannot happen while a request waits for it, see
    // engineIdleCheck): never attach a worker of an older generation
    if (gen !== engineGen) { try { r.worker.terminate(); } catch (e) { /* ignore */ } throw new Error('the engine was shut down while it started'); }
    sfActive = file;
    sfDbg.mainWarmMs = warmMs;
    sfAttach(r.worker);
    sfThreadsSent = SF_THREADS;
    sfHashSent = r.sent ? r.sent.Hash : null; sfSpin = r.spin || {};
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
// 2.0.6 (C): the builds of CV.sfThreadedCandidates in turn (relaxed-SIMD threaded, then the npm threaded build); a build
// that fails is remembered (sfDbg.rsimdThreadedFailed / threadedFailed) and the next one is tried; when none starts, the
// single-thread engine stays (no retry loop). Returns the thread count in use.
const sfThreadedFiles = () => CV.sfThreadedCandidates({ relaxedOk: sfRelaxedOk, failed: { rsimd: !!sfDbg.rsimdThreadedFailed, npm: !!sfDbg.threadedFailed } })
  .map((k) => (k === 'rsimd' ? SF_THREADED_FILE_RSIMD : SF_THREADED_FILE));
async function sfApplyThreads(setting) {
  const want = CV.sfThreadCount(setting, typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined, sfSab.ok);
  if (isSfThreaded(sfActive)) {
    if (want !== sfThreadsSent && !sfCurrent) { sf.postMessage('setoption name Threads value ' + want); sfThreadsSent = want; }
    return sfThreadsSent;
  }
  if (want <= 1 || sfCurrent || sfNext) return 1;
  for (const file of sfThreadedFiles()) {
    try {
      const r = await sfSpawn(file, { threads: want, hashMb: sfHashWant });
      if (sfCurrent) { try { r.worker.terminate(); } catch (e) { /* ignore */ } return 1; }     // a search started meanwhile: keep the old engine
      const old = sf; sfAttach(r.worker); sfActive = file; sfThreadsSent = want; sfPrevCount = null;
      sfHashSent = r.sent ? r.sent.Hash : null; sfSpin = r.spin || {};
      try { if (old) old.terminate(); } catch (e) { /* ignore */ }
      sfDbg.threadedStarts++; sfDbg.lastStart = { label: 'main', file: sfActive, how: 'threaded, Threads ' + want };
      console.log('[ChessVision] Stockfish threaded build active:', file, 'Threads', want, r.notes.join('; '));
      return want;
    } catch (e) {
      const why = String((e && e.message) || e);
      if (file === SF_THREADED_FILE_RSIMD) { sfDbg.rsimdThreadedFailed = why; console.error('[ChessVision] Stockfish relaxed-SIMD threaded build did not start (' + why + '); trying ' + SF_THREADED_FILE); continue; }
      sfDbg.threadedFailed = why;
      console.error('[ChessVision] Stockfish threaded build did not start (' + why + '); keeping ' + sfActive);
      return 1;
    }
  }
  return 1;
}

// 2.0.6 (B): the main worker's hash follows the setting sfHashMb: `setoption name Hash` only when the value changed and only
// while the main worker is idle (called right before a search starts; nothing is searching then). A new size clears the
// table. A value outside the range the engine listed is not sent (the engine keeps its table).
function sfApplyHash() {
  if (!sf || sfCurrent || sfNext || sfHashWant === sfHashSent) return;
  const o = sfSpin.Hash;
  if (o && (sfHashWant < o.min || sfHashWant > o.max)) return;
  sf.postMessage('setoption name Hash value ' + sfHashWant);
  sfHashSent = sfHashWant; sfDbg.hashChanges++;
}
const sfHashFrom = (msg) => { if (msg && msg.sfHashMb !== undefined) { const v = CV.sanitize({ sfHashMb: msg.sfHashMb }).sfHashMb; if (v) sfHashWant = v; } };

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
    job.softTimer = setTimeout(() => sfCheckStop(job, 'soft timer'), job.softMs);
    job.hardTimer = setTimeout(() => sfCheckStop(job, 'hard timer'), job.hardMs);
  } else if (job.mode === 'clock') {
    sf.postMessage(job.clockGo);
    job.hardTimer = setTimeout(() => sfCheckStop(job, 'hard timer'), job.hardMs);
  } else sf.postMessage(CV.sfGoCommand(job.depth, job.maxMs));
}

// Sends `stop` (once) when CV.sfShouldStop says so; the normal bestmove handling then resolves the job.
// 2.0.3: `by` = what called it ('info' line, 'soft timer', 'hard timer'); a timer notes how late it fired (debug info).
function sfCheckStop(job, by) {
  if (by === 'soft timer' || by === 'hard timer') {
    const late = Date.now() - job.startedAt - (by === 'soft timer' ? job.softMs : job.hardMs);
    job[by === 'soft timer' ? 'softLateMs' : 'hardLateMs'] = Math.max(0, late);   // 2.0.4: >= 0 (a timer may fire 1 ms "early")
  }
  if (sfCurrent !== job || job.stopSent) return;
  // 2.0.4: a timer can fire a millisecond before Date.now() says its time is up (clock rounding); a timer that fired has
  // reached its time (seen as a flaky test: the hard timer did not stop the search, the next info line did)
  let elapsedMs = Date.now() - job.startedAt;
  if (by === 'hard timer') elapsedMs = Math.max(elapsedMs, job.hardMs);
  else if (by === 'soft timer') elapsedMs = Math.max(elapsedMs, job.softMs);
  if (job.mode === 'clock') { if (elapsedMs >= job.hardMs) sfSendStop(job, by); return; }
  if (job.mode !== 'delay') return;
  if (CV.sfShouldStop({ elapsedMs, softMs: job.softMs, depthDone: job.depthDone, minDepth: job.depth, hardMs: job.hardMs })) sfSendStop(job, by);
}
// 2.0.3: `stop` to the main worker, noting why and when (ms after the search started) for the debug info.
function sfSendStop(job, by) {
  if (job && !job.stopSent && job.startedAt) { job.stopSent = true; job.stopBy = by; job.stopAtMs = Date.now() - job.startedAt; }
  sf.postMessage('stop');
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
  if (job.mode === 'delay') sfCheckStop(job, 'info');
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
    job.softTimer = setTimeout(() => sfCheckStop(job, 'soft timer'), Math.max(0, job.softMs - (Date.now() - job.startedAt)));
    return;
  }
  sfCurrent = null;
  sfClearTimers(job);
  if (job) {
    const elapsedMs = Date.now() - job.startedAt, da = job.depthAt || [];
    sfLast = { mode: job.mode + (job.extended ? ' (clock, extended)' : ''), depthDone: job.depthDone || 0, softMs: job.softMs, hardMs: job.hardMs, elapsedMs, superseded: !!sfNext, topUp: !!job.topUp,
      // 2.0.3: why and when `stop` was sent, how long the bestmove took after it, how late the timers fired, when the
      // last exact depth arrived ([depth, ms]); all in ms after the search started (null = did not happen)
      stopBy: job.stopBy || null, stopAtMs: job.stopAtMs === undefined ? null : job.stopAtMs, replyAfterStopMs: job.stopAtMs === undefined ? null : elapsedMs - job.stopAtMs,
      softTimerLateMs: job.softLateMs === undefined ? null : job.softLateMs, hardTimerLateMs: job.hardLateMs === undefined ? null : job.hardLateMs,
      lastDepthAt: da.length ? da[da.length - 1] : null };
    if (job.hardMs > 0 && elapsedMs > job.hardMs + SF_OVERRUN_MS) { sfDbg.overruns++; sfDbg.lastOverruns.push(sfLast); if (sfDbg.lastOverruns.length > 5) sfDbg.lastOverruns.shift(); }
  }
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

// 2.0.6 (A3): the ponder workers just stopped (ponderCancel) are answering `stop` + `isready`; with CV.SF_MAIN_WAIT_STOP_MS > 0
// the main `go` waits until every one of them answered, at most that long (their search threads and the main search's
// would otherwise compete for the cores for those few ms). 0 = 2.0.5 (no wait).
async function sfWaitStopped() {
  const cap = Math.max(0, Number(CV.SF_MAIN_WAIT_STOP_MS) || 0);
  if (!cap) return;
  const ps = ponderCancelling.filter((w) => w.kind === 'sf' && !w.dead && w.cancelP).map((w) => w.cancelP.catch(() => false));
  if (!ps.length) return;
  const t0 = Date.now();
  let timer = null;
  await Promise.race([Promise.all(ps), new Promise((r) => { timer = setTimeout(r, cap); })]);
  clearTimeout(timer);
  sfDbg.mainWaits++; sfDbg.mainWaitMs.push(Date.now() - t0); if (sfDbg.mainWaitMs.length > 20) sfDbg.mainWaitMs.shift();
}

// The real Stockfish request. `msg` (optional, 7th argument) carries the pondering fields (ponder, sfThreads).
async function analyzeStockfish(fen, depth, imperfection, maxMs, startFen, moves, msg) {
  aggroThinking++;                     // while a real search runs, no spare ponder worker is made (see ponderTopUp)
  try { return await analyzeStockfishNow(fen, depth, imperfection, maxMs, startFen, moves, msg || {}); } finally { aggroThinking--; ponderTopUp(); }
}
async function analyzeStockfishNow(fen, depth, imperfection, maxMs, startFen, moves, msg) {
  const t0 = Date.now();
  sfHashFrom(msg);
  try { await sfEnsureCurrent(); } catch (e) { return { error: 'Stockfish: could not start (' + ((e && e.message) || e) + ')' }; }
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
    await sfWaitStopped();                                                    // 2.0.6 (A3): CV.SF_MAIN_WAIT_STOP_MS (0 = 2.0.5: no wait)
  }
  if (msg.sfThreads !== undefined) { try { await sfApplyThreads(msg.sfThreads); } catch (e) { /* keep the engine we have */ } }
  if (!sf) { try { await sfEnsureCurrent(); } catch (e) { return { error: 'Stockfish: could not start (' + ((e && e.message) || e) + ')' }; } }   // 2.0.4: from here to sfStart nothing waits
  sfApplyHash();                                                              // 2.0.6 (B): only when sfHashMb changed
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
      sfSendStop(sfCurrent, 'superseded');
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
    if (sfCurrent) { if (sfNext) sfNext.resolve(null); sfNext = job; sfSendStop(sfCurrent, 'superseded'); } else sfStart(job);
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
const AGGRO_STOP_TIMEOUT_MS = 150;        // 2.0.2: an interruptible worker must answer a stop within this long, else it is terminated

// Creates one worker. Returns { ready, request(msg, timeoutMs), kill(), dead }.
// `ready` rejects on a worker 'error' message before 'ready', on worker.onerror and after AGGRO_START_TIMEOUT_MS.
function spawnAggroWorker(label, ttMb) {
  // 2.0.2 (C1): gen = the game (ponderGen) its hash belongs to; isReady once 'ready' arrived; searched = the positions
  // (history keys after an opponent move) whose replies it searched in its last job, so the next job can give the line
  // that was played to the worker whose hash holds it.
  const h = { kind: 'aggro', label, ttMb: ttMb || null, steps: false, worker: null, dead: false, pending: new Map(), seq: 0,
    gen: typeof ponderGen === 'number' ? ponderGen : 0, isReady: false, searched: new Set(), interruptible: false, idleWaiters: [] };
  if (label === 'ponder') ponderDbg.aggroSpawns++;
  // waiters for a set of requests to be answered (stopAll)
  const notifyIdle = () => {
    if (!h.idleWaiters.length) return;
    const done = h.idleWaiters.filter((w) => w.ids.every((id) => !h.pending.has(id)));
    if (!done.length) return;
    h.idleWaiters = h.idleWaiters.filter((w) => !done.includes(w));
    for (const w of done) w.resolve(true);
  };
  const failAll = (why) => {
    for (const [id, p] of h.pending) { h.pending.delete(id); clearTimeout(p.timer); p.reject(new Error(why)); }
    notifyIdle();
  };
  h.ready = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, v) => { if (settled) return false; settled = true; clearTimeout(timer); fn(v); return true; };
    const fail = (why) => { settle(reject, new Error(why)); failAll(why); };
    const timer = setTimeout(() => fail('worker did not start within ' + AGGRO_START_TIMEOUT_MS + ' ms'), AGGRO_START_TIMEOUT_MS);
    try { h.worker = new Worker(api.runtime.getURL(AGGRO_WORKER)); } catch (e) { fail('could not create worker: ' + ((e && e.message) || e)); return; }
    h.worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'ready') { h.how = m.how || null; h.warmMs = m.warmMs; h.steps = !!m.steps; h.isReady = true; h.interruptible = !!m.interruptible; aggroDbg.workerStarts++; aggroDbg.lastStart = { label, how: h.how, warmMs: h.warmMs, interruptible: h.interruptible }; settle(resolve); return; }
      if (m.type === 'error' && !settled) { fail(m.message || 'worker error'); return; }
      const p = h.pending.get(m.id);
      if (m.type === 'error') console.error('[ChessVision] AggroChess (' + label + ') error', m.message);
      if (!p) return;
      h.pending.delete(m.id); clearTimeout(p.timer);
      if (m.type === 'error') p.reject(new Error(m.message || 'worker error')); else p.resolve(m);
      notifyIdle();
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
  h.request = (msg, timeoutMs) => {
    let id = null;
    const pr = new Promise((resolve, reject) => {
      if (h.dead) { reject(new Error('worker was terminated')); return; }
      id = ++h.seq;
      const timer = setTimeout(() => { h.pending.delete(id); reject(new Error('no answer within ' + timeoutMs + ' ms')); notifyIdle(); }, timeoutMs);
      h.pending.set(id, { resolve, reject, timer, think: msg.type === 'think', search: msg.type === 'think' || msg.type === 'analyze' });
      try { h.worker.postMessage({ ...msg, id }); } catch (e) { h.pending.delete(id); clearTimeout(timer); reject(e); }
    });
    pr.id = id;                       // 2.0.2: for { type: 'stop', id }
    return pr;
  };
  // 2.0.2 (A7): end the search(es) in flight (interruptible workers only, JSPI): each answers with its best move so far.
  h.stop = (id) => { try { if (!h.dead) h.worker.postMessage({ type: 'stop', id }); } catch (e) { /* ignore */ } };
  // stop every request in flight and wait until they are answered (later requests do not count); false after capMs
  h.stopAll = (capMs) => {
    const ids = [...h.pending.keys()];
    for (const [id, p] of h.pending) if (p.search) h.stop(id);
    if (!ids.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { ids, resolve: (v) => { clearTimeout(t); resolve(v); } };
      const t = setTimeout(() => { h.idleWaiters = h.idleWaiters.filter((x) => x !== w); resolve(false); }, capMs);
      h.idleWaiters.push(w);
    });
  };
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
    engineDbg.starts.aggro++;
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

// ======================= Engine lifetime (2.0.4, B1) =======================
// 2.0.3 started both main workers when the browser started (each compiles a ~1.8 MB wasm, allocates its hash and warms
// up, in a persistent background page, even if chess.com is never opened). Now an engine starts on its first use
// (ensureStockfish / ensureAggro: analyze, aggroIdle, and the page's `warm` message, sent when Auto-play is on on an
// allowed page so the first move does not pay for the start), and after CV.ENGINE_IDLE_MS without a request while no
// tab holds a port (runtime.connect, one per chess.com tab), both main workers and every ponder worker are terminated
// and the compiled modules dropped. The stop is synchronous and only happens when nothing is in flight (no request
// waiting, no search, no ponder job, no top-up), so no request can see a half-stopped engine; a request after it
// starts a fresh engine (engineGen tells an older start that it lost). CV.LAZY_ENGINES = false: 2.0.3 (both start at
// load, never stop).
let engineGen = 0, engineInflight = 0, engineIdleTimer = null;
const enginePorts = new Set();
const engineDbg = { starts: { stockfish: 0, aggro: 0 }, stops: 0, lastStopAt: null };
function ensureStockfish() {
  if (!sfReady) initStockfish();
  return sfReady;
}
// ensureStockfish, again if the engines were shut down while it waited (then `sf` belongs to no one): the caller may use `sf`
// until its next await.
async function sfEnsureCurrent() {
  for (let i = 0; i < 3; i++) {
    const gen = engineGen;
    await ensureStockfish();
    if (gen === engineGen && sf) return;
  }
  throw new Error('the engine was restarted while starting');
}
function ensureAggro() {
  try { return aggroGet().ready; } catch (e) { return Promise.reject(e); }     // cooling down after a failed start: its error
}
// A request that may use an engine: counted while it runs; the idle clock restarts when it ends.
async function withEngine(fn) {
  engineInflight++;
  clearTimeout(engineIdleTimer); engineIdleTimer = null;
  try { return await fn(); } finally { engineInflight--; armEngineIdle(); }
}
function armEngineIdle() {
  if (!CV.LAZY_ENGINES) return;
  clearTimeout(engineIdleTimer);
  engineIdleTimer = enginePorts.size || engineInflight ? null : setTimeout(engineIdleCheck, CV.ENGINE_IDLE_MS);
}
const enginesRunning = () => !!(sf || sfReady || (aggroMain && !aggroMain.dead) || ponderSpares.length || ponderActive.length || ponderCancelling.length);
function engineIdleCheck() {
  engineIdleTimer = null;
  if (!CV.LAZY_ENGINES || enginePorts.size || !enginesRunning()) return;
  if (engineInflight || aggroThinking || sfCurrent || sfNext || ponderActive.length || idleInfo.pondering || hitJobs.size) { armEngineIdle(); return; }
  stopEngines();
}
function stopEngines() {
  engineGen++;
  ponderWanted = false;                                         // B2: no spares are made again until a new idle job
  ponderCancel();
  for (const w of [...ponderSpares, ...ponderActive, ...ponderCancelling]) w.kill('engines idle');
  ponderSpares = []; ponderActive = []; ponderCancelling = [];
  if (sf) { try { sf.terminate(); } catch (e) { /* ignore */ } }
  sf = null; sfReady = null; sfActive = null; sfCurrent = null; sfNext = null; sfPrevCount = null; sfMultiPvSent = null; sfThreadsSent = SF_THREADS; lastMainPv = null;
  sfHashSent = null; sfSpin = {};
  if (aggroMain) { aggroMain.kill(); aggroMain = null; }
  sfModuleP.clear(); aggroModuleP = null;                       // compiled again on the next start
  Object.assign(sfModuleInfo, { shared: false, ms: null, how: null, error: null, file: null });
  Object.assign(aggroModuleInfo, { shared: false, ms: null, how: null, error: null, file: null, simd: false });
  engineDbg.stops++; engineDbg.lastStopAt = Date.now();
  console.log('[ChessVision] engines stopped after ' + CV.ENGINE_IDLE_MS + ' ms without a request');
}
// `warm` from the page: start the engine of that name now (the first move then finds it ready).
function warmEngine(engine) {
  return (engine === 'stockfish' ? ensureStockfish() : ensureAggro()).then(() => ({ ok: true }), (e) => ({ ok: false, error: String((e && e.message) || e) }));
}
// One port per chess.com tab (content.js): while any tab holds one, the engines are never shut down.
if (api.runtime.onConnect) {
  api.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== 'chessvision') return;
    enginePorts.add(port);
    clearTimeout(engineIdleTimer); engineIdleTimer = null;
    port.onDisconnect.addListener(() => { enginePorts.delete(port); onPortGone(port); });
  });
}
// 2.0.4 (B2): the last tab is gone: nobody needs a ponder job or warm spares any more (kept indefinitely before, while
// ponderWanted). A tab that started the running idle job and closed: the job is cancelled (other tabs keep the spares).
// CV.PONDER_RELEASE_ON_DISCONNECT = false: 2.0.3 (nothing happens). The engines themselves stop after CV.ENGINE_IDLE_MS (B1).
function onPortGone(port) {
  const tab = portTab(port);
  if (CV.PONDER_RELEASE_ON_DISCONNECT) {
    if (!enginePorts.size) { ponderWanted = false; ponderCancel(); }
    else if (idleStatus.tab !== null && idleStatus.tab === tab && !portForTab(tab)) ponderCancel();
  }
  if (idleStatus.tab === tab && !portForTab(tab)) stopIdleStatus();
  armEngineIdle();
}
const portTab = (port) => (port && port.sender && port.sender.tab && port.sender.tab.id !== undefined ? port.sender.tab.id : null);
const portForTab = (tab) => { for (const p of enginePorts) if (portTab(p) === tab) return p; return null; };

// ======================= Ponder status pushed to the tab (2.0.4, A4) =======================
// 2.0.3: the page asked for { pondering, evalLine, found } on every watchdog tick (aggroIdleStatus, one message a second
// for the whole opponent's turn). Now the background pushes it on the port of the tab that started the idle job, only
// when a value changed and at most every IDLE_STATUS_MIN_MS; the 250 ms check runs only while a job is reported.
// aggroIdleStatus still answers (debug use, and pages without a port). CV.IDLE_STATUS_PUSH = false: 2.0.3.
const IDLE_STATUS_MIN_MS = 250;
const idleStatus = { tab: null, key: null, timer: null, last: null, pushes: 0 };
const idleSnapshot = () => ({ pondering: !!idleInfo.pondering, evalLine: idleInfo.evalLine || null, found: ponder.found() });
function startIdleStatus(msg, sender) {
  if (!CV.IDLE_STATUS_PUSH) return;
  const tab = sender && sender.tab && sender.tab.id !== undefined ? sender.tab.id : null;
  idleStatus.tab = tab; idleStatus.key = CV.ponderKey(msg.startFen, msg.moves); idleStatus.last = null;
  if (!idleStatus.timer) idleStatus.timer = setInterval(pushIdleStatus, IDLE_STATUS_MIN_MS);
  pushIdleStatus();
}
function stopIdleStatus() { clearInterval(idleStatus.timer); idleStatus.timer = null; idleStatus.tab = null; idleStatus.key = null; }
function pushIdleStatus() {
  const port = idleStatus.tab === null ? null : portForTab(idleStatus.tab);
  if (!port) { stopIdleStatus(); return; }
  const snap = idleSnapshot();
  const same = idleStatus.last && idleStatus.last.pondering === snap.pondering && idleStatus.last.evalLine === snap.evalLine && idleStatus.last.found === snap.found;
  if (!same) {
    idleStatus.last = snap;
    idleStatus.pushes++;
    try { port.postMessage({ type: 'idleStatus', key: idleStatus.key, ...snap }); } catch (e) { stopIdleStatus(); return; }
  }
  if (!snap.pondering && !idleJobs) { clearInterval(idleStatus.timer); idleStatus.timer = null; }   // the job ended and its last state is out
}

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
  topUps: 0, topUpUsed: 0, hitChanged: 0, topUpDepths: [],
  // 2.0.2 (A7): interruptible AggroChess workers: stops sent, answered in time / terminated, the last 20 stop times (ms);
  // late searches stopped and their move used
  stops: 0, stopsOk: 0, stopsFailed: 0, stopMs: [], lateStops: 0, lateStopHits: 0, claimStopping: 0,
  // 2.0.3: replies settled (CV.ponderSettled), jobs that ended because every reply was settled, most passes of any job
  settled: 0, settledJobs: 0, maxPasses: 0 };
const noteStopMs = (ms, ok) => { ponderDbg.stops++; ponderDbg[ok ? 'stopsOk' : 'stopsFailed']++; ponderDbg.stopMs.push(ms); if (ponderDbg.stopMs.length > 20) ponderDbg.stopMs.shift(); };
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
  const settled = new Set();      // 2.0.3: replies with nothing more to find (CV.ponderSettled); later passes leave them out
  let allSettled = false;
  const depthOf = (u) => { const p = ponder.get(); const r = p && p.results ? p.results[u] : null; return r && Number.isFinite(r.depth) ? r.depth : -1; };
  const wake = () => { const w = waiters; waiters = []; for (const r of w) r(); };
  const nextPass = () => {
    if (pass >= 1 && !opts.until) return false;
    const p = ponder.get();
    let items = CV.ponderDeepenPlan({ ranked: opts.ranked, results: p ? p.results : null, pass: pass + 1, workers: opts.workers.length, firstSlice: opts.firstSlice, leftMs: opts.left(), depthCap: pass >= 1 ? opts.depthCap : 0, settled });
    if (!items.length && pass >= 1 && !allSettled && opts.ranked.length && opts.ranked.every((u) => settled.has(u))) { allSettled = true; ponderDbg.settledJobs++; }
    if (pass === 0 && opts.skipFirst) { const skip = opts.skipFirst(); if (skip) items = items.filter((it) => it.uci !== skip); }
    if (!items.length) return false;
    pass++; queue = items;
    if (pass > 1) { ponderDbg.lastPasses = pass - 1; ponderDbg.maxPasses = Math.max(ponderDbg.maxPasses, pass - 1); }
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
          // 2.0.3: only deepening passes settle a reply (pass 1 of Stockfish is depth-limited and may end early on purpose)
          const t0 = Date.now(), depthBefore = depthOf(it.uci), itPass = pass;
          return { u: it.uci, ms, pass, done: () => {
            if (ended) return;
            ended = true; running--; busy.delete(w);
            if (itPass >= 2 && opts.token === idleToken && !settled.has(it.uci) && CV.ponderSettled({ ms, elapsedMs: Date.now() - t0, depthBefore, depthAfter: depthOf(it.uci) })) { settled.add(it.uci); ponderDbg.settled++; }
            if (!running) wake();
          } };
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
  // 2.0.2 (A7): an AggroChess worker that is being stopped is free again in a few ms (its search ends at the next poll,
  // and the worker runs requests one after the other): take it rather than start a cold one
  while (got.length < n) {
    const i = ponderCancelling.findIndex((w) => w.kind === 'aggro' && ponderKind === 'aggro' && !w.dead && w.ttMb === ponderHashMb);
    if (i < 0) break;
    const w = ponderCancelling.splice(i, 1)[0];
    w.claimedWhileStopping = true; ponderDbg.claimStopping++;
    got.push(w);
  }
  // 2.0.3: the same for Stockfish (seen on a phone with 2.0.2: 27 workers started for 31 jobs, because the next job begins
  // right after a hit, while the last job's workers are still answering `stop`: it started new ones and the stopped
  // ones were then terminated as surplus). The job's first step, `await w.ready`, waits for the stop to finish.
  while (got.length < n && CV.SF_CLAIM_STOPPING) {
    const i = ponderCancelling.findIndex((w) => w.kind === 'sf' && ponderKind === 'sf' && !w.dead && w.ttMb === ponderHashMb && w.cancelP);
    if (i < 0) break;
    const w = ponderCancelling.splice(i, 1)[0];
    w.releaseSeq = (w.releaseSeq || 0) + 1;
    w.claimedStop = true;
    w.ready = w.cancelP.then((ok) => { if (!ok || w.dead) throw new Error('the stopped search did not end'); w.claimedStop = false; });
    sfDbg.claimedWhileStopping++;
    got.push(w);
  }
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
  if (w.dead || ponderCancelling.includes(w)) return;
  ponderSpares = ponderSpares.filter((x) => !x.dead && x !== w);
  const wanted = CV.AGGRO_PONDER_RECYCLE && ponderWanted && ponderKind === 'aggro' && w.ttMb === ponderHashMb;
  // 2.0.2 (A7): a busy worker that can be interrupted (JSPI) is stopped and kept, like a Stockfish worker
  if (wanted && w.busy() && w.interruptible && CV.AGGRO_INTERRUPT) { aggroStopRelease(w); return; }
  const keep = wanted && !w.busy() && ponderActive.length + ponderSpares.length + ponderCancelling.length < ponderCap;
  if (!keep) { w.kill(); ponderDbg.aggroKilled++; return; }
  ponderSpares.push(w);
  ponderDbg.aggroRecycled++;
}
// stop + wait for the answer (at most AGGRO_STOP_TIMEOUT_MS, then terminate); counted in ponderCancelling meanwhile
async function aggroStopRelease(w) {
  ponderCancelling.push(w);
  const t0 = Date.now();
  let ok = false;
  try { ok = await w.stopAll(AGGRO_STOP_TIMEOUT_MS); } catch (e) { ok = false; }
  ponderCancelling = ponderCancelling.filter((x) => x !== w);
  if (w.claimedWhileStopping) {                          // a new job has it already
    w.claimedWhileStopping = false;
    noteStopMs(Date.now() - t0, ok);
    if (!ok && !w.dead) { w.kill(); ponderDbg.aggroKilled++; }   // its old search did not stop: the job goes on without it
    return;
  }
  noteStopMs(Date.now() - t0, ok);
  if (!ok || w.dead) { w.kill(); ponderDbg.aggroKilled++; ponderTopUp(); return; }
  aggroRelease(w);
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

// 2.0.4 (E2): every ponder job replayed the whole game (CV.replayUci); the next job's moves extend the last job's by two
// plies, so only those are applied (CV.createReplayCache, the same result). CV.REPLAY_CACHE = false: 2.0.3.
const jobReplay = CV.createReplayCache();
const replayForJob = (startFen, moves) => (CV.REPLAY_CACHE ? jobReplay.replay(startFen, moves) : CV.replayUci(startFen, moves));

// The idle job: after our move, while the opponent thinks. Runs detached; every step re-checks its token.
let idleJobs = 0;                // 2.0.4: idle jobs whose code is still running (the status push runs while one does)
async function runIdle(msg, token) {
  if (msg.ponder) idleInfo.pondering = true;                   // the job has started (the workers may still be loading)
  idleJobs++;
  try { await runIdleJob(msg, token); } finally { idleJobs--; if (token === idleToken) idleInfo.pondering = false; }
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
  const after = replayForJob(msg.startFen, msg.moves);
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

// 2.0.2 (C2): think(pause) on the main worker when the pause is at least the time the prepared reply was searched with
// (e.ms). Returns the topUp handle for the page, or null.
function aggroHitTopUp(msg, e, t0) {
  const left = hitLeftMs(msg, t0);
  const plan = left > 0 ? CV.hitTopUp({ engine: 'aggro', storedDepth: e.depth, storedMs: e.ms, hitSoftMs: left }) : null;
  if (!plan || !plan.search) return null;
  return startHitTopUp('aggro', e, plan.ms, async () => {
    const h = aggroGet();
    await h.ready;
    const r = await h.request({ type: 'think', ...aggroPosition(msg), ms: plan.ms }, plan.ms * AGGRO_THINK_FACTOR + AGGRO_THINK_MARGIN_MS);
    return aggroResult(r);
  });
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
        const topUp = aggroHitTopUp(msg, e, t0);
        if (topUp) res.topUp = topUp;
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
      } else if (run && run.token === idleToken && run.w.interruptible && CV.AGGRO_INTERRUPT && run.promise.id) {
        // 2.0.2 (A7): the reply search on this move is far from done, but it can be stopped (JSPI): its move so far (the
        // last completed depth) is used when deep enough, and deepened through the hit pause like a hit (C2).
        ponderDbg.lateStops++;
        idleToken++; idleInfo.pondering = false;
        for (const x of ponderActive.filter((y) => y !== run.w)) aggroRelease(x);
        const startedAt = d.runningMeta ? d.runningMeta.startedAt : null;
        run.w.stop(run.promise.id);
        const r = await Promise.race([run.promise.catch(() => null), new Promise((res) => setTimeout(() => res(null), AGGRO_STOP_TIMEOUT_MS))]);
        aggroRelease(run.w); ponder.setRunning(null);
        const res = aggroResult(r);
        if (res && res.depth >= CV.AGGRO_PARTIAL_MIN_DEPTH) {
          ponderDbg.lateStopHits++; ponderCancel(); noteHitDepth(res.depth);
          const out = { ...res, ponderHit: true, late: true, partial: true };
          const topUp = aggroHitTopUp(msg, { ...res, ms: startedAt ? Date.now() - startedAt : 0 }, t0);
          if (topUp) out.topUp = topUp;
          return out;
        }
      }
      ponderCancel();                                          // miss, late or no entry yet: the ponder workers never delay a real think
    }
    let h = aggroGet();
    await h.ready;
    if (h.dead) { h = aggroGet(); await h.ready; }               // 2.0.4: shut down while it waited (B1): a fresh one
    // 2) older requests' results would be stale
    for (const [id, p] of h.pending) { if (p.think) { h.pending.delete(id); clearTimeout(p.timer); p.resolve({ type: 'bestmove', uci: null }); if (h.interruptible && CV.AGGRO_INTERRUPT) h.stop(id); } }
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
  h.kill = (reason) => {
    if (h.dead) return;
    h.dead = true;
    noteSfKill(reason || 'not needed');           // 2.0.3: debug info (stockfish.kills)
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
    h.worker.onerror = (e) => { console.error('[ChessVision] Stockfish (' + label + ') error', e && e.message); h.kill('error'); };
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
  h.ready = h.ready.catch((e) => { h.kill('start failed'); throw e; });      // a worker that failed to start or warm up is never reused
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
    t.timer = setTimeout(() => { h.task = null; t.reject(new Error('no answer within ' + (ms + SF_SEARCH_MARGIN_MS) + ' ms')); h.kill('search timeout'); }, ms + SF_SEARCH_MARGIN_MS);
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
    const t0 = Date.now();
    if (t) {
      t.stopped = true;
      try { h.worker.postMessage('stop'); } catch (e) { h.kill('error'); return false; }
      const got = await Promise.race([t.promise, new Promise((r) => setTimeout(() => r(null), SF_STOP_TIMEOUT_MS))]).catch(() => null);
      if (!got) { h.kill('no bestmove after stop'); return false; }
    }
    if (!(await h.sync(SF_STOP_TIMEOUT_MS))) { h.kill('no readyok after stop'); return false; }
    sfDbg.cancelMs.push(Date.now() - t0); if (sfDbg.cancelMs.length > 20) sfDbg.cancelMs.shift();
    return true;
  };
  h.newGame = (gen) => { h.gen = gen; try { if (h.worker && !h.dead) h.worker.postMessage('ucinewgame'); } catch (e) { /* ignore */ } };   // runs in order, before the next position
  return h;
}

// A job worker is finished or the job was cancelled: stop it, wait for readyok (it never blocks anyone: only the worker is
// busy), then it is a warm spare again, or it is killed when it did not answer / is no longer wanted.
// 2.0.3: a new job may claim the worker while it is being stopped (ponderClaim): then w.releaseSeq changes and this
// release leaves the worker to that job. One cancel at a time per worker (w.cancelP), shared by overlapping releases.
async function sfRelease(w) {
  ponderActive = ponderActive.filter((x) => x !== w);
  if (ponderCancelling.includes(w) || w.dead) return;
  ponderCancelling.push(w);
  const my = w.releaseSeq = (w.releaseSeq || 0) + 1;
  let ok = false;
  try { ok = await (w.cancelP || (w.cancelP = w.cancel().finally(() => { w.cancelP = null; }))); } catch (e) { ok = false; }
  ponderCancelling = ponderCancelling.filter((x) => x !== w);
  if (w.releaseSeq !== my) return;                          // claimed by a new job meanwhile (its w.ready says whether the stop worked)
  if (!ok || w.dead) { w.kill(); ponderTopUp(); return; }
  ponderSpares = ponderSpares.filter((x) => !x.dead);
  if (!ponderWanted || ponderKind !== 'sf' || w.ttMb !== ponderHashMb) { w.kill('not needed'); return; }
  if (ponderActive.length + ponderSpares.length + ponderCancelling.length >= ponderCap) { w.kill('pool full after cancel'); return; }
  ponderSpares.push(w);
}

// The idle job for Stockfish: after our move, while the opponent thinks. Detached; every step re-checks its token.
async function runIdleSf(msg, token) {
  idleInfo.pondering = true;
  idleJobs++;
  try { await runIdleSfJob(msg, token); } finally { idleJobs--; if (token === idleToken) idleInfo.pondering = false; }
}
async function runIdleSfJob(msg, token) {
  const t0 = Date.now();
  const budget = Math.max(200, Math.min(AGGRO_HARD_MAX_MS, Number(msg.ponderMs) || 1500));
  const deadline = t0 + ponderCeiling(msg, budget), left = () => deadline - Date.now();   // 2.0.0: up to ponderMaxMs with ponderUntilMove
  ponderDbg.lastPasses = 0;
  const after = replayForJob(msg.startFen, msg.moves);
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
  const setRanked = (list) => {
    if (rankedList) return;
    rankedList = CV.moveFirst(list, predicted);
    resolveRanked();
  };
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
      try { await w.ready; } catch (e) {
        // 2.0.3: a worker claimed while it was being stopped whose old search did not end (it was terminated): a new
        // worker takes its place in this job (2.0.2 would have started one at once)
        if (!w.claimedStop || token !== idleToken) throw e;
        ponderActive = ponderActive.filter((x) => x !== w);
        const nw = ponderSpawn();
        ponderActive.push(nw);
        const i = pool.indexOf(w);
        if (i >= 0) pool[i] = nw;
        sfDbg.claimReplaced++;
        return work(nw);
      }
      if (token !== idleToken) return;
      idleInfo.pondering = true;
      if (mode === 'multipv') {
        if (!rank.owner) {                                      // the first worker that is ready ranks; the others wait for the list
          rank.owner = w;
          const k = Math.min(legal.length, CV.sfRankLines(SF_RANK_LINES, pool.length)), ms = Math.max(30, Math.min(SF_RANK_MS, Math.floor(budget * SF_PONDER_SCAN_SHARE)));
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

// ======================= Saved games (2.0.4, C2) =======================
// One storage key per game (CV.SAVED_GAME_PREFIX + id) and an index of ids, newest first (CV.SAVED_GAMES_INDEX). 2.0.3
// rewrote the whole list (up to maxSavedGames, 200 at most) on every save, from each tab, serialised per tab only, and
// storage.onChanged carried the old and the new list to every tab. Now the tabs ask the background (saveGame,
// listGames, clearGames) and the background does one operation at a time: a save writes that game's key and the
// index in one set() (and removes the keys that fell out). The pruning rules are mergeSaved's (CV.mergeSavedIndex).
// The sizes of stored games are kept in memory (read once per background start, only when unknown).
const gameStore = () => api.storage && api.storage.local;
let gameChain = Promise.resolve();
const gameSizes = new Map();          // id -> CV.savedGameBytes of the stored record
function gameSerial(fn) {
  const p = gameChain.then(fn);
  gameChain = p.catch(() => {});
  return p;
}
const gameKey = (id) => CV.SAVED_GAME_PREFIX + id;
async function gameIndex() {
  const g = await gameStore().get(CV.SAVED_GAMES_INDEX);
  const ids = g && Array.isArray(g[CV.SAVED_GAMES_INDEX]) ? g[CV.SAVED_GAMES_INDEX] : [];
  return ids.filter((id, i) => typeof id === 'string' && ids.indexOf(id) === i);
}
async function gameSizesFor(ids) {
  const missing = ids.filter((id) => !gameSizes.has(id));
  if (!missing.length) return;
  const got = await gameStore().get(missing.map(gameKey));
  for (const id of missing) { const r = got[gameKey(id)]; gameSizes.set(id, r ? CV.savedGameBytes(r) : 0); }
}
function saveGame(record, max) {
  return gameSerial(async () => {
    if (!record || typeof record.id !== 'string' || !record.id) return { ok: false, error: 'no record' };
    await migrateQuietly();                                     // a failed migration never loses a new game
    const ids = await gameIndex();
    await gameSizesFor(ids);
    const bytes = CV.savedGameBytes(record);
    const lim = CV.LIMITS.maxSavedGames;
    const m = Math.min(lim[1], Math.max(lim[0], Math.round(Number(max)) || CV.DEFAULTS.maxSavedGames));
    const { list, dropped } = CV.mergeSavedIndex(ids.map((id) => ({ id, bytes: gameSizes.get(id) || 0 })), { id: record.id, bytes }, { max: m });
    const kept = list.some((g) => g.id === record.id);
    const write = { [CV.SAVED_GAMES_INDEX]: list.map((g) => g.id) };
    if (kept) write[gameKey(record.id)] = record;
    await gameStore().set(write);
    if (kept) gameSizes.set(record.id, bytes);
    if (dropped.length) { await gameStore().remove(dropped.map(gameKey)); for (const id of dropped) gameSizes.delete(id); }
    gameDbg.saves++;
    return { ok: true, kept, dropped: dropped.length, count: list.length };
  });
}
function listGames() {
  return gameSerial(async () => {
    await migrateQuietly();
    const ids = await gameIndex();
    const got = ids.length ? await gameStore().get(ids.map(gameKey)) : {};
    const list = ids.map((id) => got[gameKey(id)]).filter((r) => r && typeof r === 'object');
    if (!gameMigrated) {                                        // the old list is still there: show its games too (older)
      const old = (await gameStore().get(CV.SAVED_GAMES_LEGACY))[CV.SAVED_GAMES_LEGACY];
      if (Array.isArray(old)) for (const r of old) if (r && r.id && !list.some((x) => x.id === r.id)) list.push(r);
    }
    return list;
  });
}
function clearGames() {
  return gameSerial(async () => {
    await migrateQuietly();
    const ids = await gameIndex();
    await gameStore().set({ [CV.SAVED_GAMES_INDEX]: [] });
    if (ids.length) await gameStore().remove(ids.map(gameKey));
    if (!gameMigrated) { await gameStore().remove(CV.SAVED_GAMES_LEGACY); gameMigrated = true; }   // clear means all of them
    gameSizes.clear();
    return { ok: true, cleared: ids.length };
  });
}
// One-way migration of the 2.0.3 list ('savedGames', newest first): every game is written under its own key with the
// index, read back and compared, and only then is the old list removed. Nothing is pruned here (the next save prunes by
// the usual rules). Idempotent: a migration interrupted after the write (or stopped by a failed check) is simply done
// again at the next start; games saved meanwhile under the new keys stay in front (they are newer), and an id in both
// keeps the per-key record. Runs once per background start, before the first save / list / clear (they wait for it).
let gameMigrated = false;
const gameDbg = { saves: 0, migrated: null, migrateError: null };
async function migrateSavedGames() {
  if (gameMigrated || !gameStore()) return;
  const legacyKey = CV.SAVED_GAMES_LEGACY;
  const got = await gameStore().get(legacyKey);
  if (!(legacyKey in got)) { gameMigrated = true; return; }
  const old = Array.isArray(got[legacyKey]) ? got[legacyKey].filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id) : [];
  const ids = await gameIndex();
  const cur = ids.length ? await gameStore().get(ids.map(gameKey)) : {};
  const order = ids.filter((id) => cur[gameKey(id)]);
  const write = {};
  for (const r of old) {
    if (order.includes(r.id)) continue;            // already migrated, or saved again under the new key (newer)
    order.push(r.id); write[gameKey(r.id)] = r;
  }
  write[CV.SAVED_GAMES_INDEX] = order;
  await gameStore().set(write);
  const back = await gameStore().get([CV.SAVED_GAMES_INDEX, ...order.map(gameKey)]);
  const okIndex = Array.isArray(back[CV.SAVED_GAMES_INDEX]) && back[CV.SAVED_GAMES_INDEX].join('\n') === order.join('\n');
  const okGames = order.every((id) => back[gameKey(id)] && back[gameKey(id)].id === id);
  if (!okIndex || !okGames) throw new Error('saved games: the migrated copy did not read back; the old list is kept');
  await gameStore().remove(legacyKey);
  for (const id of order) gameSizes.set(id, CV.savedGameBytes(back[gameKey(id)]));
  gameMigrated = true;
  gameDbg.migrated = { games: order.length, fromList: old.length, at: Date.now() };
  console.log('[ChessVision] saved games moved to one key per game:', order.length);
}
async function migrateQuietly() {
  try { await migrateSavedGames(); } catch (e) { gameDbg.migrateError = String((e && e.message) || e); }
}
function migrateAtStart() {
  if (!gameStore()) return;
  gameSerial(migrateSavedGames).catch((e) => { gameDbg.migrateError = String((e && e.message) || e); console.error('[ChessVision] saved games migration failed (will retry)', e); });
}


// ======================= Messaging =======================
api.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'allowlist') return loadAllowlist();
  if (msg && msg.type === 'fetchImage') return fetchImage(msg.url);
  if (msg && msg.type === 'aggroClear') { aggroClear(); return Promise.resolve({ ok: true }); }
  if (msg && msg.type === 'clearEngines') { clearEngines(); return Promise.resolve({ ok: true }); }
  if (msg && msg.type === 'aggroInvalidate') { ponderWanted = false; ponderCancel(); return Promise.resolve({ ok: true }); }   // also frees the spares
  if (msg && msg.type === 'aggroIdle') return withEngine(async () => { const r = aggroIdle(msg); if (r && r.state === 'started') startIdleStatus(msg, sender); return r; });
  if (msg && msg.type === 'hitTopUp') return withEngine(() => hitFinal(msg.id));
  if (msg && msg.type === 'warm') { sfHashFrom(msg); return withEngine(() => warmEngine(msg.engine)); }
  if (msg && msg.type === 'saveGame') return saveGame(msg.record, msg.max);
  if (msg && msg.type === 'listGames') return listGames();
  if (msg && msg.type === 'clearGames') return clearGames();
  if (msg && msg.type === 'aggroIdleStatus') return Promise.resolve({ pondering: idleInfo.pondering, evalLine: idleInfo.evalLine, found: ponder.found() });
  if (msg && msg.type === 'aggroDebug') {
    return Promise.resolve({ cpu: { hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null, ponderCap }, ponder: { ...ponder.counters, passes: ponderDbg.lastPasses, maxPasses: ponderDbg.maxPasses, settled: { enabled: !!CV.PONDER_SETTLE, replies: ponderDbg.settled, jobsEnded: ponderDbg.settledJobs }, hitDepths: ponderDbg.hitDepths.slice(), harvestUpgrades: ponderDbg.harvestUpgrades, lateWaits: ponderDbg.lateWaits, lateWaitHits: ponderDbg.lateWaitHits,
      hitTopUp: { started: ponderDbg.topUps, used: ponderDbg.topUpUsed, changed: ponderDbg.hitChanged, depths: ponderDbg.topUpDepths.slice() },
      interrupt: { enabled: !!CV.AGGRO_INTERRUPT, mainInterruptible: !!(aggroMain && aggroMain.interruptible), stops: ponderDbg.stops, ok: ponderDbg.stopsOk, failed: ponderDbg.stopsFailed,
        stopMs: ponderDbg.stopMs.slice(), lateStops: ponderDbg.lateStops, lateStopHits: ponderDbg.lateStopHits, claimedWhileStopping: ponderDbg.claimStopping },
      aggroWorkers: { jobs: ponderDbg.jobs, spawns: ponderDbg.aggroSpawns, respawnsPerMove: ponderDbg.jobs ? +(ponderDbg.aggroSpawns / ponderDbg.jobs).toFixed(2) : null, recycled: ponderDbg.aggroRecycled, killed: ponderDbg.aggroKilled, coldClaims: ponderDbg.claimCold, warmLineFirst: ponderDbg.claimWarmLine, recycle: !!CV.AGGRO_PONDER_RECYCLE } },
      verify: { checks: aggroDbg.verifyChecks, warnings: aggroDbg.verifyWarnings, last: aggroDbg.lastVerify },
      aggroWorkerAlive: !!(aggroMain && !aggroMain.dead), aggroRestarts: aggroDbg.restarts, aggroFailure: aggroFailure ? aggroFailure.message : null,
      ponderPool: { cap: ponderCap, active: ponderActive.filter((w) => !w.dead).length, spares: ponderSpares.filter((w) => !w.dead).length, wanted: ponderWanted },
      module: { ...aggroModuleInfo, sendFailures: aggroDbg.moduleSendFailures }, ponderHashMb, ponderStepped: PONDER_STEPPED, workerStarts: aggroDbg.workerStarts, lastWorkerStart: aggroDbg.lastStart,
      stockfish: { active: sfActive, relaxedSimd: { probe: sfRelaxedOk, failed: sfDbg.rsimdFailed }, threads: sfThreadsSent, threadedFailed: sfDbg.threadedFailed, rsimdThreadedFailed: sfDbg.rsimdThreadedFailed, threadedRsimd: !!CV.SF_THREADED_RSIMD, threadedStarts: sfDbg.threadedStarts,
        hashMb: sfHashSent, hashWanted: sfHashWant, hashChanges: sfDbg.hashChanges, mainWaitStop: { capMs: CV.SF_MAIN_WAIT_STOP_MS, waits: sfDbg.mainWaits, lastMs: sfDbg.mainWaitMs.slice() }, sab: sfSab, module: { ...sfModuleInfo, sendFailures: sfDbg.moduleSendFailures },
        poolKind: ponderKind, cancelling: ponderCancelling.length, harvested: sfDbg.harvested, harvestFailed: sfDbg.harvestFailed, kills: { ...sfDbg.kills }, cancelMs: sfDbg.cancelMs.slice(), claimedWhileStopping: sfDbg.claimedWhileStopping, claimReplaced: sfDbg.claimReplaced, overruns: sfDbg.overruns, lastOverruns: sfDbg.lastOverruns.slice(), workerStarts: sfDbg.workerStarts, lastWorkerStart: sfDbg.lastStart, rankMode: SF_RANK_MODE,
        searchMode: sfLast ? sfLast.mode : null, depthDone: sfLast ? sfLast.depthDone : null, softMs: sfLast ? sfLast.softMs : null, elapsedMs: sfLast ? sfLast.elapsedMs : null,
        lastSearch: sfLast, pvSeeds: sfDbg.pvSeeds, mainWarmMs: sfDbg.mainWarmMs === undefined ? null : sfDbg.mainWarmMs },
      aggroLastBudget: aggroDbg.lastBudget || null,
      idleStatus: { push: !!CV.IDLE_STATUS_PUSH, pushes: idleStatus.pushes, tab: idleStatus.tab },
      savedGames: { saves: gameDbg.saves, migrated: gameDbg.migrated, migrateError: gameDbg.migrateError },
      engines: { lazy: !!CV.LAZY_ENGINES, idleMs: CV.ENGINE_IDLE_MS, starts: { ...engineDbg.starts }, stops: engineDbg.stops, lastStopAt: engineDbg.lastStopAt, ports: enginePorts.size,
        running: { stockfish: !!sfReady, aggro: !!(aggroMain && !aggroMain.dead) } } });
  }
  if (!msg || msg.type !== 'analyze') return;
  const run = withEngine(() => (msg.engine === 'stockfish'
    ? analyzeStockfish(msg.fen, msg.depth, msg.imperfection, msg.sfMaxMs, msg.startFen, msg.moves, msg)
    : analyzeAggro(msg)));
  return run;
});

migrateAtStart();
if (!CV.LAZY_ENGINES) {                 // 2.0.3: both engines start with the background page and are never stopped
  initStockfish();
  initAggro();
}
