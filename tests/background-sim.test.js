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

// ---- 2.0.2 C2: ponder hits never lose depth ----
test('C2 Stockfish: a hit answers at once (provisional) and the main worker deepens it within hitSoftMs', async () => {
  const bg = makeBackground({ stepMs: 5 });
  const moves = ['e2e4', 'e7e5', 'g1f3'];
  await bg.send({ type: 'aggroIdle', engine: 'stockfish', startFen: START, moves, ponder: true, ponderMs: 600, ponderWorkers: 1, ponderHashMb: 16, depth: 10, myColor: 'w', ponderUntilMove: false, sfSearchMode: 'delay' });
  await sleep(450);
  const results = bg.get('ponder.get().results');
  const opp = Object.keys(results)[0];
  assert.ok(results[opp].depth <= 10, 'pass-1 reply: ' + results[opp].depth);
  const t0 = Date.now();
  const r = await analyzeSf(bg, [...moves, opp], { sfSearchMode: 'delay', softMs: 300, ponder: true, hitSoftMs: 150 });
  assert.ok(Date.now() - t0 < 60, 'answered at once');
  assert.strictEqual(r.ponderHit, true);
  assert.ok(r.topUp && r.topUp.id && r.topUp.ms >= 100, JSON.stringify(r.topUp));
  const fin = await bg.send({ type: 'hitTopUp', id: r.topUp.id });
  const ms = Date.now() - t0;
  assert.ok(ms >= 140 && ms < 450, 'the top-up used the pause: ' + ms);
  assert.ok(fin.used && fin.depth > fin.before, JSON.stringify(fin));
  assert.strictEqual(fin.uci, best(CV.replayUci(START, [...moves, opp]).pos));
  assert.strictEqual(bg.get('sfLast.topUp'), true);
  assert.strictEqual(JSON.stringify(bg.get('ponderDbg.topUpDepths')[0].slice(0, 2)), JSON.stringify([fin.before, fin.depth]));
  assert.strictEqual(await bg.send({ type: 'hitTopUp', id: r.topUp.id }), null, 'a result is handed out once');
});

test('C2 Stockfish: no top-up without hitSoftMs (2.0.0) or when the stored reply is already deeper than expected', async () => {
  const bg = makeBackground({ stepMs: 5 });
  await analyzeSf(bg, ['e2e4'], { sfSearchMode: 'delay', softMs: 100 });   // a depth-time sample (~20 depths in 100 ms)
  const moves = ['e2e4', 'e7e5', 'g1f3'];
  await bg.send({ type: 'aggroIdle', engine: 'stockfish', startFen: START, moves, ponder: true, ponderMs: 600, ponderWorkers: 1, ponderHashMb: 16, depth: 10, myColor: 'w', ponderUntilMove: false, sfSearchMode: 'delay' });
  await sleep(450);
  const opps = Object.keys(bg.get('ponder.get().results'));
  const r0 = await analyzeSf(bg, [...moves, opps[0]], { sfSearchMode: 'delay', softMs: 300, ponder: true });
  assert.ok(r0.ponderHit && !r0.topUp, 'no hitSoftMs: the 2.0.0 hit');
  await bg.send({ type: 'aggroIdle', engine: 'stockfish', startFen: START, moves, ponder: true, ponderMs: 600, ponderWorkers: 1, ponderHashMb: 16, depth: 10, myColor: 'w', ponderUntilMove: false, sfSearchMode: 'delay' });
  await sleep(450);
  const opp = Object.keys(bg.get('ponder.get().results'))[0];
  bg.get('ponder.get().results[' + JSON.stringify(opp) + '].depth = 60');     // as if a deepening pass got very deep
  const r1 = await analyzeSf(bg, [...moves, opp], { sfSearchMode: 'delay', softMs: 300, ponder: true, hitSoftMs: 60 });
  assert.ok(r1.ponderHit && !r1.topUp, 'expected depth in 60 ms is below 60');
});

test('C2 AggroChess: think(pause) on the main worker when the pause is at least the slice; the move can change', async () => {
  const bg = makeBackground({});
  const moves = ['e2e4'];
  await bg.send({ type: 'aggroIdle', startFen: START, moves, ponder: true, showEval: false, ponderMs: 900, ponderWorkers: 1, ponderHashMb: 32, myColor: 'w', ponderUntilMove: false });
  await sleep(1000);
  const opp = best(CV.replayUci(START, moves).pos);
  const stored = bg.get('ponder.get().results')[opp];
  assert.ok(stored && stored.ms === 150, JSON.stringify(stored));   // slice = 900 / 6
  // shorter pause than the slice: the prepared reply as in 2.0.0
  const r0 = await bg.send({ type: 'analyze', engine: 'aggro', fen: START, startFen: START, moves: [...moves, opp], ms: 1000, ponder: true, hitSoftMs: 100 });
  assert.ok(r0.ponderHit && !r0.topUp);
  // again, with a pause of 200 ms and a planted (different) prepared reply
  await bg.send({ type: 'aggroIdle', startFen: START, moves, ponder: true, showEval: false, ponderMs: 900, ponderWorkers: 1, ponderHashMb: 32, myColor: 'w', ponderUntilMove: false });
  await sleep(1000);
  bg.get('ponder.get().results[' + JSON.stringify(opp) + '] = { uci: "h2h4", san: "h4", depth: 15, sacrifice: false, ms: 150 }');
  const r1 = await bg.send({ type: 'analyze', engine: 'aggro', fen: START, startFen: START, moves: [...moves, opp], ms: 1000, ponder: true, hitSoftMs: 200 });
  assert.strictEqual(r1.uci, 'h2h4', 'provisional = the prepared reply');
  assert.ok(r1.topUp);
  assert.ok(bg.get('aggroThinking') > 0, 'counts as a real search while it runs (no spare is made)');
  const fin = await bg.send({ type: 'hitTopUp', id: r1.topUp.id });
  assert.strictEqual(fin.uci, best(CV.replayUci(START, [...moves, opp]).pos));
  assert.ok(fin.changed && fin.used && fin.depth >= 15, JSON.stringify(fin));
  assert.strictEqual(bg.get('ponderDbg.hitChanged'), 1);
  assert.strictEqual(bg.get('aggroThinking'), 0);
});

// ---- 2.0.2 B1: the relaxed-SIMD Stockfish build ----
test('B1: the relaxed-SIMD build is used where the probe validates, for the main and the ponder workers', async () => {
  const bg = makeBackground({ stepMs: 2, wasm: { relaxed: true } });
  await analyzeSf(bg, [], { sfSearchMode: 'depth' });
  assert.strictEqual(bg.get('sfActive'), 'engine/stockfish-19-lite-single-rsimd.js');
  const main = bg.workers.find((w) => w.kind === 'sf' && w.init);
  assert.strictEqual(main.init.loader, 'stockfish-19-lite-single-rsimd.js');
  assert.ok(/sf-worker\.js#.*rsimd\.wasm/.test(decodeURIComponent(main.url)), main.url);
  await bg.send({ type: 'aggroIdle', engine: 'stockfish', startFen: START, moves: ['e2e4'], ponder: true, ponderMs: 300, ponderWorkers: 1, ponderHashMb: 16, depth: 6, myColor: 'w', ponderUntilMove: false, sfSearchMode: 'depth' });
  await sleep(100);
  assert.ok(bg.workers.filter((w) => w.kind === 'sf' && w.init).every((w) => w.init.loader === 'stockfish-19-lite-single-rsimd.js'));
  const dbg = await bg.send({ type: 'aggroDebug' });
  assert.strictEqual(dbg.stockfish.relaxedSimd.probe, true);
});

test('B1: no relaxed SIMD -> the plain build; a relaxed build that fails to start -> the plain build for good', async () => {
  const bg = makeBackground({ stepMs: 2, wasm: { relaxed: false } });
  await analyzeSf(bg, [], { sfSearchMode: 'depth' });
  assert.strictEqual(bg.get('sfActive'), 'engine/stockfish-19-lite-single.js');
  assert.strictEqual(bg.workers.find((w) => w.kind === 'sf' && w.init).init.loader, 'stockfish-19-lite-single.js');
  const bg2 = makeBackground({ stepMs: 2, wasm: { relaxed: true, failRsimd: true } });
  const r = await analyzeSf(bg2, [], { sfSearchMode: 'depth' });
  assert.ok(r && r.uci, 'still plays');
  assert.strictEqual(bg2.get('sfActive'), 'engine/stockfish-19-lite-single.js');
  assert.ok(/relaxed SIMD build failed/.test(bg2.get('sfDbg.rsimdFailed')));
  assert.strictEqual(JSON.stringify(bg2.get('sfCandidates()')), JSON.stringify(['engine/stockfish-19-lite-single.js']));
});

// 2.0.3: seen on a phone with 2.0.2: a delay search ran 4 752 ms with a 3 000 ms cap, and 27 Stockfish workers were started
// for 31 ponder jobs. The debug info now says why and when `stop` was sent, how long the bestmove took after it and how late
// the timers fired, counts overruns, and counts terminated Stockfish workers by reason.
test('2.0.3: Stockfish debug info: why/when the main search was stopped, overruns, kill reasons', async () => {
  const slow = makeBackground({ stepMs: 200, sfStopDelayMs: 400 });   // the minimum depth needs 2 s; stop takes 400 ms
  await analyzeSf(slow, [], { sfSearchMode: 'delay', softMs: 100, sfMaxMs: 300 });
  const l = slow.get('sfLast');
  assert.strictEqual(l.stopBy, 'hard timer');
  assert.ok(l.stopAtMs >= 290 && l.stopAtMs < 600, 'stop at the cap: ' + l.stopAtMs);
  assert.ok(l.replyAfterStopMs >= 380, 'bestmove 400 ms after stop: ' + l.replyAfterStopMs);
  assert.ok(l.hardTimerLateMs >= 0 && l.hardTimerLateMs < 150 && l.softTimerLateMs >= 0, JSON.stringify(l));
  assert.strictEqual(slow.get('sfDbg.overruns'), 1);
  assert.strictEqual(slow.get('sfDbg.lastOverruns')[0].elapsedMs, l.elapsedMs);

  const fast = makeBackground({ stepMs: 10 });
  await analyzeSf(fast, [], { sfSearchMode: 'delay', softMs: 200 });
  const f = fast.get('sfLast');
  assert.ok(['info', 'soft timer'].includes(f.stopBy) && f.replyAfterStopMs < 100 && Array.isArray(f.lastDepthAt), JSON.stringify(f));
  assert.strictEqual(fast.get('sfDbg.overruns'), 0);
  const superseding = analyzeSf(fast, ['e2e4'], { sfSearchMode: 'delay', softMs: 400 });
  await sleep(50);
  await analyzeSf(fast, ['e2e4', 'e7e5'], { sfSearchMode: 'delay', softMs: 50 });
  await superseding;
  assert.strictEqual(fast.get('sfDbg.lastOverruns').length, 0);

  // ponder workers that do not answer `stop` within 1.5 s are terminated: counted by reason
  // (and a new job that had claimed such a worker gets a new one in its place)
  const stuck = makeBackground({ stepMs: 50, sfHangOnStop: true });       // depth 10 needs 500 ms: mid-search at 300 ms
  await stuck.send(sfIdle(['e2e4'], { ponderWorkers: 1 }));
  await sleep(300);
  await stuck.send(sfIdle(['e2e4', 'e7e5', 'g1f3'], { ponderWorkers: 1 }));
  await sleep(1800);
  const kills = stuck.get('sfDbg.kills');
  assert.ok(kills['no bestmove after stop'] >= 1, JSON.stringify(kills));
  assert.strictEqual(stuck.get('sfDbg.claimReplaced'), 1);
  assert.ok(stuck.get('ponderActive.filter((w) => !w.dead && w.task).length') === 1, 'the job searches on its new worker');
  await stuck.send({ type: 'aggroInvalidate' });
});

const sfIdle = (moves, extra) => ({ type: 'aggroIdle', engine: 'stockfish', startFen: START, moves, ponder: true, ponderMs: 3000, ponderWorkers: 2, ponderHashMb: 16, depth: 10, myColor: 'w', ponderUntilMove: true, ponderMaxMs: 5000, sfSearchMode: 'delay', ...extra });
// 2.0.3: the next ponder job begins while the last job's Stockfish workers are still answering `stop` (right after a
// hit, or the early ponder after our move): it takes them instead of starting new workers and terminating them after.
async function sfJobSwitch(claim) {
  const bg = makeBackground({ stepMs: 5, sfStopDelayMs: 20 });
  bg.get('CV.SF_CLAIM_STOPPING = ' + claim);
  const sfCount = () => bg.workers.filter((w) => w.kind === 'sf').length;
  await bg.send(sfIdle(['e2e4']));
  await sleep(300);
  const before = sfCount();
  for (const moves of [['e2e4', 'e7e5', 'g1f3'], ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'], ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4']]) {
    await bg.send(sfIdle(moves));
    await sleep(250);
  }
  const out = { started: sfCount() - before, kills: bg.get('sfDbg.kills'), claimed: bg.get('sfDbg.claimedWhileStopping'), pondering: bg.get('idleInfo.pondering'),
    found: bg.get('ponder.get().results') ? Object.keys(bg.get('ponder.get().results')).length : 0 };
  await bg.send({ type: 'aggroInvalidate' });
  return out;
}
test('2.0.3: a new Stockfish ponder job takes the workers that are still stopping (no new workers)', async () => {
  const on = await sfJobSwitch(true), off = await sfJobSwitch(false);
  if (process.env.SHOW) console.log({ on, off });
  assert.strictEqual(on.started, 0, 'no worker started: ' + JSON.stringify(on));
  assert.ok(on.claimed >= 6 && !on.kills['pool full after cancel'], JSON.stringify(on));
  assert.ok(on.pondering && on.found > 0, 'the claimed workers search the new job');
  assert.ok(off.started >= 6 && off.kills['pool full after cancel'] >= 6, '2.0.2: new workers each job: ' + JSON.stringify(off));
});

run();
