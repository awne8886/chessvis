// The real background.js with fake workers (tests/_fakebg.js): delay-matched search (T3), early ponder -> hit / miss (T1),
// PV seed (T6), deepening passes (T7). Timing-based with generous margins.
'use strict';
const assert = require('node:assert');
const { runner } = require('./_load');
const { makeBackground, sleep, CV, best } = require('./_fakebg');
const { test, run } = runner('background-sim');
const START = CV.STANDARD_START_FEN;
const after = (moves) => CV.replayUci(START, moves).pos;
const fenOf = (moves) => { const p = after(moves); return p; };

const analyzeSf = (bg, moves, extra) => bg.send({ type: 'analyze', engine: 'stockfish', fen: START, startFen: START, moves, depth: 10, imperfection: 0, sfMaxMs: 0, ...extra });

test('T3: delay mode searches through softMs with go depth 64, then stops (depth >= minimum)', async () => {
  const bg = makeBackground({ stepMs: 10 });
  const t0 = Date.now();
  const r = await analyzeSf(bg, [], { sfSearchMode: 'delay', softMs: 200 });
  const ms = Date.now() - t0;
  assert.ok(r && r.uci, 'a move');
  assert.ok(bg.log.some((l) => l.cmd === 'go depth 64'), 'go depth 64 sent');
  const last = bg.get('sfLast');
  assert.strictEqual(last.mode, 'delay');
  assert.ok(last.depthDone >= 10 && last.depthDone > 12, 'deeper than the minimum: ' + last.depthDone);
  assert.ok(ms >= 190 && ms < 900, 'stopped near soft: ' + ms);
  assert.strictEqual(bg.log.filter((l) => l.cmd === 'stop').length, 1, 'stop sent once');
});

test('T3: depth mode = go depth N (1.8.0); soft 0 also searches like depth', async () => {
  const bg = makeBackground({ stepMs: 2 });
  await analyzeSf(bg, [], { sfSearchMode: 'depth', softMs: 500 });
  assert.ok(bg.log.some((l) => l.cmd === 'go depth 10'));
  assert.ok(!bg.log.some((l) => l.cmd === 'go depth 64'));
  await analyzeSf(bg, ['e2e4', 'e7e5'], { sfSearchMode: 'delay', softMs: 0 });
  assert.strictEqual(bg.log.filter((l) => l.cmd === 'go depth 64').length, 0);
  assert.strictEqual(bg.get('sfLast').mode, 'depth');
});

test('T3: the hard cap stops a delay search that cannot reach the minimum depth', async () => {
  const bg = makeBackground({ stepMs: 200 });           // depth 10 would need 2 s
  const t0 = Date.now();
  await analyzeSf(bg, [], { sfSearchMode: 'delay', softMs: 100, sfMaxMs: 500 });
  const ms = Date.now() - t0;
  assert.ok(ms >= 480 && ms < 1200, 'stopped at the 500 ms cap: ' + ms);
  assert.ok(bg.get('sfLast').depthDone < 10);
});

test('T1 + T6: early ponder after our move -> the opponent plays the predicted move -> instant hit (PV seed)', async () => {
  const bg = makeBackground({ stepMs: 5 });
  const r = await analyzeSf(bg, ['e2e4', 'e7e5'], { sfSearchMode: 'delay', softMs: 120, ponder: true });
  const ours = r.uci;
  const lmp = bg.get('lastMainPv');
  assert.strictEqual(lmp.pv[0], ours);
  const moves = ['e2e4', 'e7e5', ours];
  await bg.send({ type: 'aggroIdle', engine: 'stockfish', startFen: START, moves, ponder: true, ponderMs: 600, ponderWorkers: 2, ponderHashMb: 16, depth: 10, myColor: 'w', ponderUntilMove: true, ponderMaxMs: 3000, sfSearchMode: 'delay' });
  const seeded = bg.get('ponder.get().results')[lmp.pv[1]];
  assert.ok(seeded && seeded.uci === lmp.pv[2], 'seeded at once from the PV');
  assert.strictEqual(bg.get('sfDbg.pvSeeds'), 1);
  await sleep(150);
  const hit = await analyzeSf(bg, [...moves, lmp.pv[1]], { sfSearchMode: 'delay', softMs: 120, ponder: true });
  assert.strictEqual(hit.ponderHit, true);
  assert.strictEqual(hit.uci, best(CV.replayUci(START, [...moves, lmp.pv[1]]).pos));
  assert.strictEqual(bg.get('ponder.counters.hits'), 1);
  assert.ok(bg.get('ponder.counters.lastLeadMs') >= 140);
});

test('T1: a discarded early move -> miss, normal search', async () => {
  const bg = makeBackground({ stepMs: 5 });
  await bg.send({ type: 'aggroIdle', engine: 'stockfish', startFen: START, moves: ['e2e4', 'e7e5', 'g1f3'], ponder: true, ponderMs: 600, ponderWorkers: 1, ponderHashMb: 16, depth: 10, myColor: 'w', ponderUntilMove: false, sfSearchMode: 'depth' });
  await sleep(400);
  assert.ok(bg.get('ponder.found()') > 0, 'replies were prepared');
  const r = await analyzeSf(bg, ['e2e4', 'e7e5', 'b1c3', 'b8c6'], { sfSearchMode: 'depth', ponder: true });
  assert.ok(!r.ponderHit);
  assert.strictEqual(bg.get('ponder.counters.misses'), 1);
});

test('T7: deepening passes replace shallower results and keep going until the opponent moves', async () => {
  const bg = makeBackground({ stepMs: 5 });
  const moves = ['e2e4', 'e7e5', 'g1f3'];
  await bg.send({ type: 'aggroIdle', engine: 'stockfish', startFen: START, moves, ponder: true, ponderMs: 600, ponderWorkers: 2, ponderHashMb: 16, depth: 10, myColor: 'w', ponderUntilMove: true, ponderMaxMs: 6000, sfSearchMode: 'delay' });
  await sleep(500);
  const top = bg.get('ponder.get()');
  const firstDepths = Object.values(top.results).map((r) => r.depth);
  assert.ok(firstDepths.length > 0 && Math.max(...firstDepths) <= 10, 'pass 1 is depth-capped: ' + firstDepths);
  await sleep(1600);
  assert.ok(bg.get('ponderDbg.lastPasses') >= 2, 'passes: ' + bg.get('ponderDbg.lastPasses'));
  const deeper = Object.values(bg.get('ponder.get().results')).filter((r) => r.depth > 10);
  assert.ok(deeper.length >= 1, 'a deepening pass stored a deeper reply');
  assert.ok(bg.get('idleInfo.pondering'), 'still pondering after the 600 ms budget');
  // the opponent moves: a hit on a deepened move uses the deep result (or an even deeper harvest)
  const opp = Object.keys(bg.get('ponder.get().results')).find((u) => bg.get('ponder.get().results')[u].depth > 10);
  const r = await analyzeSf(bg, [...moves, opp], { sfSearchMode: 'delay', softMs: 100, ponder: true });
  assert.strictEqual(r.ponderHit, true);
  assert.ok(r.depth > 10, 'used depth ' + r.depth);
  assert.ok(!bg.get('idleInfo.pondering'), 'stopped by the real search');
  assert.ok(bg.get('ponderDbg.hitDepths').length === 1);
});

test('T7: with ponderUntilMove off the old budget applies (one pass, ends by ponderMs)', async () => {
  const bg = makeBackground({ stepMs: 5 });
  await bg.send({ type: 'aggroIdle', engine: 'stockfish', startFen: START, moves: ['e2e4'], ponder: true, ponderMs: 400, ponderWorkers: 1, ponderHashMb: 16, depth: 10, myColor: 'w', ponderUntilMove: false, sfSearchMode: 'delay' });
  await sleep(900);
  assert.ok(!bg.get('idleInfo.pondering'), 'finished');
  assert.ok(Object.values(bg.get('ponder.get().results')).every((r) => r.depth <= 10));
});

test('T7: depth mode with ponderUntilMove stops after pass 1 when every top result has depth N', async () => {
  const bg = makeBackground({ stepMs: 2 });
  await bg.send({ type: 'aggroIdle', engine: 'stockfish', startFen: START, moves: ['e2e4'], ponder: true, ponderMs: 1500, ponderWorkers: 1, ponderHashMb: 16, depth: 6, myColor: 'w', ponderUntilMove: true, ponderMaxMs: 8000, sfSearchMode: 'depth' });
  await sleep(1500);
  assert.ok(!bg.get('idleInfo.pondering'), 'nothing left to deepen');
  assert.ok(bg.get('ponderDbg.lastPasses') <= 1);
});

test('AggroChess: delay-matched budget and the predicted reply first', async () => {
  const bg = makeBackground({});
  const t0 = Date.now();
  const r = await bg.send({ type: 'analyze', engine: 'aggro', fen: START, startFen: START, moves: [], ms: 200, softMs: 400 });
  assert.ok(r.uci && Date.now() - t0 >= 380, 'thought max(thinkMs, softMs)');
  assert.strictEqual(JSON.stringify(bg.get('aggroDbg.lastBudget')), JSON.stringify({ ms: 400 }));
  const moves = ['e2e4'];
  await bg.send({ type: 'aggroIdle', startFen: START, moves, ponder: true, showEval: false, ponderMs: 1500, ponderWorkers: 2, ponderHashMb: 32, myColor: 'w', ponderUntilMove: false });
  const predicted = best(CV.replayUci(START, moves).pos);
  await sleep(60);
  assert.ok(bg.get('ponder.runningMoves()').includes(predicted), 'the predicted move is searched first');
  await sleep(300);                                     // one slice: 1500 / 6 = 250 ms
  assert.ok(bg.get('ponder.get().results')[predicted], 'its reply is ready after one slice');
});

test('T8: AggroChess late with the reply almost done -> wait for it, other ponder workers killed', async () => {
  const bg = makeBackground({});
  const moves = ['e2e4'];
  const predicted = best(CV.replayUci(START, moves).pos);
  await bg.send({ type: 'aggroIdle', startFen: START, moves, ponder: true, showEval: false, ponderMs: 1500, ponderWorkers: 2, ponderHashMb: 32, myColor: 'w', ponderUntilMove: false });
  await sleep(150);                                      // the predicted reply (250 ms slice) is half done
  const t0 = Date.now();
  const r = await bg.send({ type: 'analyze', engine: 'aggro', fen: START, startFen: START, moves: [...moves, predicted], ms: 1000, ponder: true });
  const ms = Date.now() - t0;
  assert.strictEqual(r.ponderHit, true);
  assert.strictEqual(r.late, true);
  assert.ok(ms < 400, 'waited only for the rest of the slice: ' + ms);
  assert.strictEqual(bg.get('ponderDbg.lateWaitHits'), 1);
  assert.strictEqual(bg.get('ponderActive.length'), 0);
});

test('T8: late with too much left -> no wait, normal think', async () => {
  const bg = makeBackground({});
  const moves = ['e2e4'];
  const predicted = best(CV.replayUci(START, moves).pos);
  await bg.send({ type: 'aggroIdle', startFen: START, moves, ponder: true, showEval: false, ponderMs: 3600, ponderWorkers: 1, ponderHashMb: 32, myColor: 'w', ponderUntilMove: false });
  await sleep(50);                                       // slice 600 ms, 550 + 70 left > 400
  const r = await bg.send({ type: 'analyze', engine: 'aggro', fen: START, startFen: START, moves: [...moves, predicted], ms: 300, ponder: true });
  assert.ok(!r.ponderHit);
  assert.strictEqual(bg.get('ponderDbg.lateWaits'), 0);
});

test('T9: clock mode sends go wtime/btime, stops at the hard cap', async () => {
  const bg = makeBackground({ stepMs: 10 });
  const t0 = Date.now();
  await analyzeSf(bg, [], { sfSearchMode: 'clock', softMs: 100, sfMaxMs: 300, uciClock: { wtime: 60000, btime: 50000, winc: 0, binc: 0 } });
  const ms = Date.now() - t0;
  assert.ok(bg.log.some((l) => l.cmd === 'go wtime 60000 btime 50000 winc 0 binc 0'));
  assert.ok(ms >= 290 && ms < 800, 'hard cap: ' + ms);
  assert.strictEqual(bg.get('sfLast').mode, 'clock');
});

test('T9: clock mode that answers before softMs continues as a delay search; no clock = delay/depth', async () => {
  const bg = makeBackground({ stepMs: 10 });
  const t0 = Date.now();
  await analyzeSf(bg, [], { sfSearchMode: 'clock', softMs: 300, uciClock: { wtime: 3000, btime: 3000, winc: 0, binc: 0 } });   // fake: 3000 / 30 = 100 ms
  const ms = Date.now() - t0;
  assert.ok(ms >= 290, 'kept searching through the pause: ' + ms);
  assert.ok(bg.log.some((l) => l.cmd === 'go depth 64'));
  assert.strictEqual(bg.get('sfLast').mode, 'delay (clock, extended)');
  await analyzeSf(bg, ['e2e4'], { sfSearchMode: 'clock', softMs: 50, uciClock: null });
  assert.strictEqual(bg.get('sfLast').mode, 'delay');
  assert.strictEqual(CV.sfClockGo({ wtime: 1000, btime: 0 }), null);
  assert.strictEqual(CV.sfClockGo({ wtime: 61000.4, btime: 59000, winc: 2000, binc: 2000 }), 'go wtime 61000 btime 59000 winc 2000 binc 2000');
});

test('T10: the main Stockfish worker is warmed up before the first search', async () => {
  const bg = makeBackground({ stepMs: 2 });
  await analyzeSf(bg, [], { sfSearchMode: 'depth' });
  const mainId = bg.log.find((l) => l.cmd === 'go depth 10').w;
  const main = bg.log.filter((l) => l.w === mainId).map((l) => l.cmd);
  const iWarm = main.indexOf('go movetime 10'), iFirst = main.indexOf('go depth 10');
  assert.ok(iWarm >= 0 && iWarm < iFirst, main.join(' | '));
  assert.ok(main[iWarm - 1].startsWith('position fen r3k2r/'), 'the warm-up position');
  assert.ok(typeof bg.get('sfDbg.mainWarmMs') === 'number');
});

run();
