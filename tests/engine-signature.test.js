// Engine signature (2.0.2): both shipped AggroChess builds must search exactly like the AggroChess 4.6.1 web build of
// 2.0.0. A pure speed-up (SIMD, wasm-opt, a faster TT index ...) keeps this bit-identical; anything that changes it is a
// search change (docs/OPUS_PROMPT_2.0.2.md §2-§3). Depth 8 over the 10 bench positions takes about 0.2 s per build.
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runner } = require('./_load');
const { aggro, signature, ROOT } = require('./_aggro-wasm');
const { test, run } = runner('engine-signature');

// Measured with the unchanged 4.6.1 rebuild (engine-src/aggrochess, tools/build-aggrochess.sh), which answers exactly
// like the 2.0.0 binaries (tests/bench-engines.js --diff). Depth 12: 1 422 083 nodes, see docs/REFERENCE.md.
const SIG8 = { nodes: 118270, moves: 'e2a6 f3g5(book) e1g1 c1f4 c3b5 e4e5 f8f6 f6g4 f4f5 d4d8' };
const BUILDS = ['engine/aggrochess.wasm', 'engine/aggrochess-simd.wasm'];

for (const file of BUILDS) {
  test(file + ': depth-8 signature', () => {
    const s = signature(file, 8);
    assert.strictEqual(s.moves.join(' '), SIG8.moves);
    assert.strictEqual(s.nodes, SIG8.nodes);
  });
}

test('the exports the worker and the benchmarks use are there', () => {
  for (const file of BUILDS) {
    const names = WebAssembly.Module.exports(new WebAssembly.Module(fs.readFileSync(path.join(ROOT, file)))).map((e) => e.name);
    for (const n of ['memory', 'io_ptr', 'io_size', 'set_position', 'think', 'think_clock', 'think_depth', 'analyze', 'legal_moves', 'fen',
      'game_status', 'in_check', 'side_to_move', 'ponder_move', 'move_see', 'is_book_move', 'clear_hash', 'set_tt_mb', 'last_info',
      'analyze_floor', 'think_floor']) {
      assert.ok(names.includes(n), file + ' exports ' + n);
    }
  }
});

test('plain and SIMD builds give the same timed answers (fake clock)', () => {
  const outs = BUILDS.map((file) => {
    const e = aggro(file, { clock: 'fake', step: 0.1 });
    const r = [];
    e.pos('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1|');
    r.push(e.think(40), e.analyze(25), e.thinkClock(30, 60), e.ponder());
    e.pos('e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 d7d5 e4d5 f6d5 g5f7 e8f7 d1f3 f7e6 b1c3 c6b4');
    r.push(e.think(60), e.analyze(25), String(e.see('c3d5')));
    return r.join(' | ') + ' | calls ' + e.calls.now + '/' + e.calls.rnd;
  });
  assert.strictEqual(outs[1], outs[0]);
});

test('small budgets: analyze_floor / think_floor honour floors below 20 / 30 ms, the old exports keep theirs', () => {
  const e = aggro('engine/aggrochess-simd.wasm', { clock: 'fake', step: 0.05 });
  e.pos('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1|');
  const span = (f) => { const t0 = e.calls.now; f(); return e.calls.now - t0; };   // fake clock: js_now calls ~ time searched
  const a20 = span(() => e.analyze(5)), a3 = span(() => e.analyzeFloor(5, 3)), a12 = span(() => e.analyzeFloor(12, 3));
  const t30 = span(() => e.think(5)), t3 = span(() => e.thinkFloor(5, 5, 3));
  assert.ok(a3 < a12 && a12 < a20, [a3, a12, a20].join(' '));
  assert.ok(t3 < t30, [t3, t30].join(' '));
  assert.strictEqual(e.analyzeFloor(30, 3).split(' ').length, 5, 'same answer format');
});

// 2.0.6 (C): the threaded Stockfish builds run under Node too (worker_threads). At Threads 1 both must search exactly like
// the single-thread builds: depth-14 signature over the 10 bench positions (Hash 32, ucinewgame before each), 748 260
// nodes (docs/REFERENCE.md, 2.0.2). The relaxed-SIMD threaded build is a pure speed-up of the npm threaded one.
const SF_SIG14 = { nodes: 748260, moves: 'd5e6 d2d3 e1g1 c4d5 c3b5 e4e5 f5d3 b4b2 f4f5 d4d8' };
function sfSignature(file, depth) {
  const { spawn } = require('child_process');
  const { BENCH_FENS } = require('./_aggro-wasm');
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, file)], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', waiters = [], last = null;
    const timer = setTimeout(() => { p.kill(); reject(new Error(file + ': timeout')); }, 120000);
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (l.startsWith('info depth') && / pv /.test(l) && !/bound/.test(l)) last = l;
        waiters = waiters.filter((w) => { if (w.re.test(l)) { w.r(l); return false; } return true; });
      }
    });
    const send = (x) => p.stdin.write(x + '\n'), until = (re) => new Promise((r) => waiters.push({ re, r }));
    (async () => {
      send('uci'); await until(/^uciok/);
      send('setoption name Threads value 1'); send('setoption name Hash value 32'); send('isready'); await until(/^readyok/);
      let nodes = 0; const moves = [];
      for (const f of BENCH_FENS) {
        send('ucinewgame'); send('isready'); await until(/^readyok/);
        last = null; send('position fen ' + f); send('go depth ' + depth);
        const l = await until(/^bestmove/);
        nodes += +(/ nodes (\d+)/.exec(last)[1]); moves.push(l.split(' ')[1]);
      }
      clearTimeout(timer); send('quit'); setTimeout(() => p.kill(), 300);
      resolve({ nodes, moves: moves.join(' ') });
    })().catch(reject);
  });
}
for (const file of ['engine/stockfish-19-lite.js', 'engine/stockfish-19-lite-rsimd.js']) {
  test(file + ' (threaded) at Threads 1: the depth-14 signature of the single-thread builds', async () => {
    assert.deepStrictEqual(await sfSignature(file, 14), SF_SIG14);
  });
}

run();
