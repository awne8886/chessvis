// Benchmark (not a test, 2.0.3): a match between two AggroChess wasm builds in Node, to check that a new network plays
// at least as well as the old one at the same time per move (speed differences count).
//
//   node tests/match-aggro.js A.wasm B.wasm [--games 200] [--ms 100] [--threads 4] [--seed 1] [--json]
//
// Openings: random 8-ply lines from the start position whose evaluation by A (analyze 100 ms) is within +-120 cp; each
// opening is played twice, colours swapped. Every move is think(ms) on a fresh engine instance per side and game
// (hash cleared), exactly what the extension asks the engine. A game ends by the engine's game status (mate,
// stalemate, 50 moves, insufficient material, threefold) or by adjudication: a side +1000 cp or a mate score in both
// engines' eyes for 6 plies running = win; after ply 120, |score| <= 15 for 10 plies = draw; ply 400 = draw.
// Result from B's point of view: W / D / L, score, Elo difference with a 95% interval (trinomial), and the paired
// (pentanomial) counts per opening pair.
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function engine(file) {
  const ex = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(file)), { env: { js_now: () => performance.now(), js_random: () => Math.random(), js_poll: () => 0 } }).exports;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const write = (t) => { const b = enc.encode(t); new Uint8Array(ex.memory.buffer, ex.io_ptr(), b.length).set(b); return b.length; };
  const read = (n) => dec.decode(new Uint8Array(ex.memory.buffer, ex.io_ptr(), n).slice());
  ex.set_tt_mb(16);
  return {
    pos: (moves) => ex.set_position(write(START + '|' + moves.join(' '))),
    legal: () => read(ex.legal_moves()).split(' ').filter(Boolean).map((x) => x.split(':')[0]),
    think: (ms) => read(ex.think(ms)).split(' '),
    analyze: (ms) => read(ex.analyze(ms)).split(' '),
    status: () => ex.game_status(),
    stm: () => ex.side_to_move(),
    clear: () => ex.clear_hash(),
  };
}

// White-POV centipawns from a think() answer "uci san score depth ..." (score: N, mateN, mate-N or "book")
function whiteCp(score, stm) {
  let cp;
  if (score === 'book' || score === undefined) return 0;
  if (/^mate-/.test(score)) cp = -30000;
  else if (/^mate/.test(score)) cp = 30000;
  else cp = Number(score) || 0;
  return stm === 0 ? cp : -cp;
}

function playGame(files, opening, bIsWhite, ms) {
  // engines[0] plays White
  const eng = bIsWhite ? [engine(files[1]), engine(files[0])] : [engine(files[0]), engine(files[1])];
  const moves = opening.slice();
  let winRun = 0, drawRun = 0;
  for (let ply = moves.length; ply < 400; ply++) {
    const side = ply % 2;                       // 0 = White to move (openings have an even number of plies)
    const e = eng[side];
    e.pos(moves);
    const st = e.status();
    if (st === 1) return side === 0 ? 0 : 1;    // the side to move is mated
    if (st >= 2) return 0.5;
    const out = e.think(ms);
    if (!out[0] || out[0] === 'none') return 0.5;
    const cp = whiteCp(out[2], side);
    moves.push(out[0]);
    if (Math.abs(cp) >= 1000) winRun = Math.sign(cp) === Math.sign(winRun) ? winRun + Math.sign(cp) : Math.sign(cp); else winRun = 0;
    if (Math.abs(winRun) >= 6) return winRun > 0 ? 1 : 0;
    if (ply >= 120 && Math.abs(cp) <= 15) drawRun++; else drawRun = 0;
    if (drawRun >= 10) return 0.5;
  }
  return 0.5;
}

if (!isMainThread) {
  const { files, jobs, ms } = workerData;
  for (const j of jobs) {
    const white = playGame(files, j.opening, j.bIsWhite, ms);
    parentPort.postMessage({ pair: j.pair, bScore: j.bIsWhite ? white : 1 - white });
  }
  parentPort.postMessage({ done: true });
} else {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const files = args.filter((a) => /\.wasm$/.test(a)).slice(0, 2).map((f) => path.resolve(f));
  if (files.length !== 2) { console.error('usage: node tests/match-aggro.js A.wasm B.wasm [--games 200] [--ms 100] [--threads 4] [--seed 1]'); process.exit(2); }
  const games = Number(opt('--games', 200)), ms = Number(opt('--ms', 100)), threads = Number(opt('--threads', 4));
  let s = Number(opt('--seed', 1));
  const rnd = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  const a = engine(files[0]);
  const openings = [];
  while (openings.length < Math.ceil(games / 2)) {
    const line = [];
    for (let i = 0; i < 8; i++) { a.pos(line); const l = a.legal(); if (!l.length) break; line.push(l[rnd(l.length)]); }
    if (line.length < 8) continue;
    a.pos(line);
    if (a.status() !== 0) continue;
    a.clear();
    const an = a.analyze(100);                  // "cp N uci san depth" (White's view) or "mate ..."
    if (an[0] === 'cp' && Math.abs(Number(an[1])) <= 120) openings.push(line);
  }
  const jobs = [];
  openings.forEach((o, i) => { jobs.push({ pair: i, opening: o, bIsWhite: false }, { pair: i, opening: o, bIsWhite: true }); });
  const per = Array.from({ length: threads }, () => []);
  jobs.forEach((j, i) => per[i % threads].push(j));
  const pairs = new Map();
  let w = 0, d = 0, l = 0, finished = 0;
  const t0 = Date.now();
  let running = threads;
  for (const list of per) {
    const wk = new Worker(__filename, { workerData: { files, jobs: list, ms } });
    wk.on('message', (m) => {
      if (m.done) { if (--running === 0) report(); return; }
      if (m.bScore === 1) w++; else if (m.bScore === 0) l++; else d++;
      pairs.set(m.pair, (pairs.get(m.pair) || []).concat(m.bScore));
      finished++;
      if (!args.includes('--json') && finished % 20 === 0) console.log(finished + '/' + jobs.length, 'W/D/L', w, d, l, Math.round((Date.now() - t0) / 1000) + ' s');
    });
    wk.on('error', (e) => { console.error(e); process.exit(1); });
  }
  function report() {
    const n = w + d + l, p = (w + d / 2) / n;
    const elo = (x) => -400 * Math.log10(1 / Math.min(Math.max(x, 1e-6), 1 - 1e-6) - 1);
    const sd = Math.sqrt((w * (1 - p) ** 2 + d * (0.5 - p) ** 2 + l * p ** 2) / n / n);
    const penta = [0, 0, 0, 0, 0];
    for (const v of pairs.values()) if (v.length === 2) penta[Math.round(2 * (v[0] + v[1]))]++;
    const r = { a: path.basename(path.dirname(files[0])) + '/' + path.basename(files[0]), b: path.basename(path.dirname(files[1])) + '/' + path.basename(files[1]), ms, games: n,
      bWins: w, draws: d, bLosses: l, bScore: +p.toFixed(4), eloB: +elo(p).toFixed(1), elo95: [+elo(p - 1.96 * sd).toFixed(1), +elo(p + 1.96 * sd).toFixed(1)], pentanomial: penta,
      seconds: Math.round((Date.now() - t0) / 1000) };
    console.log(args.includes('--json') ? JSON.stringify(r) : r);
  }
}
