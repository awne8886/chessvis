// 2.0.4 benchmarks of the pure hot spots (not a test): the tracker's gap matcher (E1), chessmini's legalMoves and
// perft (E2), and the background's replay of a game's moves (E2). Plain Node, ~10 s.
//   node tests/bench-pure.js [--json]
'use strict';
const { load } = require('./_load');
const CV = load('boardstate.js');
const BS = CV.boardstate, C = CV.chess;

let seed = 5;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 2 ** 31; };
function playout(fen, plies) {
  const out = [C.parseFen(fen)];
  for (let i = 0; i < plies; i++) {
    const legal = C.legalMoves(out[out.length - 1]);
    if (!legal.length) break;
    out.push(C.apply(out[out.length - 1], legal[Math.floor(rnd() * legal.length)]));
  }
  return out;
}
function time(fn, minMs = 600) {
  let n = 0;
  const t0 = process.hrtime.bigint();
  let el = 0;
  do { fn(); n++; el = Number(process.hrtime.bigint() - t0) / 1e6; } while (el < minMs);
  return el / n;
}
const out = {};
// E1: positions of middlegames, the board two plies later (a missed read) and one ply later
const games = [];
for (let g = 0; g < 20; g++) games.push(playout(CV.STANDARD_START_FEN, 40));
const cases = [];
for (const line of games) for (let k = 8; k + 2 < line.length; k += 6) cases.push([line[k], BS.boardToPlacement(line[k + 1].b), BS.boardToPlacement(line[k + 2].b)]);
out.matchTwo = { cases: cases.length,
  fullMs: +time(() => { for (const [p, , t2] of cases) BS.matchTwoFull(p, t2); }).toFixed(2),
  fastMs: +time(() => { for (const [p, , t2] of cases) BS.matchTwoFast(p, t2); }).toFixed(2) };
out.matchOne = { cases: cases.length,
  fullMs: +time(() => { for (const [p, t1] of cases) BS.matchOneFull(p, t1); }).toFixed(3),
  fastMs: +time(() => { for (const [p, t1] of cases) BS.matchOneFast(p, t1); }).toFixed(3) };
// E2: legalMoves over many positions, perft
const positions = games.flat();
out.legalMoves = { positions: positions.length, ms: +time(() => { for (const p of positions) C.legalMoves(p); }).toFixed(2) };
out.gameState = { positions: positions.length, ms: +time(() => { for (const p of positions) C.gameState(p); }).toFixed(2) };
out.perftStart4Ms = +time(() => C.perft(C.parseFen(CV.STANDARD_START_FEN), 4), 1).toFixed(0);
// E2: replaying a 60-ply game, as every ponder job did (CV.replayUci) vs the cache (CV.createReplayCache) on a game that grows
const long = playout(CV.STANDARD_START_FEN, 80);
const uci = [];
for (let i = 1; i < long.length; i++) {
  const m = C.legalMoves(long[i - 1]).find((x) => BS.boardToPlacement(C.apply(long[i - 1], x).b) === BS.boardToPlacement(long[i].b) && C.apply(long[i - 1], x).turn === long[i].turn);
  uci.push(m.uci);
}
const fullRuns = time(() => { for (let k = 2; k <= uci.length; k += 2) CV.replayUci(CV.STANDARD_START_FEN, uci.slice(0, k)); });
out.replay = { plies: uci.length, fullMs: +fullRuns.toFixed(2) };
if (CV.createReplayCache) {
  out.replay.cacheMs = +time(() => { const rc = CV.createReplayCache(); for (let k = 2; k <= uci.length; k += 2) rc.replay(CV.STANDARD_START_FEN, uci.slice(0, k)); }).toFixed(2);
}
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else { console.log('pure hot spots (ms per batch, lower is better)'); console.log(out); }
