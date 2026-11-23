// Benchmark (not a test, 2.0.2 A4): how well the AggroChess ponder job's ranking pass predicts the opponent's move, with
// the 2.0.0 analyze floor (every scan at least 20 ms) and the 2.0.2 floor (3 ms: a 12 ms scan takes 12 ms).
//
//   node tests/bench-ponder-rank.js [--wasm engine/aggrochess-simd.wasm] [--positions 40] [--budget 1500] [--json]
//
// Positions: AggroChess self-play games (think 30 ms) from seeded random openings, every 5th position after the first
// 8 plies (the opponent to move). The opponent: AggroChess think(150) from an empty hash. The ranking, as in
// background.js runIdleJob with one ponder worker: one analysis after every legal opponent move (scanMs = max(5, min(12,
// budget x 0.35 / legal moves))), our score after it, lowest first; the pass stops when its window (budget x 0.35) is
// used up and the moves it did not reach go last. Counted: how often the opponent's real move is in the top k.
// A real clock is used (the floors are about time), so numbers vary a little run to run.
'use strict';
const { aggro } = require('./_aggro-wasm');
const { load } = require('./_load');
const CV = load();

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const WASM = opt('--wasm', 'engine/aggrochess-simd.wasm');
const N = Number(opt('--positions', 40));
const BUDGET = Number(opt('--budget', 1500));
const START = CV.STANDARD_START_FEN;

let seed = Number(opt("--seed", 7));
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 2 ** 31; };

function positions(n) {
  const e = aggro(WASM, { clock: 'real' });
  const out = [];
  while (out.length < n) {
    e.ex.clear_hash();
    let moves = [];
    for (let ply = 0; ply < 48 && out.length < n; ply++) {
      const pos = CV.replayUci(START, moves).pos;
      const legal = CV.chess.legalMoves(pos);
      if (!legal.length) break;
      let m;
      if (ply < 6) m = legal[Math.floor(rnd() * legal.length)].uci;
      else { e.pos(moves.join(' ')); m = e.think(30).split(' ')[0]; if (!m || m === 'none') break; }
      moves = [...moves, m];
      if (ply >= 8 && ply % 5 === 3 && CV.chess.legalMoves(CV.replayUci(START, moves).pos).length > 1) out.push(moves.slice());
    }
  }
  return out;
}

// our score (side NOT to move in `moves`) after opponent move m; lower = better for the opponent
function scan(e, moves, m, ms, floor) {
  e.pos([...moves, m].join(' '));
  const out = (floor === null ? e.analyze(ms) : e.analyzeFloor(ms, floor)).split(' ');
  if (out[0] === 'none') return null;
  const ourColor = CV.replayUci(START, moves).pos.turn === 'w' ? 'b' : 'w';
  const v = parseInt(out[1], 10) * (ourColor === 'b' ? -1 : 1);
  return out[0] === 'mate' ? (v > 0 ? 100000 - Math.abs(v) : -100000 + Math.abs(v)) : v;
}

function rank(e, moves, floor) {
  const legal = CV.chess.legalMoves(CV.replayUci(START, moves).pos).map((m) => m.uci);
  const scanMs = Math.max(5, Math.min(12, Math.floor((BUDGET * 0.35) / legal.length)));
  const windowMs = BUDGET * 0.35;
  const score = new Map();
  const t0 = performance.now();
  let reached = 0;
  for (const m of legal) {
    if (performance.now() - t0 > windowMs) break;
    score.set(m, scan(e, moves, m, scanMs, floor));
    reached++;
  }
  const ms = performance.now() - t0;
  const list = legal.filter((u) => score.get(u) !== null)
    .sort((x, y) => (score.has(x) ? score.get(x) : Infinity) - (score.has(y) ? score.get(y) : Infinity));
  return { list, ms, reached, legal: legal.length, scanMs };
}

function main() {
  const pos = positions(N);
  const opp = aggro(WASM, { clock: 'real' });
  const variants = [{ name: '2.0.0 floor 20 ms', floor: null }, { name: '2.0.2 floor 3 ms', floor: 3 }];
  const res = variants.map(() => ({ top: { 1: 0, 3: 0, 5: 0, 8: 0 }, ms: 0, reached: 0, legal: 0 }));
  const rankers = variants.map(() => aggro(WASM, { clock: 'real' }));
  for (const moves of pos) {
    opp.ex.clear_hash(); opp.pos(moves.join(' '));
    const reply = opp.think(150).split(' ')[0];
    variants.forEach((v, i) => {                                  // interleaved per position
      rankers[i].ex.clear_hash();
      const r = rank(rankers[i], moves, v.floor);
      const at = r.list.indexOf(reply);
      for (const k of [1, 3, 5, 8]) if (at >= 0 && at < k) res[i].top[k]++;
      res[i].ms += r.ms; res[i].reached += r.reached; res[i].legal += r.legal;
    });
  }
  const table = variants.map((v, i) => ({
    ranking: v.name,
    'top 1': Math.round((100 * res[i].top[1]) / pos.length) + '%',
    'top 3': Math.round((100 * res[i].top[3]) / pos.length) + '%',
    'top 5': Math.round((100 * res[i].top[5]) / pos.length) + '%',
    'top 8': Math.round((100 * res[i].top[8]) / pos.length) + '%',
    'pass ms (mean)': Math.round(res[i].ms / pos.length),
    'moves ranked': (res[i].reached / pos.length).toFixed(1) + ' / ' + (res[i].legal / pos.length).toFixed(1),
  }));
  if (args.includes('--json')) console.log(JSON.stringify(table, null, 2));
  else { console.log(pos.length + ' positions, opponent AggroChess think(150), ranking budget ' + BUDGET + ' ms (window ' + Math.round(BUDGET * 0.35) + ' ms), ' + WASM); console.table(table); }
}
main();
