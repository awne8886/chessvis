// Benchmark (not a test): delay-matched search (2.0.0, T3) against the 1.8.0 `go depth 10`, with the REAL Stockfish
// loader (engine/stockfish-19-lite-single.js) run as a UCI command-line program under Node (child_process).
// For each of 10 fixed middlegame positions and each soft budget it starts from an empty hash (ucinewgame), searches
// `go depth 64` and stops it with the extension's own rule (CV.sfShouldStop: soft used AND depth >= 10, or the hard cap).
// Also (--only warm): the main-worker warm-up of T10 (cost, and the first search after it).
//
//   node tests/bench-delay-mode.js [--only delay|warm|hit] [--engine engine/<loader>.js] [--json]
// --only hit (2.0.2, C2): the depth of a ponder hit. Per position the main engine searches our move (delay, soft 300 ms),
// the opponent plays the expected reply (pv[1]), a second engine prepares our answer as pondering pass 1 does
// (`go depth 10 movetime 250`, empty hash): that is the depth a 2.0.0 hit plays. Then the main engine (its hash warm from
// our search) searches the same position for the hit pause (60 / 150 / 260 ms, the ponderHitFast range minus the 40 ms
// margin): the depth a 2.0.2 top-up reaches.
//
// Node / V8 numbers on this machine; a phone is several times slower. Nothing here runs in Firefox.
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { load, ROOT } = require('./_load');
const CV = load();

const ENGINE = path.join(ROOT, process.argv.includes('--engine') ? process.argv[process.argv.indexOf('--engine') + 1] : 'engine/stockfish-19-lite-single.js');
const FENS = [
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7',
  'rnbqkb1r/pp3ppp/4pn2/2pp4/3P4/2P1PN2/PP3PPP/RNBQKB1R w KQkq - 0 5',
  'r2q1rk1/pp1nbppp/2p1pn2/3p4/2PP4/2N1PN2/PPQ1BPPP/R1B2RK1 w - - 0 9',
  'r1b2rk1/2q1bppp/p2p1n2/np2p3/3PP3/2P2N1P/PPB2PP1/RNBQR1K1 w - - 0 12',
  '2rq1rk1/pp1bppbp/3p1np1/4n3/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 13',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
  'r1bqr1k1/pp1n1ppp/2pb1n2/3p4/3P4/2NBPN2/PPQ2PPP/R1B2RK1 w - - 0 10',
  '3r1rk1/p1q2ppp/1pn1pn2/2p5/2P5/1PNBPN2/P4PPP/2RQ1RK1 w - - 0 15',
];
const SOFTS = [150, 300, 500, 800];
const MIN_DEPTH = 10;
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

for (const f of FENS) if (!CV.chess.legalMoves(CV.chess.parseFen(f)).length) throw new Error('bad FEN ' + f);

// A UCI engine process with a line queue.
function engine() {
  const p = spawn(process.execPath, [ENGINE], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', waiters = [];
  const listeners = new Set();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      for (const fn of listeners) fn(line);
      waiters = waiters.filter((w) => { if (w.test(line)) { w.resolve(line); return false; } return true; });
    }
  });
  const send = (s) => p.stdin.write(s + '\n');
  const until = (re) => new Promise((resolve) => waiters.push({ test: (l) => re.test(l), resolve }));
  return {
    send, until, on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    async ready() { send('isready'); await until(/^readyok/); },
    quit() { try { send('quit'); } catch (e) { /* ignore */ } setTimeout(() => p.kill(), 200); },
  };
}

// One search; returns { ms, depth, best }. mode 'depth': `go depth 10`; mode 'delay': `go depth 64` + JS stop rule.
async function search(e, fen, mode, softMs) {
  e.send('ucinewgame'); await e.ready();
  e.send('position fen ' + fen);
  let depthDone = 0, stopSent = false, t0;
  const hardMs = CV.sfHardMs(softMs, 0);
  const maybeStop = () => {
    if (stopSent || mode !== 'delay') return;
    if (CV.sfShouldStop({ elapsedMs: Date.now() - t0, softMs, depthDone, minDepth: MIN_DEPTH, hardMs })) { stopSent = true; e.send('stop'); }
  };
  const off = e.on((line) => {
    const p = CV.sfParseInfo(line);
    if (p && !p.bound && p.mpv === 1) { depthDone = p.depth; maybeStop(); }
  });
  const done = e.until(/^bestmove/);
  t0 = Date.now();
  e.send(mode === 'delay' ? 'go depth 64' : 'go depth ' + MIN_DEPTH);
  const timers = mode === 'delay' ? [setTimeout(maybeStop, softMs), setTimeout(maybeStop, hardMs)] : [];
  const line = await done;
  const ms = Date.now() - t0;
  timers.forEach(clearTimeout); off();
  return { ms, depth: depthDone, best: line.split(' ')[1] };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };

async function benchDelay() {
  const e = engine();
  e.send('uci'); await e.until(/^uciok/); await e.ready();
  await search(e, FENS[0], 'depth', 0);                               // the engine's own lazy start-up, not measured
  const rows = [];
  const base = [];
  for (const f of FENS) base.push(await search(e, f, 'depth', 0));
  rows.push({ config: 'go depth ' + MIN_DEPTH + ' (1.8.0)', depthMean: mean(base.map((r) => r.depth)), depthMin: Math.min(...base.map((r) => r.depth)), msMedian: median(base.map((r) => r.ms)), msMax: Math.max(...base.map((r) => r.ms)), sameMove: '-' });
  for (const soft of SOFTS) {
    const r = [];
    for (const f of FENS) r.push(await search(e, f, 'delay', soft));
    const same = r.filter((x, i) => x.best === base[i].best).length;
    rows.push({ config: 'delay, soft ' + soft + ' ms', depthMean: mean(r.map((x) => x.depth)), depthMin: Math.min(...r.map((x) => x.depth)), msMedian: median(r.map((x) => x.ms)), msMax: Math.max(...r.map((x) => x.ms)), sameMove: same + '/' + FENS.length });
  }
  e.quit();
  return rows;
}

// T10: warm-up of the main worker as in background.js (go movetime 10 on SF_WARM_FEN, ucinewgame, isready), then the first
// real search (depth 10 on FENS[1]) - fresh engine each repetition.
async function benchWarm(reps = 5) {
  const out = { warmMs: [], firstColdMs: [], firstWarmMs: [] };
  for (let i = 0; i < reps; i++) {
    for (const warm of [false, true]) {
      const e = engine();
      e.send('uci'); await e.until(/^uciok/); await e.ready();
      if (warm) {
        const t0 = Date.now();
        e.send('position fen ' + FENS[0]); e.send('go movetime 10'); await e.until(/^bestmove/);
        e.send('ucinewgame'); await e.ready();
        out.warmMs.push(Date.now() - t0);
      }
      e.send('ucinewgame'); await e.ready();
      e.send('position fen ' + FENS[1]);
      const t1 = Date.now(); e.send('go depth 10'); await e.until(/^bestmove/);
      (warm ? out.firstWarmMs : out.firstColdMs).push(Date.now() - t1);
      e.quit();
    }
  }
  return { warmMedianMs: median(out.warmMs), firstSearchColdMedianMs: median(out.firstColdMs), firstSearchAfterWarmMedianMs: median(out.firstWarmMs), raw: out };
}

// One search on an engine in its current state (no ucinewgame): `position <posCmd>`, `go depth 64` stopped after stopMs
// (or `goCmd` when given). Returns { depth, pv, best, ms }.
async function goOn(e, posCmd, stopMs, goCmd) {
  e.send('position ' + posCmd);
  let depth = 0, pv = [];
  const off = e.on((line) => { const p = CV.sfParseInfo(line); if (p && !p.bound && p.mpv === 1) { depth = p.depth; pv = CV.sfParsePv(line); } });
  const done = e.until(/^bestmove/);
  const t0 = Date.now();
  e.send(goCmd || 'go depth 64');
  const timer = goCmd ? null : setTimeout(() => e.send('stop'), stopMs);
  const line = await done;
  clearTimeout(timer); off();
  return { depth, pv, best: line.split(' ')[1], ms: Date.now() - t0 };
}

async function benchHit() {
  const main = engine(), pond = engine();
  for (const e of [main, pond]) { e.send('uci'); await e.until(/^uciok/); e.send('setoption name Hash value 32'); await e.ready(); }
  const PAUSES = [60, 150, 260];
  const rows = { stored: [], same: {} };
  for (const p of PAUSES) { rows[p] = []; rows.same[p] = 0; }
  let n = 0;
  for (const f of FENS) {
    main.send('ucinewgame'); await main.ready();
    const ours = await goOn(main, 'fen ' + f, 300);
    if (ours.pv.length < 2) continue;
    const posQ = 'fen ' + f + ' moves ' + ours.pv[0] + ' ' + ours.pv[1];
    pond.send('ucinewgame'); await pond.ready();
    const stored = await goOn(pond, posQ, 0, 'go depth 10 movetime 250');
    rows.stored.push(stored.depth);
    for (const pause of PAUSES) {                                    // the main engine's hash as after our search (re-searched each time)
      main.send('ucinewgame'); await main.ready();
      await goOn(main, 'fen ' + f, 300);
      const top = await goOn(main, posQ, pause);
      rows[pause].push(top.depth);
      if (top.best === stored.best) rows.same[pause]++;
    }
    n++;
  }
  main.quit(); pond.quit();
  return { positions: n, storedMean: mean(rows.stored), pauses: PAUSES.map((p) => ({ pause: p, depthMean: mean(rows[p]), depthMin: Math.min(...rows[p]), sameMove: rows.same[p] + '/' + n })) };
}

(async () => {
  const res = {};
  if (only === 'hit') res.hit = await benchHit();
  if (!only || only === 'delay') res.delay = await benchDelay();
  if (!only || only === 'warm') res.warm = await benchWarm();
  if (args.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return; }
  if (res.delay) {
    console.log('Delay-matched search vs go depth ' + MIN_DEPTH + ' (10 middlegame positions, empty hash each, minimum depth ' + MIN_DEPTH + ')');
    console.log('| search | mean depth | min depth | median ms | max ms | same move as depth 10 |');
    console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const r of res.delay) console.log('| ' + r.config + ' | ' + r.depthMean.toFixed(1) + ' | ' + r.depthMin + ' | ' + Math.round(r.msMedian) + ' | ' + r.msMax + ' | ' + r.sameMove + ' |');
  }
  if (res.hit) {
    console.log('Ponder hit (' + res.hit.positions + ' positions): prepared reply (pass 1, go depth 10 movetime 250) mean depth ' + res.hit.storedMean.toFixed(1));
    console.log('| top-up pause | mean depth | min depth | same move as the prepared reply |');
    console.log('| ---: | ---: | ---: | ---: |');
    for (const r of res.hit.pauses) console.log('| ' + r.pause + ' ms | ' + r.depthMean.toFixed(1) + ' | ' + r.depthMin + ' | ' + r.sameMove + ' |');
  }
  if (res.warm) console.log('\nMain-worker warm-up: ' + res.warm.warmMedianMs + ' ms (median); first depth-10 search cold ' + res.warm.firstSearchColdMedianMs + ' ms, after warm-up ' + res.warm.firstSearchAfterWarmMedianMs + ' ms');
})().catch((e) => { console.error(e); process.exit(1); });
