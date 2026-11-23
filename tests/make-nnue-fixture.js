// Tool (not a test, 2.0.3): writes tests/fixtures/nnue-eval.txt for tests/engine-signature.test.js: positions from
// random games played through the engine (both sides to move, kings on both halves of the board, castled and not), each
// with the raw network output computed OUTSIDE the engine by `pack eval` (bullet's own feature mapping on the quantised
// network bullet saved). Run it whenever the network changes:
//
//   node tests/make-nnue-fixture.js <engine.wasm> <quantised.bin> [--games 40]
// (pack is built by `cargo build --release` in engine-src/aggrochess/bullet)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { aggro } = require('./_aggro-wasm');

const args = process.argv.slice(2);
const [wasm, quantised] = args;
const games = Number(args.includes('--games') ? args[args.indexOf('--games') + 1] : 40);
const PACK = path.join(__dirname, '..', 'engine-src', 'aggrochess', 'bullet', 'target', 'release', 'pack');
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const e = aggro(wasm, { clock: 'fake' });
let s = 2026;
const rnd = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
const fens = [];
for (let g = 0; g < games; g++) {
  const moves = [];
  for (let ply = 0; ply < 100; ply++) {
    e.pos(START + '|' + moves.join(' '));
    const legal = e.legal().split(' ').filter(Boolean).map((x) => x.split(':')[0]);
    if (!legal.length) break;
    moves.push(legal[rnd(legal.length)]);
    if (ply % 5 === 4) { e.pos(START + '|' + moves.join(' ')); fens.push(e.fen()); }
  }
}
const list = path.join(require('os').tmpdir(), 'nnue-fixture-fens.txt');
fs.writeFileSync(list, fens.join('\n') + '\n');
const raw = execFileSync(PACK, ['eval', quantised, list]).toString().trim().split('\n');
if (raw.length !== fens.length) throw new Error('pack eval gave ' + raw.length + ' values for ' + fens.length + ' positions');
const out = path.join(__dirname, 'fixtures', 'nnue-eval.txt');
fs.writeFileSync(out, fens.map((f, i) => f + ' | ' + raw[i]).join('\n') + '\n');
console.log(out + ': ' + fens.length + ' positions');
