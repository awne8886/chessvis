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
      'game_status', 'in_check', 'side_to_move', 'ponder_move', 'move_see', 'is_book_move', 'clear_hash', 'set_tt_mb', 'last_info']) {
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

run();
