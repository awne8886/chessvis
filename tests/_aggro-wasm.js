// Test / benchmark helper (2.0.2): runs an AggroChess .wasm directly in Node, the way engine/aggro-worker.js does.
//   const e = aggro(file, { clock: 'real' | 'fake', step: 0.1, seed: 12345 })
// clock 'fake': every js_now call advances the clock by `step` ms, so a timed search is deterministic (two builds that
// search the same tree give the same answers and make the same number of js_now / js_random calls).
// js_random is the LCG of the bench signature (docs/OPUS_PROMPT_2.0.2.md §3): s = (s*1103515245+12345) & 0x7fffffff.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// The 10 bench positions (§3). FEN 2 is in AggroChess's opening book (a book move, no search).
const BENCH_FENS = [
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  'r2q1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 9',
  'rnbqkb1r/pp3ppp/4pn2/2pp4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq - 0 5',
  '2r3k1/pp3ppp/2n1b3/3pP3/3P4/P1N2N2/1P3PPP/2R3K1 w - - 0 20',
  'r1b2rk1/2q1bppp/p2ppn2/1p6/3BPP2/2NB1Q2/PPP3PP/R4RK1 w - - 0 14',
  '4rrk1/pp1n3p/3q2pQ/2p1pb2/2PP4/2P3N1/P2B2PP/4RRK1 b - - 7 19',
  'r3r1k1/2p2ppp/p1p1bn2/8/1q2P3/2NPQN2/PPP3PP/R4RK1 b - - 2 15',
  '8/8/3k4/3p4/2pP1K2/2P5/8/8 w - - 0 1',
  '6k1/5pp1/7p/8/3R4/6P1/r4P1P/6K1 w - - 0 40',
];

function aggro(file, opts = {}) {
  const fake = opts.clock === 'fake';
  const step = opts.step === undefined ? 0.1 : opts.step;
  let t = 0, s = opts.seed === undefined ? 12345 : opts.seed;
  const calls = { now: 0, rnd: 0, poll: 0 };
  const imports = { env: {
    js_now: () => { calls.now++; if (!fake) return performance.now(); t += step; return t; },
    js_random: () => { calls.rnd++; s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 2 ** 31; },
    js_poll: () => { calls.poll++; return opts.poll ? opts.poll() : 0; },
  } };
  const bytes = fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file));
  const module = new WebAssembly.Module(bytes);
  const ex = new WebAssembly.Instance(module, imports).exports;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const write = (str) => { const b = enc.encode(str); new Uint8Array(ex.memory.buffer, ex.io_ptr(), b.length).set(b); return b.length; };
  const read = (n) => dec.decode(new Uint8Array(ex.memory.buffer, ex.io_ptr(), n).slice());
  return {
    ex, calls, module,
    reseed: (v) => { s = v === undefined ? 12345 : v; },     // the random sequence from the start again (after a warm-up)
    resetClock: () => { t = 0; },
    pos: (text) => ex.set_position(write(text)),
    think: (ms) => read(ex.think(ms)),
    thinkClock: (soft, hard) => read(ex.think_clock(soft, hard)),
    thinkDepth: (d, ms) => read(ex.think_depth(d, ms)),
    analyze: (ms) => read(ex.analyze(ms)),
    analyzeFloor: (ms, floor) => read(ex.analyze_floor(ms, floor)),      // 2.0.2 builds
    thinkFloor: (soft, hard, floor) => read(ex.think_floor(soft, hard, floor)),
    legal: () => read(ex.legal_moves()),
    fen: () => read(ex.fen()),
    ponder: () => read(ex.ponder_move()),
    see: (m) => ex.move_see(write(m)),
    book: (m) => ex.is_book_move(write(m)),
    lastInfo: () => (typeof ex.last_info === 'function' ? read(ex.last_info()) : null),
    status: () => [ex.game_status(), ex.in_check(), ex.side_to_move()].join(','),
  };
}

const nodesOf = (info) => +((/ nodes (\d+)/.exec(info || '') || [0, 0])[1]);

// The bench signature (§3): set_tt_mb(32); think(30) on FEN 1; then per FEN clear_hash, set_position(''),
// set_position(fen|), think_depth(D, 3500) and the nodes of last_info(). A book move does not search, so its
// last_info() is still the line of the search before (that is how the published totals were counted).
// Returns { nodes, moves: ['e5g6', 'f3g5(book)', ...], ms }.
function signature(file, depth) {
  const e = aggro(file, { clock: 'real' });
  if (typeof e.ex.last_info !== 'function') throw new Error(file + ': no last_info export (an engine build from before 2.0.2?)');
  e.ex.set_tt_mb(32);
  e.pos(BENCH_FENS[0] + '|');
  e.think(30);
  let nodes = 0;
  const moves = [];
  const t0 = performance.now();
  for (const f of BENCH_FENS) {
    e.ex.clear_hash(); e.pos(''); e.pos(f + '|');
    const out = e.thinkDepth(depth, 3500).split(' ');
    nodes += nodesOf(e.lastInfo());
    moves.push(out[0] + (out[2] === 'book' ? '(book)' : ''));
  }
  return { nodes, moves, ms: Math.round(performance.now() - t0) };
}

module.exports = { aggro, signature, nodesOf, BENCH_FENS, ROOT };
