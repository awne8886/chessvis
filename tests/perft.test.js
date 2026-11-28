// 2.0.4 (E2): chessmini without per-call allocations in attacked(), hasLegalMove() for gameState / isMate, and the
// background's replay cache. legalMoves must stay exactly as in 2.0.3: the standard perft counts, and a fingerprint of
// every legalMoves list (all fields, in order) plus gameState / isMate / inCheck over 17 654 positions of seeded random
// games, computed with the 2.0.3 chessmini.js (the same sha256 before and after the change).
'use strict';
const assert = require('node:assert');
const crypto = require('crypto');
const { load, runner } = require('./_load');
const CV = load();
const C = CV.chess;
const { test, run } = runner('perft');

test('perft: start position d4, kiwipete d3, two en-passant / promotion positions', () => {
  const cases = [
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 4, 197281],
    ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 3, 97862],
    ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 4, 43238],                         // "position 3": en passant, checks through ep
    ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 3, 9467],     // "position 4": promotions, castling
    ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 3, 62379],          // "position 5": promotion with capture
  ];
  for (const [fen, d, n] of cases) assert.strictEqual(C.perft(C.parseFen(fen), d), n, fen + ' d' + d);
});

// the same generator as the fingerprint was computed with (do not change, or recompute it with the 2.0.3 chessmini.js)
function fingerprint() {
  let seed = 31337; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 2 ** 31; };
  const FENS = ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 'r3k2r/1P6/8/3pP3/8/8/6p1/R3K2R w KQkq d6 0 1', '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', '7k/8/6QK/8/8/8/8/8 b - - 0 1'];
  const h = crypto.createHash('sha256'); let n = 0;
  for (let g = 0; g < 400; g++) {
    let pos = C.parseFen(FENS[g % FENS.length]);
    for (let i = 0; i < 60; i++) {
      const l = C.legalMoves(pos);
      h.update(JSON.stringify(l) + '|' + C.gameState(pos) + C.isMate(pos) + C.inCheck(pos) + C.inCheck(pos, pos.turn === 'w' ? 'b' : 'w')); n++;
      if (!l.length) break;
      const sp = l.filter((m) => m.promo || m.kind !== 'n' || m.capture);
      pos = C.apply(pos, sp.length && rnd() < 0.4 ? sp[Math.floor(rnd() * sp.length)] : l[Math.floor(rnd() * l.length)]);
    }
  }
  return n + ' ' + h.digest('hex');
}

test('legalMoves, gameState, isMate, inCheck: identical to 2.0.3 (fingerprint of 17 654 positions)', () => {
  assert.strictEqual(fingerprint(), '17654 a245d4ed6915d2bb001c42e8abcda321cc06f8dee4f655568499b486579f2562');
  CV.CHESS_EARLY_EXIT = false;                           // the 2.0.3 path gives the same answers
  try { assert.strictEqual(fingerprint(), '17654 a245d4ed6915d2bb001c42e8abcda321cc06f8dee4f655568499b486579f2562'); } finally { CV.CHESS_EARLY_EXIT = true; }
});

test('hasLegalMove = legalMoves(pos).length > 0 (mates, stalemates, positions in check)', () => {
  let seed = 9; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 2 ** 31; };
  let none = 0;
  for (const fen of ['7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', '7k/8/6QK/8/8/8/8/8 b - - 0 1', 'k7/8/1Q6/8/8/8/8/7K b - - 0 1', CV.STANDARD_START_FEN]) {
    let pos = C.parseFen(fen);
    for (let i = 0; i < 200; i++) {
      const l = C.legalMoves(pos);
      assert.strictEqual(C.hasLegalMove(pos), l.length > 0);
      if (!l.length) { none++; pos = C.parseFen(fen); continue; }
      pos = C.apply(pos, l[Math.floor(rnd() * l.length)]);
    }
  }
  assert.ok(none >= 2);
});

test('replay cache = a full replay (extending, shorter, other start, illegal move at any point)', () => {
  let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 2 ** 31; };
  const rc = CV.createReplayCache();
  const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  for (let g = 0; g < 60; g++) {
    const start = g % 3 ? CV.STANDARD_START_FEN : 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    const moves = [];
    let pos = C.parseFen(start);
    for (let i = 0; i < 50; i++) {
      const l = C.legalMoves(pos);
      if (!l.length) break;
      const m = l[Math.floor(rnd() * l.length)];
      moves.push(m.uci); pos = C.apply(pos, m);
      if (i % 2) same(rc.replay(start, moves.slice()), CV.replayUci(start, moves));          // a ponder job every two plies
    }
    const k = Math.floor(rnd() * moves.length);
    same(rc.replay(start, moves.slice(0, k)), CV.replayUci(start, moves.slice(0, k)));        // a takeback
    const bad = [...moves.slice(0, k), 'a1a1'];
    same(rc.replay(start, bad), CV.replayUci(start, bad));                                     // illegal: failedAt counted from the start
    assert.strictEqual(rc.replay(start, bad).failedAt, k);
    same(rc.replay(CV.STANDARD_START_FEN, ['e2e4']), CV.replayUci(CV.STANDARD_START_FEN, ['e2e4']));
  }
});

run();
