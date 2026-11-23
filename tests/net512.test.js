// 2.0.3 experiment, not shipped: the (768 x 3 mirrored king buckets -> 512) x 2 network (engine-src/aggrochess,
// cargo feature net512, src/nnue512.rs). Its builds are not in engine/, so this test runs on a directory built with
//
//   tools/build-aggrochess.sh --net512 --out .build/net512
//   node tests/net512.test.js [DIR]            (default .build/net512; skipped when the builds are not there)
//
// tests/fixtures/nnue-eval.txt: positions with the raw output of the network computed outside the engine, from bullet's
// own feature mapping (engine-src/aggrochess/bullet: `pack eval`, written by tests/make-nnue-fixture.js); the engine
// must agree exactly, and its incremental updates (Finny table on king moves) must equal from-scratch builds through
// random games.
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runner } = require('./_load');
const { aggro, ROOT } = require('./_aggro-wasm');
const { test, run } = runner('net512');

const dir = path.resolve(process.argv[2] || path.join(ROOT, '.build', 'net512'));
const BUILDS = ['aggrochess.wasm', 'aggrochess-simd.wasm'].map((f) => path.join(dir, f));
if (!BUILDS.every((f) => fs.existsSync(f))) {
  console.log('net512: skipped (no builds in ' + dir + '; tools/build-aggrochess.sh --net512 --out ' + path.relative(ROOT, dir) + ')');
  process.exit(0);
}

test('the builds are under 3 MB and export the test hooks', () => {
  for (const file of BUILDS) {
    assert.ok(fs.statSync(file).size < 3e6, file + ' is ' + fs.statSync(file).size + ' bytes');
    const names = WebAssembly.Module.exports(new WebAssembly.Module(fs.readFileSync(file))).map((e) => e.name);
    for (const n of ['nn_eval_raw', 'nnue_selftest', 'think', 'analyze']) assert.ok(names.includes(n), file + ' exports ' + n);
  }
});

test('raw evaluations equal bullet\'s (fixture); incremental = from scratch through random games', () => {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'nnue-eval.txt'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 200);
  for (const file of BUILDS) {
    const e = aggro(file, { clock: 'fake' });
    const bad = lines.filter((l) => { const [fen, want] = l.split(' | '); e.pos(fen + '|'); return e.nnRaw() !== Number(want); });
    assert.deepStrictEqual(bad.slice(0, 3), [], file + ': ' + bad.length + ' positions differ');
    for (const fen of ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1']) {
      e.pos(fen + '|');
      assert.strictEqual(e.selftest(12, 100, 3), 0, file + ' ' + fen);
    }
  }
});

test('plain and SIMD builds give the same timed answers (fake clock)', () => {
  const outs = BUILDS.map((file) => {
    const e = aggro(file, { clock: 'fake', step: 0.1 });
    e.pos('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1|');
    return [e.think(50), e.analyze(30)];
  });
  assert.deepStrictEqual(outs[0], outs[1]);
});

run();
