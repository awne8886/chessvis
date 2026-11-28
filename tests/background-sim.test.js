// The real background.js with fake workers (tests/_fakebg.js): delay-matched search (T3), early ponder -> hit / miss (T1),
// PV seed (T6), deepening passes (T7). Timing-based with generous margins.
'use strict';
const assert = require('node:assert');
const { runner } = require('./_load');
const { makeBackground, makeStorage, sleep, CV, best } = require('./_fakebg');
const fs = require('fs');
const path = require('path');
require('../ponderstats.js');                 // PONDER_STATS (temporary): CV.ponderStats* for the recorder tests
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

// ---- 2.0.4 B1: engines start on first use and stop when idle ----
const aggroAnalyze = (bg, moves) => bg.send({ type: 'analyze', engine: 'aggro', fen: START, startFen: START, moves, ms: 100, ponder: false });
const alive = (bg, kind) => bg.workers.filter((w) => w.kind === kind && !w.dead).length;

test('B1: nothing starts with the background page; an engine starts on its first request', async () => {
  const bg = makeBackground({ stepMs: 2 });
  await sleep(50);
  assert.strictEqual(bg.workers.length, 0, 'no worker at load');
  const r = await analyzeSf(bg, [], { sfSearchMode: 'depth' });
  assert.ok(r && r.uci);
  assert.strictEqual(alive(bg, 'sf'), 1, 'the Stockfish main worker');
  assert.strictEqual(alive(bg, 'aggro'), 0, 'AggroChess was not needed');
  const w = await bg.send({ type: 'warm', engine: 'aggro' });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(alive(bg, 'aggro'), 1);
  const dbg = await bg.send({ type: 'aggroDebug' });
  assert.strictEqual(JSON.stringify(dbg.engines.starts), JSON.stringify({ stockfish: 1, aggro: 1 }));
  // 2.0.3: both start at load
  const old = makeBackground({ stepMs: 2, setup: 'CV.LAZY_ENGINES = false' });
  await sleep(50);
  assert.strictEqual(alive(old, 'sf'), 1); assert.strictEqual(alive(old, 'aggro'), 1);
});

test('B1: stop after CV.ENGINE_IDLE_MS without a request and without a port; a port keeps them; counters survive', async () => {
  const bg = makeBackground({ stepMs: 2 });
  bg.get('CV.ENGINE_IDLE_MS = 150');
  const port = bg.connect('chessvision');
  await analyzeSf(bg, [], { sfSearchMode: 'depth' });
  await bg.send({ type: 'warm', engine: 'aggro' });
  await sleep(300);
  assert.strictEqual(alive(bg, 'sf') + alive(bg, 'aggro'), 2, 'a connected tab keeps the engines');
  const starts = bg.get('sfDbg.workerStarts');
  port.disconnect();
  await sleep(80);
  assert.strictEqual(alive(bg, 'sf') + alive(bg, 'aggro'), 2, 'not before the idle time');
  await sleep(200);
  assert.strictEqual(alive(bg, 'sf') + alive(bg, 'aggro'), 0, 'all workers terminated');
  assert.strictEqual(bg.get('sf'), null); assert.strictEqual(bg.get('sfReady'), null); assert.strictEqual(bg.get('aggroModuleP'), null);
  assert.strictEqual(bg.get('engineDbg.stops'), 1);
  assert.strictEqual(bg.get('sfDbg.workerStarts'), starts, 'debug counters are kept');
  const r = await analyzeSf(bg, ['e2e4', 'e7e5'], { sfSearchMode: 'depth' });   // a fresh start
  assert.ok(r && r.uci && !r.error);
  assert.strictEqual(alive(bg, 'sf'), 1);
  assert.strictEqual(bg.get('engineDbg.starts.stockfish'), 2);
  assert.ok(bg.log.some((l) => l.w === bg.workers.filter((w) => w.kind === 'sf').pop().id && l.cmd === 'ucinewgame'), 'the new engine starts a new game');
});

test('B1: nothing is stopped under a running search or ponder job; a request right after the stop gets a fresh engine', async () => {
  const bg = makeBackground({ stepMs: 10, aggroStartMs: 5 });
  bg.get('CV.ENGINE_IDLE_MS = 60');
  const long = analyzeSf(bg, [], { sfSearchMode: 'delay', softMs: 300 });   // longer than the idle time
  await sleep(150);
  assert.strictEqual(bg.get('engineDbg.stops'), 0);
  assert.ok((await long).uci);
  await bg.send({ type: 'aggroIdle', startFen: START, moves: ['e2e4'], ponder: true, ponderMs: 400, ponderWorkers: 1, ponderHashMb: 32, myColor: 'w', ponderUntilMove: false });
  await sleep(250);
  assert.strictEqual(bg.get('engineDbg.stops'), 0, 'the ponder job keeps them');
  assert.ok(bg.get('idleInfo.pondering'));
  await sleep(600);
  assert.strictEqual(bg.get('engineDbg.stops'), 1, 'stopped once the job ended');
  assert.strictEqual(alive(bg, 'aggro') + alive(bg, 'sf'), 0);
  // a stop forced while a request waits for its engine (the idle stop never does this): both requests still get a move
  await analyzeSf(bg, [], { sfSearchMode: 'depth' });
  bg.get('CV.ENGINE_IDLE_MS = 600000');
  const p = analyzeSf(bg, ['d2d4'], { sfSearchMode: 'depth' });
  bg.get('stopEngines()');
  const q = analyzeSf(bg, ['d2d4', 'd7d5'], { sfSearchMode: 'depth' });
  const [a, b] = await Promise.all([p, q]);
  // two requests on one main worker: the later one supersedes the earlier (null), as for any two requests
  assert.ok([a, b].filter((x) => x && x.uci && !x.error).length === 1 && [a, b].every((x) => x === null || (x.uci && !x.error)), JSON.stringify([a, b]));
  assert.strictEqual(alive(bg, 'sf'), 1, 'exactly one main worker');
});

test('B1: an engine switch starts the other engine; after an idle stop both restart on demand', async () => {
  const bg = makeBackground({ stepMs: 2, aggroStartMs: 5 });
  bg.get('CV.ENGINE_IDLE_MS = 100');
  await bg.send({ type: 'warm', engine: 'aggro' });
  assert.strictEqual(alive(bg, 'aggro'), 1); assert.strictEqual(alive(bg, 'sf'), 0);
  await bg.send({ type: 'warm', engine: 'stockfish' });                  // the engine setting changed
  assert.strictEqual(alive(bg, 'sf'), 1);
  assert.ok((await aggroAnalyze(bg, ['e2e4'])).uci);
  await sleep(250);
  assert.strictEqual(alive(bg, 'aggro') + alive(bg, 'sf'), 0);
  const r = await aggroAnalyze(bg, ['e2e4', 'e7e5']);
  assert.ok(r && r.uci && !r.error);
  assert.strictEqual(JSON.stringify(bg.get('engineDbg.starts')), JSON.stringify({ stockfish: 1, aggro: 2 }));
});

test('B1 gate: first-move latency after `warm` matches 2.0.3 (engines started at load)', async () => {
  const time = async (bg) => { const t0 = Date.now(); await analyzeSf(bg, [], { sfSearchMode: 'depth' }); return Date.now() - t0; };
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  const old = [], lazy = [], cold = [];
  for (let i = 0; i < 5; i++) {
    const a = makeBackground({ stepMs: 2, setup: 'CV.LAZY_ENGINES = false' }); await sleep(60); old.push(await time(a));
    const b = makeBackground({ stepMs: 2 }); await b.send({ type: 'warm', engine: 'stockfish' }); lazy.push(await time(b));
    const c = makeBackground({ stepMs: 2 }); cold.push(await time(c));
  }
  if (process.env.SHOW) console.log({ old, lazy, cold });
  assert.ok(Math.abs(med(lazy) - med(old)) <= 8, 'warm ' + med(lazy) + ' ms vs 2.0.3 ' + med(old) + ' ms');
  assert.ok(med(cold) >= med(old), 'without warm the first request pays the start: ' + med(cold));
});

// ---- 2.0.4 A4 + B2: the ponder status is pushed on the tab's port; the last tab gone releases the ponder workers ----
test('A4: the status is pushed to the tab that started the job, only on change, at most 4 a second; no polling needed', async () => {
  const bg = makeBackground({ stepMs: 5 });
  const mine = bg.connect('chessvision', { tab: { id: 7 } }), other = bg.connect('chessvision', { tab: { id: 8 } });
  const got = [], otherGot = [];
  mine.onMessage.addListener((m) => got.push({ ...m, at: Date.now() }));
  other.onMessage.addListener((m) => otherGot.push(m));
  const moves = ['e2e4', 'e7e5', 'g1f3'];
  await bg.send(sfIdle(moves, { ponderWorkers: 1, ponderMs: 600, ponderUntilMove: false }), { tab: { id: 7 } });
  await sleep(1400);
  assert.ok(got.length >= 2, 'pushes: ' + got.length);
  assert.ok(got.every((m) => m.type === 'idleStatus' && m.key === CV.ponderKey(START, moves)));
  for (let i = 1; i < got.length; i++) {
    const a = got[i - 1], b = got[i];
    assert.ok(a.pondering !== b.pondering || a.found !== b.found || a.evalLine !== b.evalLine, 'only changes');
    assert.ok(b.at - a.at >= 200, 'at most 4 a second: ' + (b.at - a.at));
  }
  assert.strictEqual(got[got.length - 1].pondering, false, 'the end of the job is pushed');
  assert.ok(got[got.length - 1].found > 0);
  assert.strictEqual(otherGot.length, 0, 'only to the tab that started it');
  assert.strictEqual(bg.get('idleStatus.timer'), null, 'the check stops with the job');
  const n = got.length;
  await sleep(600);
  assert.strictEqual(got.length, n, 'nothing more once it ended');
  bg.get('CV.IDLE_STATUS_PUSH = false');
  await bg.send(sfIdle(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'], { ponderWorkers: 1, ponderMs: 300, ponderUntilMove: false }), { tab: { id: 7 } });
  await sleep(400);
  assert.strictEqual(got.length, n, '2.0.3: no push');
  const st = await bg.send({ type: 'aggroIdleStatus' });
  assert.ok(st && typeof st.found === 'number', 'the poll still answers');
  await bg.send({ type: 'aggroInvalidate' });
});

test('B2: the last tab disconnects -> the job is cancelled and the spares are released; a tab closing during its own job cancels it', async () => {
  const bg = makeBackground({ stepMs: 5, aggroStartMs: 5 });
  const port = bg.connect('chessvision', { tab: { id: 3 } });
  await bg.send(sfIdle(['e2e4'], { ponderWorkers: 2, ponderMs: 300, ponderUntilMove: false }), { tab: { id: 3 } });
  await sleep(700);
  assert.ok(!bg.get('idleInfo.pondering'));
  assert.ok(bg.get('ponderSpares.length') >= 1, 'warm spares after the job');
  port.disconnect();
  await sleep(50);
  assert.strictEqual(bg.get('ponderWanted'), false);
  assert.strictEqual(bg.get('ponderSpares.length'), 0);
  assert.strictEqual(bg.workers.filter((w) => w.kind === 'sf' && !w.dead).length, 0, 'no Stockfish worker left (no main was started)');
  // a new idle job makes them again
  const p2 = bg.connect('chessvision', { tab: { id: 4 } }), p3 = bg.connect('chessvision', { tab: { id: 5 } });
  await bg.send(sfIdle(['e2e4', 'e7e5'], { ponderWorkers: 1, ponderMs: 3000, ponderUntilMove: true }), { tab: { id: 4 } });
  await sleep(200);
  assert.ok(bg.get('idleInfo.pondering'));
  p2.disconnect();                                     // the tab of the running job closes; another tab stays
  await sleep(50);
  assert.ok(!bg.get('idleInfo.pondering'), 'its job was cancelled');
  assert.strictEqual(bg.get('ponderWanted'), true, 'the other tab may still ponder');
  p3.disconnect();
  await sleep(50);
  assert.strictEqual(bg.get('ponderWanted'), false);
  // 2.0.3: nothing happens on a disconnect
  const old = makeBackground({ stepMs: 5 });
  old.get('CV.PONDER_RELEASE_ON_DISCONNECT = false');
  const q = old.connect('chessvision', { tab: { id: 1 } });
  await old.send(sfIdle(['e2e4'], { ponderWorkers: 1, ponderMs: 300, ponderUntilMove: false }), { tab: { id: 1 } });
  await sleep(600);
  q.disconnect();
  await sleep(50);
  assert.ok(old.get('ponderSpares.length') >= 1);
  await old.send({ type: 'aggroInvalidate' });
});

// ---- 2.0.4 F1 / 2.0.6: the lean package (tools/package.sh --lean) has no asm.js fallback; since 2.0.6 it keeps both
// threaded builds. A tree without the threaded builds still plays on the single-thread engine (the fallback chain).
test('F1 (2.0.6): lean = no asm.js only; without any threaded build the start fails once per build and the single-thread engine plays', async () => {
  const lean = fs.readFileSync(path.join(__dirname, '..', 'tools', 'package.sh'), 'utf8');
  assert.ok(/^LEAN_SKIP=\(engine\/stockfish-19-asm\.js\)$/m.test(lean), 'lean leaves out only the asm.js fallback');
  const bg = makeBackground({ stepMs: 2, sab: true, cores: 4, missing: ['engine/stockfish-19-lite.js', 'engine/stockfish-19-lite-rsimd.js', 'engine/stockfish-19-asm.js'] });
  assert.strictEqual(bg.get('sfSab.ok'), true, 'the SharedArrayBuffer test passes, so the threaded build is tried');
  const r = await analyzeSf(bg, [], { sfSearchMode: 'depth', sfThreads: 2 });
  assert.ok(r && r.uci && !r.error, JSON.stringify(r));
  assert.ok(/not found/.test(bg.get('sfDbg.threadedFailed')), 'remembered: ' + bg.get('sfDbg.threadedFailed'));
  assert.strictEqual(bg.get('sfActive'), 'engine/stockfish-19-lite-single.js');
  const tries = bg.workers.filter((w) => w.missing).length;
  const r2 = await analyzeSf(bg, ['e2e4', 'e7e5'], { sfSearchMode: 'depth', sfThreads: 2 });
  assert.ok(r2 && r2.uci);
  assert.strictEqual(bg.workers.filter((w) => w.missing).length, tries, 'not tried again');
});

// ---- 2.0.6 (C): the threaded builds, best first: relaxed-SIMD threaded -> npm threaded -> single thread ----
const mainUrl = (bg) => decodeURIComponent(bg.workers.filter((w) => w.kind === 'sf' && !w.dead)[0].url);
test('C: sfThreads > 1 starts the relaxed-SIMD threaded build with its own .wasm; failures fall back one step, remembered', async () => {
  const bg = makeBackground({ stepMs: 2, sab: true, cores: 8, wasm: { relaxed: true } });
  await analyzeSf(bg, [], { sfSearchMode: 'depth', sfThreads: 4 });
  assert.strictEqual(bg.get('sfActive'), 'engine/stockfish-19-lite-rsimd.js');
  assert.ok(/^engine\/stockfish-19-lite-rsimd\.js#engine\/stockfish-19-lite-rsimd\.wasm,worker$/.test(mainUrl(bg)), mainUrl(bg));
  assert.strictEqual(bg.get('sfThreadsSent'), 4);
  const dbg = await bg.send({ type: 'aggroDebug' });
  assert.strictEqual(dbg.stockfish.active, 'engine/stockfish-19-lite-rsimd.js');
  assert.strictEqual(dbg.stockfish.rsimdThreadedFailed, null);

  // the relaxed threaded build does not start: the npm threaded build, and it is not tried again
  const b2 = makeBackground({ stepMs: 2, sab: true, cores: 8, wasm: { relaxed: true }, missing: ['engine/stockfish-19-lite-rsimd.js'] });
  await analyzeSf(b2, [], { sfSearchMode: 'depth', sfThreads: 4 });
  assert.strictEqual(b2.get('sfActive'), 'engine/stockfish-19-lite.js');
  assert.ok(/not found/.test(b2.get('sfDbg.rsimdThreadedFailed')));
  assert.strictEqual(b2.get('sfDbg.threadedFailed'), null);
  assert.ok(/^engine\/stockfish-19-lite\.js#engine\/stockfish-19-lite\.wasm,worker$/.test(mainUrl(b2)), mainUrl(b2));

  // no relaxed SIMD, or CV.SF_THREADED_RSIMD = false (2.0.5): the npm threaded build only
  for (const bg3 of [makeBackground({ stepMs: 2, sab: true, cores: 8, wasm: { relaxed: false } }),
    makeBackground({ stepMs: 2, sab: true, cores: 8, wasm: { relaxed: true }, setup: 'CV.SF_THREADED_RSIMD = false' })]) {
    await analyzeSf(bg3, [], { sfSearchMode: 'depth', sfThreads: 3 });
    assert.strictEqual(bg3.get('sfActive'), 'engine/stockfish-19-lite.js');
    assert.ok(!bg3.workers.some((w) => /lite-rsimd\.js/.test(w.url)), 'the relaxed threaded build was never started');
  }
  // 4 cores: at most 3 threads; 7 threads on 8 cores
  const b4 = makeBackground({ stepMs: 2, sab: true, cores: 4, wasm: { relaxed: true } });
  await analyzeSf(b4, [], { sfSearchMode: 'depth', sfThreads: 7 });
  assert.strictEqual(b4.get('sfThreadsSent'), 3);
  const b8 = makeBackground({ stepMs: 2, sab: true, cores: 8, wasm: { relaxed: true } });
  await analyzeSf(b8, [], { sfSearchMode: 'depth', sfThreads: 7 });
  assert.strictEqual(b8.get('sfThreadsSent'), 7);
});

// ---- 2.0.6 (B): the main worker's hash ----
const mainCmds = (bg) => { const id = bg.workers.filter((w) => w.kind === 'sf')[0].id; return bg.log.filter((x) => x.w === id).map((x) => x.cmd); };
test('B: sfHashMb: the main worker starts with it, a change is sent once between searches; ponder workers keep theirs', async () => {
  const d = makeBackground({ stepMs: 2 });
  await analyzeSf(d, [], { sfSearchMode: 'depth' });
  assert.deepStrictEqual(mainCmds(d).filter((c) => /Hash/.test(c)), ['setoption name Hash value 32'], '2.0.5: 32 without the setting');

  const bg = makeBackground({ stepMs: 2 });
  await bg.send({ type: 'warm', engine: 'stockfish', sfHashMb: 64 });
  await analyzeSf(bg, [], { sfSearchMode: 'depth', sfHashMb: 64 });
  await analyzeSf(bg, ['e2e4', 'e7e5'], { sfSearchMode: 'depth', sfHashMb: 64 });
  assert.deepStrictEqual(mainCmds(bg).filter((c) => /Hash/.test(c)), ['setoption name Hash value 64']);
  await analyzeSf(bg, ['e2e4', 'e7e5', 'g1f3', 'b8c6'], { sfSearchMode: 'depth', sfHashMb: 128 });
  const cmds = mainCmds(bg);
  assert.deepStrictEqual(cmds.filter((c) => /Hash/.test(c)), ['setoption name Hash value 64', 'setoption name Hash value 128']);
  const i = cmds.indexOf('setoption name Hash value 128');
  const goAfter = cmds.slice(i + 1).findIndex((c) => c.startsWith('go'));
  assert.ok(cmds.slice(0, i).filter((c) => c.startsWith('go depth')).length === 2 && goAfter >= 0 && cmds[i - 1].startsWith('go') && !cmds.slice(i + 1, i + 1 + goAfter).some((c) => /setoption name Hash/.test(c)),
    'after the last search, before the next: ' + cmds.slice(i - 2, i + 4).join(' / '));
  assert.strictEqual(bg.get('sfHashSent'), 128);
  assert.strictEqual((await bg.send({ type: 'aggroDebug' })).stockfish.hashMb, 128);
  // out of range values are clamped by sanitize
  await analyzeSf(bg, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'], { sfSearchMode: 'depth', sfHashMb: 999 });
  assert.strictEqual(bg.get('sfHashSent'), 256);
  // ponder workers: sfPonderHashMb
  await bg.send(sfIdle(['e2e4'], { ponderWorkers: 1, ponderHashMb: 16 }));
  await sleep(100);
  const pw = bg.workers.filter((w) => w.kind === 'sf')[1];
  assert.ok(bg.log.some((x) => x.w === pw.id && x.cmd === 'setoption name Hash value 16'));
  assert.ok(!bg.log.some((x) => x.w === pw.id && /Hash value (64|128|256)/.test(x.cmd)));
  await bg.send({ type: 'aggroInvalidate' });
});

// ---- 2.0.6 (A3): CV.SF_MAIN_WAIT_STOP_MS ----
test('A3: with CV.SF_MAIN_WAIT_STOP_MS the main go waits for the stopping ponder workers, at most the cap; 0 = at once', async () => {
  const run1 = async (cap, stopDelay) => {
    const bg = makeBackground({ stepMs: 40, sfStopDelayMs: stopDelay, setup: 'CV.SF_MAIN_WAIT_STOP_MS = ' + cap });
    await bg.send(sfIdle(['e2e4'], { ponderWorkers: 2, sfSearchMode: 'depth' }));
    await sleep(250);                                            // both ponder workers are searching
    const t0 = Date.now();
    const r = await analyzeSf(bg, ['d2d4', 'd7d5'], { ponder: true, sfSearchMode: 'depth', depth: 2 });   // a miss
    const out = { ms: Date.now() - t0, waits: bg.get('sfDbg.mainWaits'), waitMs: bg.get('sfDbg.mainWaitMs'), kills: bg.get('sfDbg.kills'), uci: r.uci };
    await bg.send({ type: 'aggroInvalidate' });
    return out;
  };
  const none = await run1(0, 25);
  assert.strictEqual(none.waits, 0);
  const quick = await run1(40, 25);
  assert.strictEqual(quick.waits, 1);
  assert.ok(quick.waitMs[0] >= 15 && quick.waitMs[0] < 40, 'waited for the stop: ' + quick.waitMs);
  const slow = await run1(40, 300);
  assert.ok(slow.waitMs[0] >= 38 && slow.waitMs[0] < 70, 'capped: ' + slow.waitMs);
  for (const x of [none, quick, slow]) { assert.ok(!Object.keys(x.kills).some((k) => /after stop|timeout/.test(k)), JSON.stringify(x.kills)); assert.strictEqual(x.uci, none.uci); }
  assert.strictEqual(CV.SF_MAIN_WAIT_STOP_MS, 0, 'measured: no gain in Chromium (docs/REFERENCE.md 2.0.6), so 2.0.5 behaviour');
});

// PONDER_STATS (temporary) begin
// ---- 2.0.6 (D): the ponder-stats recorder ----
// One simulated game: early ponder after each of our moves, the opponent answers after `think` ms with the predicted
// move or another one, our next search asks with the page's ps fields.
async function statsGame(bg, opts) {
  const plies = [['e2e4', 'e7e5'], ['g1f3', 'b8c6'], ['f1c4', 'g8f6'], ['d2d3', 'f8c5'], ['e1g1', 'd7d6']];
  const out = [];
  let moves = [], prev = null;
  for (let i = 0; i < plies.length; i++) {
    const [ours, theirs] = plies[i];
    const t0 = Date.now();
    const r = await analyzeSf(bg, moves, { ponder: true, sfSearchMode: 'depth', depth: 6, ps: { oppMs: i ? 150 : null, clockSec: 60, prev, ws: 2, pm: 3000, px: 5000, ph: 16, mh: 32, sm: 'depth' } });
    out.push({ uci: r.uci, ponderHit: !!r.ponderHit, depth: r.depth, ms: Date.now() - t0 });
    moves = [...moves, ours];
    await bg.send(sfIdle(moves, { ponderWorkers: 2, sfSearchMode: 'depth', depth: 6 }));
    await sleep(i % 2 ? 40 : 150);
    prev = { key: CV.ponderKey(START, moves.slice(0, -1)), latMs: 100 + i };
    moves = [...moves, theirs];
  }
  await bg.send({ type: 'ponderStats', op: 'gameEnd', ps: { prev } });
  await bg.send({ type: 'aggroInvalidate' });
  return out;
}
test('D: CV.PONDER_STATS on and off play the same moves at the same speed; only the storage writes differ', async () => {
  const sOn = makeStorage(), sOff = makeStorage();
  const on = makeBackground({ stepMs: 2, storage: sOn }), off = makeBackground({ stepMs: 2, storage: sOff, setup: 'CV.PONDER_STATS = false' });
  const a = await statsGame(on, {}), b = await statsGame(off, {});
  assert.deepStrictEqual(a.map(({ uci, ponderHit, depth }) => ({ uci, ponderHit, depth })), b.map(({ uci, ponderHit, depth }) => ({ uci, ponderHit, depth })));
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i].ms - b[i].ms) < 40, 'move ' + i + ': ' + a[i].ms + ' vs ' + b[i].ms + ' ms');
  assert.deepStrictEqual(mainCmds(on), mainCmds(off), 'the main worker got the same commands');
  assert.ok(Object.keys(sOn.data).some((k) => k.startsWith('ponderStats')), 'on: written');
  assert.deepStrictEqual(Object.keys(sOff.data), [], 'off: nothing written');
  const r = await off.send({ type: 'ponderStats', op: 'status' });
  assert.strictEqual(r.ok, false, 'off: no recorder');
});
test('D: records (decision, depths, lead, rank, latency, kills), one write per game end, export / summary / reset, survives a reload', async () => {
  const storage = makeStorage();
  const bg = makeBackground({ stepMs: 2, storage });
  const setsBefore = storage.counts.set;
  await statsGame(bg, {});
  await sleep(20);
  assert.ok(storage.counts.set - setsBefore <= 2, 'not one write per move: ' + (storage.counts.set - setsBefore));
  const idx = storage.data.ponderStats;
  assert.ok(idx && idx.v === 1 && idx.games.length === 1 && idx.games[0].n === 5, JSON.stringify(idx));
  const recs = storage.data['ponderStats:g1'].recs;
  assert.strictEqual(recs.length, 5);
  assert.strictEqual(recs[0].d, 'none', 'the first move: no ponder job yet');
  for (const x of recs.slice(1)) {
    assert.ok(['hit', 'late', 'miss'].includes(x.d), JSON.stringify(x));
    assert.ok(x.lm > 0 && x.ot === 150, JSON.stringify(x));
    if (x.d === 'hit') assert.ok(x.hd >= 1 && x.md === undefined, JSON.stringify(x)); else assert.ok(x.md >= 1, JSON.stringify(x));
  }
  assert.ok(recs.slice(1).some((x) => x.rk !== undefined), 'ranks: ' + JSON.stringify(recs.map((x) => x.rk)));
  assert.deepStrictEqual(recs.map((x) => x.lat), [100, 101, 102, 103, 104], 'latency of each move arrives with the next message');
  const run0 = CV.ponderStatsRunOf(idx.runs[recs[1].r]);
  assert.deepStrictEqual([run0.e, run0.w, run0.ws, run0.t, run0.pm, run0.px, run0.ph, run0.mh, run0.sm, run0.b], ['sf', 2, 2, 1, 3000, 5000, 16, 32, 'depth', 'stockfish-19-lite-single.js']);
  // a skipped move (only legal move: no engine) and the status
  await bg.send({ type: 'aggroClear' });
  await bg.send({ type: 'ponderStats', op: 'skipped', engine: 'stockfish', startFen: START, moves: ['e2e4'], ps: { oppMs: 90, ws: 2, pm: 3000, px: 5000, ph: 16, mh: 32, sm: 'depth' } });
  const st = await bg.send({ type: 'ponderStats', op: 'status' });
  assert.deepStrictEqual([st.records, st.games, st.workers], [6, 2, 2]);
  // export: one text file; summary
  const ex = await bg.send({ type: 'ponderStats', op: 'export' });
  assert.ok(ex.ok && /^# ChessVision ponder stats/.test(ex.text) && ex.text.includes('=== workers: 2 (run 1, engine sf'), ex.text.split('\n').filter((l) => l.startsWith('===')).join('\n'));
  const parsed = CV.ponderStatsParse(ex.text);
  assert.strictEqual(parsed.reduce((n, s) => n + s.records.length, 0), 6);
  assert.ok(parsed[0].records.some((x) => x.d === 'skipped' && x.g === 2));
  assert.ok((await bg.send({ type: 'ponderStats', op: 'summary' })).text.startsWith('workers | run | engine'));
  // reload: a new background page on the same storage keeps everything and numbers new games after the old ones
  const bg2 = makeBackground({ stepMs: 2, storage });
  await analyzeSf(bg2, [], { ponder: true, sfSearchMode: 'depth', depth: 4, ps: { clockSec: 180, ws: 2, pm: 3000, px: 5000, ph: 16, mh: 32, sm: 'depth' } });
  await bg2.send({ type: 'ponderStats', op: 'gameEnd' });
  const st2 = await bg2.send({ type: 'ponderStats', op: 'status' });
  assert.deepStrictEqual([st2.records, st2.games], [7, 3]);
  assert.strictEqual(storage.data['ponderStats:g3'].c, 180);
  // reset
  await bg2.send({ type: 'ponderStats', op: 'reset' });
  assert.deepStrictEqual(Object.keys(storage.data).filter((k) => k.startsWith('ponderStats')), []);
  assert.deepStrictEqual((await bg2.send({ type: 'ponderStats', op: 'status' })).records, 0);
});
// PONDER_STATS (temporary) end

run();
