// 2.0.2 (C1): AggroChess ponder workers are recycled with their hash instead of being terminated after every job.
// The real background.js with fake workers (tests/_fakebg.js); a fake AggroChess worker is 'ready' aggroStartMs after
// it is created (a real one needs ~30-60 ms to instantiate and warm up).
'use strict';
const assert = require('node:assert');
const { runner } = require('./_load');
const { makeBackground, sleep, CV, best } = require('./_fakebg');
const { test, run } = runner('ponder-pool');
const START = CV.STANDARD_START_FEN;
const idle = (moves, extra) => ({ type: 'aggroIdle', startFen: START, moves, ponder: true, showEval: false, ponderMs: 300, ponderWorkers: 2, ponderHashMb: 32, myColor: 'w', ponderUntilMove: false, ...extra });
const ids = (bg, list) => bg.get(list + '.filter((w) => !w.dead).map((w) => w.worker.id)');
const aggroWorkers = (bg) => bg.workers.filter((w) => w.kind === 'aggro');

test('idle workers survive the end of a job and a cancel, with their hash (no new worker)', async () => {
  const bg = makeBackground({ aggroStartMs: 20 });
  await bg.send(idle(['e2e4']));
  await sleep(700);                                               // the 300 ms job is over
  assert.ok(!bg.get('idleInfo.pondering'));
  const spares = ids(bg, 'ponderSpares');
  assert.strictEqual(spares.length, 2, 'both job workers are spares again');
  const created = aggroWorkers(bg).length, cold = bg.get('ponderDbg.claimCold');
  await bg.send(idle(['e2e4', 'e7e5', 'g1f3']));                  // cancel + a new job
  await sleep(30);
  assert.deepStrictEqual(ids(bg, 'ponderActive').sort(), spares.sort(), 'the same workers took the new job');
  assert.strictEqual(aggroWorkers(bg).length, created, 'no worker was created');
  assert.ok(spares.every((id) => !bg.workers[id].dead));
  assert.ok(bg.get('ponderDbg.aggroRecycled') >= 2);
  assert.strictEqual(bg.get('ponderDbg.claimCold'), cold, 'the new job got warm workers');
});

test('busy workers are terminated by a cancel (a wasm think cannot be interrupted) and replaced', async () => {
  const bg = makeBackground({ aggroStartMs: 5 });
  await bg.send(idle(['e2e4'], { ponderMs: 3600 }));             // 600 ms reply slices
  await sleep(250);
  const busy = bg.get('ponderActive.filter((w) => w.busy()).map((w) => w.worker.id)');
  assert.ok(busy.length >= 1, 'a reply search is running');
  await bg.send(idle(['e2e4', 'e7e5', 'g1f3']));
  for (const id of busy) assert.ok(bg.workers[id].dead, 'worker ' + id + ' terminated');
  assert.ok(bg.get('ponderDbg.aggroKilled') >= busy.length);
});

test('a new game clears a recycled worker before its next search', async () => {
  const bg = makeBackground({ aggroStartMs: 5 });
  await bg.send(idle(['e2e4'], { ponderWorkers: 1 }));
  await sleep(700);
  const [id] = ids(bg, 'ponderSpares');
  const before = bg.workers[id].msgs.length;
  await bg.send({ type: 'aggroClear' });                          // new game: ponderGen++
  await bg.send(idle(['d2d4'], { ponderWorkers: 1 }));
  await sleep(100);
  const after = bg.workers[id].msgs.slice(before);
  assert.strictEqual(after[0], 'clear', 'clear first, then the new job: ' + after.slice(0, 4).join(' '));
  assert.ok(after.length > 1 && after.slice(1).every((t) => t !== 'clear'));
  // the same game again: no clear
  await sleep(700);
  const n = bg.workers[id].msgs.length;
  await bg.send(idle(['d2d4', 'd7d5', 'c2c4'], { ponderWorkers: 1 }));
  await sleep(50);
  assert.ok(!bg.workers[id].msgs.slice(n).includes('clear'));
});

test('the worker that searched the move the opponent played gets the next job first', async () => {
  const bg = makeBackground({ aggroStartMs: 5 });
  await bg.send(idle(['e2e4'], { ponderMs: 1500 }));
  await sleep(1600);
  const spares = bg.get('ponderSpares.map((w) => ({ id: w.worker.id, searched: [...w.searched] }))');
  assert.strictEqual(spares.length, 2);
  // a move searched only by the SECOND spare: after the opponent plays it and we answer, that worker must come first
  const key = spares[1].searched.find((k) => !spares[0].searched.includes(k));
  assert.ok(key, 'the two workers searched different moves');
  const opp = key.split(' ').pop();
  const ours = best(CV.replayUci(START, ['e2e4', opp]).pos);
  await bg.send(idle(['e2e4', opp, ours], { ponderMs: 1500 }));
  await sleep(20);                                                // the job claims its workers after the main worker's ponderMove
  assert.strictEqual(bg.get('ponderActive[0].worker.id'), spares[1].id);
  assert.strictEqual(bg.get('ponderDbg.claimWarmLine'), 1);
});

test('CV.AGGRO_PONDER_RECYCLE = false restores 2.0.0: every job worker is terminated', async () => {
  const bg = makeBackground({ aggroStartMs: 5 });
  bg.get('CV.AGGRO_PONDER_RECYCLE = false');
  await bg.send(idle(['e2e4']));
  await sleep(700);
  const first = aggroWorkers(bg).filter((w) => w.msgs.includes('analyze')).map((w) => w.id);
  assert.ok(first.length >= 1 && first.every((id) => bg.workers[id].dead));
  assert.ok(ids(bg, 'ponderSpares').every((id) => !first.includes(id)), 'fresh spares');
  assert.strictEqual(bg.get('ponderDbg.aggroRecycled'), 0);
});

// ---- 2.0.2 A7: interruptible workers (JSPI) ----
test('A7: busy interruptible workers are stopped and recycled with their hash, not terminated', async () => {
  const bg = makeBackground({ aggroStartMs: 5, aggroInterruptible: true });
  await bg.send(idle(['e2e4'], { ponderMs: 3600 }));             // 600 ms reply slices
  await sleep(250);
  const busy = bg.get('ponderActive.filter((w) => w.busy()).map((w) => w.worker.id)');
  assert.ok(busy.length >= 1);
  const created = aggroWorkers(bg).length;
  await bg.send(idle(['e2e4', 'e7e5', 'g1f3']));
  await sleep(60);
  for (const id of busy) assert.ok(!bg.workers[id].dead, 'worker ' + id + ' kept');
  assert.strictEqual(aggroWorkers(bg).length, created, 'no new worker');
  assert.ok(bg.get('ponderDbg.stopsOk') >= busy.length && bg.get('ponderDbg.stopsFailed') === 0);
  assert.ok(bg.get('ponderDbg.stopMs').every((ms) => ms < 150));
});

test('A7: a worker that does not answer the stop within 150 ms is terminated', async () => {
  const bg = makeBackground({ aggroStartMs: 5, aggroInterruptible: true, aggroIgnoreStop: true });
  await bg.send(idle(['e2e4'], { ponderMs: 3600 }));
  await sleep(250);
  const busy = bg.get('ponderActive.filter((w) => [...w.pending.values()].some((p) => p.think)).map((w) => w.worker.id)');   // a 600 ms think that ignores the stop
  assert.ok(busy.length >= 1);
  await bg.send(idle(['e2e4', 'e7e5', 'g1f3']));
  await sleep(220);
  for (const id of busy) assert.ok(bg.workers[id].dead, 'worker ' + id + ' terminated');
  assert.ok(bg.get('ponderDbg.stopsFailed') >= 1);
});

test('A7: late, far from done -> the reply search is stopped and its move so far played (depth >= 8)', async () => {
  const bg = makeBackground({ aggroStartMs: 5, aggroInterruptible: true });
  const moves = ['e2e4'];
  const predicted = best(CV.replayUci(START, moves).pos);
  await bg.send(idle(moves, { ponderMs: 3600, ponderWorkers: 1 }));   // the predicted move first, 600 ms slice
  await sleep(150);
  const t0 = Date.now();
  const r = await bg.send({ type: 'analyze', engine: 'aggro', fen: START, startFen: START, moves: [...moves, predicted], ms: 1000, ponder: true });
  assert.ok(r.ponderHit && r.partial && r.late, JSON.stringify(r));
  assert.ok(r.depth >= 8 && r.depth < 60, 'depth so far: ' + r.depth);
  assert.ok(Date.now() - t0 < 100, 'no wait for the slice: ' + (Date.now() - t0));
  assert.strictEqual(bg.get('ponderDbg.lateStopHits'), 1);
  // the same with CV.AGGRO_INTERRUPT = false: no stop, a normal search (as 2.0.0: the slice was not almost done)
  const bg2 = makeBackground({ aggroStartMs: 5, aggroInterruptible: true });
  bg2.get('CV.AGGRO_INTERRUPT = false');
  await bg2.send(idle(moves, { ponderMs: 3600, ponderWorkers: 1 }));
  await sleep(150);
  const r2 = await bg2.send({ type: 'analyze', engine: 'aggro', fen: START, startFen: START, moves: [...moves, predicted], ms: 200, ponder: true });
  assert.ok(!r2.ponderHit && bg2.get('ponderDbg.lateStops') === 0);
});

// A short game against the fake engine: our search, early ponder, the opponent's think (alternately longer and shorter
// than the 600 ms job), the opponent's move (mostly the predicted one: hits). Reports, per move, how many ponder workers
// were created and how many workers a job got that were still starting (cold).
// Measured (2 workers, 8 moves, start 45 ms): job ends first half the time: 2.0.0 2 spawns + 1 cold worker per move,
// 2.0.2 1 spawn + 1 cold per move (the cold ones are the workers that were busy when the opponent moved; 2.0.0 already
// warmed replacements when a job ended). ponderUntilMove: the workers are always busy when the opponent moves, so
// they are terminated as before: 2 spawns + 2 cold per move in both (A7, interruptible workers, is what helps there).
async function game(recycle, untilMove, interruptible) {
  const bg = makeBackground({ aggroStartMs: 45, aggroInterruptible: !!interruptible });
  bg.get('CV.AGGRO_PONDER_RECYCLE = ' + recycle);
  let moves = [];
  for (let i = 0; i < 8; i++) {
    const r = await bg.send({ type: 'analyze', engine: 'aggro', fen: START, startFen: START, moves, ms: 60, ponder: true });
    moves = [...moves, r.uci];
    await bg.send({ type: 'aggroIdle', startFen: START, moves, ponder: true, showEval: false, ponderMs: 600, ponderWorkers: 2, ponderHashMb: 32, myColor: 'w', ponderUntilMove: untilMove, ponderMaxMs: 8000 });
    await sleep(i % 2 ? 250 : 900);                               // the opponent thinks (the job ends within 900 ms when not until-move)
    const legal = CV.chess.legalMoves(CV.replayUci(START, moves).pos).map((m) => m.uci).sort();
    moves = [...moves, i % 4 === 3 ? legal[legal.length - 1] : legal[0]];
  }
  const d = bg.get('({ jobs: ponderDbg.jobs, spawns: ponderDbg.aggroSpawns, cold: ponderDbg.claimCold, recycled: ponderDbg.aggroRecycled, killed: ponderDbg.aggroKilled, hits: ponder.counters.hits })');
  await bg.send({ type: 'aggroInvalidate' });
  return d;
}

test('measured: fewer respawns and cold workers per move (simulation, 8 moves, 2 workers)', async () => {
  const rows = [];
  for (const untilMove of [false, true]) {
    for (const recycle of [false, true]) {
      const d = await game(recycle, untilMove);
      rows.push({ untilMove, recycle, ...d, spawnsPerMove: +(d.spawns / d.jobs).toFixed(2), coldPerMove: +(d.cold / d.jobs).toFixed(2) });
    }
  }
  for (const untilMove of [false, true]) {                      // 2.0.2 A7: interruptible workers (JSPI)
    const d = await game(true, untilMove, true);
    rows.push({ untilMove, recycle: 'interruptible', ...d, spawnsPerMove: +(d.spawns / d.jobs).toFixed(2), coldPerMove: +(d.cold / d.jobs).toFixed(2) });
  }
  if (process.env.SHOW) console.table(rows);
  const [oldEnd, newEnd, oldUntil, newUntil] = rows;
  assert.ok(newEnd.spawnsPerMove < oldEnd.spawnsPerMove, 'job ends before the opponent moves: fewer respawns');
  assert.ok(newEnd.recycled > 0 && oldEnd.recycled === 0);
  assert.ok(newEnd.coldPerMove <= oldEnd.coldPerMove, 'never more cold workers');
  assert.ok(newUntil.spawnsPerMove <= oldUntil.spawnsPerMove && newUntil.coldPerMove <= oldUntil.coldPerMove, 'until-move: never worse');
  const intUntil = rows[5];
  assert.ok(intUntil.spawnsPerMove < oldUntil.spawnsPerMove && intUntil.coldPerMove < oldUntil.coldPerMove, 'interruptible: until-move workers are kept');
});

// 2.0.3: seen on a phone with 2.0.2: the bot's only move followed by our mate in one made every reply search return in
// under 3 ms, and the "until the opponent moves" job ran 21 271 passes. A reply that ends fast without getting deeper is
// settled; the job ends once every ranked reply is.
async function instantJob(settle) {
  const bg = makeBackground({ aggroStartMs: 5, aggroInstant: true });
  bg.get('CV.PONDER_SETTLE = ' + settle);
  await bg.send(idle(['e2e4'], { ponderUntilMove: true, ponderMaxMs: 30000, ponderMs: 800 }));
  await sleep(1200);
  const out = { pondering: !!bg.get('idleInfo.pondering'), passes: bg.get('ponderDbg.maxPasses'), settled: bg.get('ponderDbg.settled'),
    jobsEnded: bg.get('ponderDbg.settledJobs'), thinks: aggroWorkers(bg).reduce((n, w) => n + (w.thinks || 0), 0) };
  await bg.send({ type: 'aggroInvalidate' });
  return out;
}

test('2.0.3: replies with nothing more to find are settled and the job ends instead of spinning', async () => {
  const on = await instantJob(true), off = await instantJob(false);
  if (process.env.SHOW) console.table({ settle: on, '2.0.2': off });
  assert.strictEqual(on.pondering, false, 'the job is over');
  assert.strictEqual(on.jobsEnded, 1);
  assert.ok(on.settled >= 1 && on.passes <= 12, JSON.stringify(on));
  assert.ok(off.pondering === true && off.passes > 10 * on.passes, '2.0.2 keeps starting passes: ' + JSON.stringify(off));
  assert.ok(on.thinks * 5 < off.thinks, JSON.stringify({ on: on.thinks, off: off.thinks }));
});

test('2.0.3: CV.ponderSettled: fast and no deeper = settled; slow, deeper or pass-1 style results are not', () => {
  assert.strictEqual(CV.ponderSettled({ ms: 800, elapsedMs: 2, depthBefore: 8, depthAfter: 8 }), true);
  assert.strictEqual(CV.ponderSettled({ ms: 800, elapsedMs: 2, depthBefore: undefined, depthAfter: undefined }), true, 'game over after the reply');
  assert.strictEqual(CV.ponderSettled({ ms: 800, elapsedMs: 2, depthBefore: 8, depthAfter: 9 }), false, 'deeper');
  assert.strictEqual(CV.ponderSettled({ ms: 800, elapsedMs: 200, depthBefore: 8, depthAfter: 8 }), false, 'used a quarter of its time');
  assert.strictEqual(CV.ponderSettled({ ms: 0, elapsedMs: 0, depthBefore: 8, depthAfter: 8 }), false);
  const plan = CV.ponderDeepenPlan({ ranked: ['a', 'b', 'c', 'd', 'e', 'f'], results: {}, pass: 2, workers: 1, firstSlice: 100, leftMs: 10000, settled: new Set(['a']) });
  assert.deepStrictEqual(plan.map((x) => x.uci), ['b', 'c'], 'the next likely move takes a settled one\'s place');
  assert.deepStrictEqual(CV.ponderDeepenPlan({ ranked: ['a'], results: {}, pass: 3, workers: 2, firstSlice: 100, leftMs: 10000, settled: new Set(['a']) }), []);
  CV.PONDER_SETTLE = false;
  try { assert.strictEqual(CV.ponderSettled({ ms: 800, elapsedMs: 2, depthBefore: 8, depthAfter: 8 }), false, 'false = 2.0.2'); } finally { CV.PONDER_SETTLE = true; }
});

run();
