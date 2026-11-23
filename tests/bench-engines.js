// Benchmark (not a test, 2.0.2): the AggroChess wasm builds in Node.
//
//   node tests/bench-engines.js [--aggro a.wasm,b.wasm] [--rounds 3] [--only sig|speed|start] [--sig12] [--json]
//   node tests/bench-engines.js --diff a.wasm b.wasm [--step 0.1]
//
// Per build: the bench signature at depth 8 (and 12 with --sig12; docs/OPUS_PROMPT_2.0.2.md §3), nodes per second at
// think(1000), the average depth reached by think(100 / 300 / 1000) on the 9 bench positions that are not book moves
// (empty hash, a fresh game for each), and the start-up costs (instantiate, the first search of a fresh instance, the
// worker warm-up of engine/aggro-worker.js and the first search after it). Builds are interleaved round by round and
// the median of the rounds is reported (the machine is noisy: about +-15% run to run).
//
// --diff runs one scripted battery of calls (positions, think / think_clock / think_depth / analyze, book, SEE, ponder
// move, failures, game status) on two builds with a FAKE clock (every js_now call advances it by --step ms) and the
// LCG js_random, and compares every answer and the number of js_now / js_random calls after each step. Two builds that
// search the same trees agree exactly; this is how the rebuilt 4.6.1 crate (engine-src/aggrochess) was checked
// against the binaries shipped in 2.0.0.
'use strict';
const { aggro, signature, nodesOf, BENCH_FENS } = require('./_aggro-wasm');

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const has = (name) => args.includes(name);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const WARM_FEN = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

// ---------- --diff ----------
function battery() {
  const KIWI = BENCH_FENS[0];
  const s = [
    ['pos', ''], ['think', 30], ['fen'], ['legal'], ['status'], ['ponder'],
    ['pos', 'e2e4 e7e5'], ['think', 50], ['book', 'g1f3'], ['book', 'a2a3'], ['analyze', 40],
    ['pos', KIWI + '|'], ['think', 30], ['think', 100], ['ponder'], ['thinkClock', 50, 200], ['thinkDepth', 6, 3000], ['analyze', 50], ['see', 'e5g6'], ['see', 'd5e6'], ['see', 'zz'], ['legal'],
    ['pos', 'e2e4 e2e5'], ['fen'], ['pos', 'xx|'], ['fen'], ['pos', '|e2e4'], ['fen'], ['pos', '  ' + KIWI + ' | e5g6 h3g2  '], ['fen'], ['think', 60],
    ['pos', 'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3 c8f5 f3e5 c7c6 g2g4 f5e6 h2h4'], ['think', 80], ['analyze', 60], ['status'],
    ['pos', 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 d7d5 e4d5 f6d5 g5f7 e8f7 d1f3 f7e6 b1c3 c6b4'], ['think', 120], ['ponder'],
    ['pos', '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1|'], ['think', 50], ['analyze', 50], ['status'],
    ['pos', 'r5k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1|'], ['think', 50], ['analyze', 50],
    ['pos', 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3|'], ['status'], ['think', 30], ['analyze', 30], ['legal'],
    ['pos', '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1|'], ['status'], ['think', 30],
    ['pos', '8/8/4k3/8/8/4K3/8/8 w - - 0 1|'], ['status'], ['pos', '8/8/4k3/8/8/4K3/8/7R w - - 100 80|'], ['status'],
    ['pos', 'g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8'], ['status'], ['think', 40],
    ['pos', 'xx|e2e4'], ['fen'], ['status'], ['pos', 'e2e4 zz e7e5'], ['fen'], ['pos', 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 d7d5 e4d5 f6d5 g5f7 e8f7 d1f3 f7e6 b1c3 c6b4 a2a9'], ['fen'], ['think', 90],
    ['pos', 'g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8 e2e9'], ['status'], ['pos', KIWI + '|e5g6 h3g2 g6h8 g2h1q e1g1 zz'], ['fen'], ['think', 70], ['analyze', 40], ['pos', '8/8/8/8/8/8/8/8 w - - 0 1|'], ['fen'], ['status'],
    ['pos', 'ÿþ|'], ['fen'],
    ['pos', 'g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8'], ['pos', 'xx|'], ['status'], ['analyze', 30],
    ['pos', 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 d7d5 e4d5 f6d5 g5f7 e8f7 d1f3 f7e6 b1c3 c6b4'], ['pos', 'yy|'], ['analyze', 60], ['pos', 'qq|e2e4 e7e5'], ['analyze', 50],
    ['pos', 'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3 c8f5 f3e5 c7c6 g2g4 f5e6 h2h4'], ['think', 80], ['pos', 'zz|'], ['pos', 'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3 c8f5 f3e5 c7c6'], ['think', 80], ['think', 80],
    ['pos', 'r1b2k1r/ppp1qppp/2n5/3Q4/2B5/8/PPP2PPP/R1B1K2R w KQ - 0 1|'], ['analyze', 300], ['think', 300], ['pos', '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1|'], ['analyze', 300], ['think', 300],
    ['clear'], ['ttmb', 8], ['pos', KIWI + '|'], ['think', 40], ['ttmb', 32],
  ];
  for (const f of BENCH_FENS) s.push(['clear'], ['pos', ''], ['pos', f + '|'], ['thinkDepth', 8, 3500]);
  return s;
}
function runBattery(file, step) {
  const e = aggro(file, { clock: 'fake', step });
  return battery().map((op) => {
    let r;
    switch (op[0]) {
      case 'pos': r = e.pos(op[1]); break;
      case 'think': r = e.think(op[1]); break;
      case 'thinkClock': r = e.thinkClock(op[1], op[2]); break;
      case 'thinkDepth': r = e.thinkDepth(op[1], op[2]); break;
      case 'analyze': r = e.analyze(op[1]); break;
      case 'fen': r = e.fen(); break;
      case 'legal': r = e.legal(); break;
      case 'status': r = e.status(); break;
      case 'ponder': r = e.ponder(); break;
      case 'see': r = e.see(op[1]); break;
      case 'book': r = e.book(op[1]); break;
      case 'clear': e.ex.clear_hash(); r = 'ok'; break;
      case 'ttmb': r = e.ex.set_tt_mb(op[1]); break;
    }
    return { op: op.join(' ').slice(0, 60), r: String(r), calls: e.calls.now + '/' + e.calls.rnd };
  });
}
function diff(a, b, step) {
  const ra = runBattery(a, step), rb = runBattery(b, step);
  let bad = 0;
  for (let i = 0; i < ra.length; i++) {
    if (ra[i].r === rb[i].r && ra[i].calls === rb[i].calls) continue;
    if (++bad <= 10) console.log('DIFF at step ' + i + ': ' + ra[i].op + '\n  A: ' + ra[i].r.slice(0, 160) + ' [' + ra[i].calls + ']\n  B: ' + rb[i].r.slice(0, 160) + ' [' + rb[i].calls + ']');
  }
  console.log(bad ? bad + ' of ' + ra.length + ' steps differ' : 'identical: all ' + ra.length + ' steps (answers and js_now / js_random calls), fake clock step ' + step + ' ms');
  return bad;
}

// ---------- speed ----------
function speed(file, times) {
  const e = aggro(file, { clock: 'real' });
  e.ex.set_tt_mb(32);
  e.pos(WARM_FEN + '|'); e.think(30);                         // lazy set-up out of the way
  const res = {};
  for (const ms of times) {
    const depths = [], knps = [];
    for (const f of BENCH_FENS) {
      e.ex.clear_hash(); e.pos(''); e.pos(f + '|');
      const t0 = performance.now();
      const out = e.think(ms).split(' ');
      const dt = performance.now() - t0;
      if (out[2] === 'book') continue;
      depths.push(parseInt(out[3], 10) || 0);
      knps.push(nodesOf(e.lastInfo()) / dt);
    }
    res[ms] = { depth: depths.reduce((x, y) => x + y, 0) / depths.length, knps: median(knps) };
  }
  return res;
}

// ---------- start-up ----------
function startup(file) {
  const t0 = performance.now();
  const e = aggro(file, { clock: 'real' });
  const instMs = performance.now() - t0;
  e.ex.set_tt_mb(32); e.pos(BENCH_FENS[2] + '|');
  const t1 = performance.now(); e.think(30); const firstMs = performance.now() - t1;
  // the worker's warm-up (engine/aggro-worker.js) on a fresh instance, then a first real search
  const w = aggro(file, { clock: 'real' });
  const t2 = performance.now();
  w.ex.set_tt_mb(32); w.pos(WARM_FEN + '|'); w.think(5); w.ex.clear_hash(); w.pos('');
  const warmMs = performance.now() - t2;
  w.pos(BENCH_FENS[2] + '|');
  const t3 = performance.now(); w.think(30); const afterWarmMs = performance.now() - t3;
  return { instMs, firstMs, warmMs, afterWarmMs };
}

function main() {
  if (has('--diff')) {
    const i = args.indexOf('--diff');
    process.exit(diff(args[i + 1], args[i + 2], Number(opt('--step', 0.1))) ? 1 : 0);
  }
  const files = opt('--aggro', 'engine/aggrochess.wasm,engine/aggrochess-simd.wasm').split(',');
  const rounds = Math.max(1, Number(opt('--rounds', 3)));
  const only = opt('--only', null);
  const times = [100, 300, 1000];
  const out = {};
  for (const f of files) out[f] = { sig8: null, sig12: null, speed: [], start: [] };
  if (!only || only === 'sig') {
    for (const f of files) {
      out[f].sig8 = signature(f, 8);
      if (has('--sig12')) out[f].sig12 = signature(f, 12);
    }
  }
  for (let r = 0; r < rounds; r++) {
    for (const f of files) {                                 // interleaved: build A, build B, build A, ...
      if (!only || only === 'speed') out[f].speed.push(speed(f, times));
      if (!only || only === 'start') out[f].start.push(startup(f));
    }
  }
  const table = {};
  for (const f of files) {
    const o = out[f], row = {};
    if (o.sig8) row.sig8 = o.sig8.nodes + ' ' + o.sig8.moves.join(' ');
    if (o.sig12) row.sig12 = o.sig12.nodes + ' ' + o.sig12.moves.join(' ');
    if (o.speed.length) {
      for (const ms of times) row['depth@' + ms] = +median(o.speed.map((s) => s[ms].depth)).toFixed(2);
      row.knps = Math.round(median(o.speed.map((s) => s[1000].knps)));
      row.knpsRange = Math.round(Math.min(...o.speed.map((s) => s[1000].knps))) + '-' + Math.round(Math.max(...o.speed.map((s) => s[1000].knps)));
    }
    if (o.start.length) for (const k of ['instMs', 'firstMs', 'warmMs', 'afterWarmMs']) row[k] = +median(o.start.map((s) => s[k])).toFixed(1);
    table[f] = row;
  }
  if (has('--json')) console.log(JSON.stringify(table, null, 2));
  else for (const [f, row] of Object.entries(table)) { console.log(f); for (const [k, v] of Object.entries(row)) console.log('  ' + k.padEnd(12) + v); }
}
main();
