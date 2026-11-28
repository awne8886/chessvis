// 2.0.4 (E1): the tracker's gap matcher only tries moves from squares that changed (boardstate.js matchOneFast /
// matchTwoFast). It must give exactly the 2.0.3 results (matchOneFull / matchTwoFull): the same moves, in the same order,
// with the same positions after them. Random games from varied FENs (castling, en passant, promotions), one or two
// plies dropped, plus targets that no move explains.
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load('boardstate.js');
const BS = CV.boardstate, C = CV.chess;
const { test, run } = runner('tracker-match');

let seed = 2024;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 2 ** 31; };
const FENS = [
  CV.STANDARD_START_FEN,
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',          // kiwipete
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',                                    // en passant
  'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',             // promotions
  'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
  'r3k2r/1P6/8/3pP3/8/8/6p1/R3K2R w KQkq d6 0 1',                                 // ep + promotions both sides + castling
  '4k3/8/8/8/8/8/8/4K2R w K - 0 1',
];
// a random game: prefers captures, promotions and castling now and then, so the special moves are covered
function playout(fen, plies) {
  const out = [C.parseFen(fen)];
  for (let i = 0; i < plies; i++) {
    const pos = out[out.length - 1];
    const legal = C.legalMoves(pos);
    if (!legal.length) break;
    const special = legal.filter((m) => m.promo || m.kind !== 'n' || m.capture);
    const m = special.length && rnd() < 0.45 ? special[Math.floor(rnd() * special.length)] : legal[Math.floor(rnd() * legal.length)];
    out.push(C.apply(pos, m));
  }
  return out;
}
const sig = (res) => JSON.stringify(res.map((r) => (Array.isArray(r) ? r : [r]).map(({ m, next }) =>
  [m.uci, m.from, m.to, m.kind, m.promo, m.piece, m.capture, BS.boardToPlacement(next.b), next.turn, next.ep, next.castle, next.captured])));

test('matchOneFast / matchTwoFast = the 2.0.3 matchers (random games, 1-3 plies dropped, unrelated targets)', () => {
  const n = { one: 0, two: 0, oneHits: 0, twoHits: 0, twoMulti: 0, special: 0 };
  for (let g = 0; g < 140; g++) {
    const line = playout(FENS[g % FENS.length], 40);
    for (let k = 0; k + 1 < line.length; k++) {
      const pos = line[k];
      const targets = [line[k + 1], line[k + 2], line[k + 3], line[Math.floor(rnd() * line.length)]].filter(Boolean).map((p) => BS.boardToPlacement(p.b));
      for (const t of targets) {
        const a1 = BS.matchOneFull(pos, t), b1 = BS.matchOneFast(pos, t);
        assert.strictEqual(sig(b1), sig(a1), 'matchOne ' + t);
        n.one++; if (a1.length) n.oneHits++;
        if (rnd() < 0.5) continue;                       // matchTwoFull is slow: half of them is plenty
        const a2 = BS.matchTwoFull(pos, t), b2 = BS.matchTwoFast(pos, t);
        assert.strictEqual(sig(b2), sig(a2), 'matchTwo ' + t);
        n.two++; if (a2.length) n.twoHits++; if (a2.length > 1) n.twoMulti++;
        if (a2.some(([x, y]) => x.m.kind !== 'n' || y.m.kind !== 'n' || x.m.promo || y.m.promo)) n.special++;
      }
    }
  }
  if (process.env.SHOW) console.log(n);
  assert.ok(n.one > 10000 && n.two > 5000 && n.oneHits > 3000 && n.twoHits > 1000 && n.twoMulti > 0 && n.special > 50, JSON.stringify(n));
});

test('the tracker gives the same events with either matcher', () => {
  for (let g = 0; g < 30; g++) {
    const line = playout(FENS[g % FENS.length], 30);
    const evs = {};
    for (const fast of [false, true]) {
      CV.TRACKER_FAST_MATCH = fast;
      const t = BS.createTracker();
      const out = [];
      const obs = (p) => ({ placement: BS.boardToPlacement(p.b), turn: p.turn, turnKnown: true, castle: BS.castleString(p.castle), ep: p.ep >= 0 ? C.sqName(p.ep) : '-', count: BS.countPieces(BS.boardToPlacement(p.b)), highlighted: true });
      out.push(t.observe(obs(line[0])));
      let k = 1;
      let s2 = 1000 + g;
      while (k < line.length) { out.push(t.observe(obs(line[k]))); s2 = (s2 * 31 + 7) % 97; k += s2 % 3 === 0 ? 2 : 1; }   // drop a ply now and then
      evs[fast] = JSON.stringify(out) + JSON.stringify(t.info());
    }
    assert.strictEqual(evs[true], evs[false]);
  }
  CV.TRACKER_FAST_MATCH = true;
});

test('E3: counters() and history() give info()\'s halfmove / fullmove / startFen / moves at every step', () => {
  for (let g = 0; g < 20; g++) {
    const line = playout(FENS[g % FENS.length], 40);
    const t = BS.createTracker();
    for (const p of line) {
      t.observe({ placement: BS.boardToPlacement(p.b), turn: p.turn, turnKnown: true, castle: BS.castleString(p.castle), ep: p.ep >= 0 ? C.sqName(p.ep) : '-', count: BS.countPieces(BS.boardToPlacement(p.b)), highlighted: true });
      const i = t.info(), c = t.counters(), h = t.history();
      assert.deepStrictEqual(c, { halfmove: i.halfmove, fullmove: i.fullmove });
      assert.strictEqual(h.startFen, i.startFen);
      assert.deepStrictEqual(h.moves.slice(), i.moves);
    }
  }
  const empty = BS.createTracker();
  assert.deepStrictEqual(empty.counters(), { halfmove: empty.info().halfmove, fullmove: empty.info().fullmove });
});

run();
