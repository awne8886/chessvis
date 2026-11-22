// Ponder state (settings.js: CV.createPonderState, CV.ponderKey) and the 2.0.0 ponder helpers.
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load('humanize.js');
const { test, run } = runner('ponder');
const START = CV.STANDARD_START_FEN;

// ---- T1: early ponder ----
test('early key equals the observed key of the same position', () => {
  const h = { startFen: START, moves: ['e2e4', 'e7e5'] };
  const ours = 'g1f3';
  const early = CV.ponderKey(h.startFen, [...h.moves, ours]);            // play(): before the board shows our move
  const observed = CV.ponderKey(START, ['e2e4', 'e7e5', 'g1f3']);       // idleWork(): the tracker's history after it landed
  assert.strictEqual(early, observed);
  assert.notStrictEqual(early, CV.ponderKey(START, ['e2e4', 'e7e5', 'b1c3']));
  assert.notStrictEqual(early, CV.ponderKey('8/8/8/8/8/8/8/K6k w - - 0 1', ['e2e4', 'e7e5', 'g1f3']));
});

test('decide(): hit when the actual moves extend the pondered base', () => {
  const p = CV.createPonderState();
  p.begin(START, ['e2e4'], ['e7e5', 'c7c5']);
  p.addResult('e7e5', { uci: 'g1f3', depth: 9 });
  const d = p.decide(START, ['e2e4', 'e7e5']);
  assert.strictEqual(d.decision, 'hit');
  assert.strictEqual(d.result.uci, 'g1f3');
  assert.ok(d.leadMs >= 0, 'lead time measured');
  assert.strictEqual(p.counters.hits, 1);
  assert.ok(p.counters.lastLeadMs >= 0 && p.counters.avgLeadMs >= 0);
});

test('decide(): miss for a discarded early move (a different move of ours)', () => {
  const p = CV.createPonderState();
  p.begin(START, ['e2e4', 'e7e5', 'g1f3'], ['b8c6']);              // early ponder for g1f3 ...
  p.addResult('b8c6', { uci: 'f1b5', depth: 9 });
  const d = p.decide(START, ['e2e4', 'e7e5', 'b1c3', 'b8c6']);      // ... but b1c3 landed (the move was discarded and re-searched)
  assert.strictEqual(d.decision, 'miss');
  assert.strictEqual(d.result, null);
  assert.strictEqual(d.leadMs, null);
});

test('decide(): miss for a retry (our move did not register: same position again, shorter history)', () => {
  const p = CV.createPonderState();
  p.begin(START, ['e2e4', 'e7e5', 'g1f3'], ['b8c6']);
  assert.strictEqual(p.decide(START, ['e2e4', 'e7e5']).decision, 'miss');
  assert.strictEqual(p.decide('8/8/8/8/8/8/8/K6k w - - 0 1', ['e2e4', 'e7e5', 'g1f3', 'b8c6']).decision, 'miss');   // other start
  assert.strictEqual(p.decide(START, null).decision, 'miss');                                                   // no history
});

test('decide(): late for a planned move without a reply; none without an entry', () => {
  const p = CV.createPonderState();
  assert.strictEqual(p.decide(START, ['e2e4']).decision, 'none');
  p.begin(START, ['e2e4'], ['e7e5', 'c7c5']);
  p.addRunning('c7c5');
  const d = p.decide(START, ['e2e4', 'c7c5']);
  assert.strictEqual(d.decision, 'late');
  assert.strictEqual(d.running, true);
});

// ---- T5: fast reply on a ponder hit ----
test('delayFor: fastReply uses the quick range (only with quick replies on); no category needed', () => {
  const cfg = { ...CV.DEFAULTS };
  for (let i = 0; i < 300; i++) {
    const d = CV.human.delayFor(cfg, { legalCount: 30, category: null, fastReply: true });
    assert.ok(d >= cfg.quickMinDelay && d <= cfg.quickMaxDelay, String(d));
  }
  const off = { ...cfg, quickReplies: false };
  for (let i = 0; i < 300; i++) assert.ok(CV.human.delayFor(off, { fastReply: true }) >= off.minDelay);
  for (let i = 0; i < 300; i++) assert.ok(CV.human.delayFor({ ...cfg, hesitation: false }, { fastReply: false }) >= cfg.minDelay);
  assert.strictEqual(CV.DEFAULTS.ponderHitFast, true);
});

// ---- T6: seeding from the main search's PV ----
const LMP = { startFen: START, moves: ['e2e4', 'e7e5'], pv: ['g1f3', 'b8c6', 'f1b5', 'a7a6'], depth: 14, ponder: 'b8c6' };
test('pvSeed: positive case', () => {
  assert.deepStrictEqual(CV.pvSeed(LMP, START, ['e2e4', 'e7e5', 'g1f3']), { opp: 'b8c6', reply: 'f1b5', depth: 12 });
  assert.strictEqual(CV.pvPredict(LMP, START, ['e2e4', 'e7e5', 'g1f3']), 'b8c6');
});
test('pvSeed: negative cases', () => {
  assert.strictEqual(CV.pvSeed(LMP, '8/8/8/8/8/8/8/K6k w - - 0 1', ['e2e4', 'e7e5', 'g1f3']), null, 'different start');
  assert.strictEqual(CV.pvSeed(LMP, START, ['e2e4', 'e7e5', 'b1c3']), null, 'different move played');
  assert.strictEqual(CV.pvSeed(LMP, START, ['e2e4', 'e7e5']), null, 'history too short');
  assert.strictEqual(CV.pvSeed(LMP, START, ['d2d4', 'e7e5', 'g1f3']), null, 'different earlier move');
  assert.strictEqual(CV.pvSeed({ ...LMP, pv: ['g1f3', 'b8c6'] }, START, ['e2e4', 'e7e5', 'g1f3']), null, 'short PV');
  assert.strictEqual(CV.pvSeed({ ...LMP, depth: 9 }, START, ['e2e4', 'e7e5', 'g1f3']), null, 'too shallow (9 - 2 < 8)');
  assert.ok(CV.pvSeed({ ...LMP, depth: 10 }, START, ['e2e4', 'e7e5', 'g1f3']), 'depth 10 - 2 = 8 is enough');
  assert.strictEqual(CV.pvSeed(null, START, ['e2e4']), null);
  assert.strictEqual(CV.pvPredict({ ...LMP, pv: ['g1f3'] }, START, ['e2e4', 'e7e5', 'g1f3']), 'b8c6', 'ponder token when the PV has no reply');
  assert.strictEqual(CV.pvPredict(LMP, START, ['e2e4', 'e7e5', 'b1c3']), null);
});
test('moveFirst', () => {
  assert.deepStrictEqual(CV.moveFirst(['a', 'b', 'c'], 'c'), ['c', 'a', 'b']);
  assert.deepStrictEqual(CV.moveFirst(['a', 'b'], 'x'), ['a', 'b']);
  assert.deepStrictEqual(CV.moveFirst(['a', 'b'], null), ['a', 'b']);
});
test('addResult never replaces a deeper result; equal or greater depth replaces as before', () => {
  const p = CV.createPonderState();
  p.begin(START, ['e2e4'], ['e7e5']);
  assert.strictEqual(p.addResult('e7e5', { uci: 'g1f3', depth: 12 }), true);
  assert.strictEqual(p.addResult('e7e5', { uci: 'b1c3', depth: 9 }), false);
  assert.strictEqual(p.get().results.e7e5.uci, 'g1f3');
  assert.strictEqual(p.addResult('e7e5', { uci: 'f1c4', depth: 12 }), true, 'equal depth replaces');
  assert.strictEqual(p.addResult('e7e5', { uci: 'd2d4', depth: 15 }), true, 'deeper replaces');
  assert.strictEqual(p.get().results.e7e5.uci, 'd2d4');
  assert.strictEqual(p.addResult('c7c5', { uci: 'g1f3', depth: 3 }), false, 'not planned');
});

// ---- T7: deepening planner ----
const R = ['a1a2', 'b1b2', 'c1c2', 'd1d2', 'e1e2', 'f1f2', 'g1g2', 'h1h2'];
test('ponderDeepenPlan: pass 1 = every ranked move with the first slice', () => {
  for (const workers of [1, 3]) {
    const p = CV.ponderDeepenPlan({ ranked: R, results: {}, pass: 1, workers, firstSlice: 250, leftMs: 8000 });
    assert.deepStrictEqual(p, R.map((uci) => ({ uci, ms: 250 })));
  }
});
test('ponderDeepenPlan: pass 2 / 3 with 1 and 3 workers', () => {
  const p = (pass, workers) => CV.ponderDeepenPlan({ ranked: R, results: {}, pass, workers, firstSlice: 250, leftMs: 30000 });
  assert.deepStrictEqual(p(2, 1), [{ uci: 'a1a2', ms: 500 }, { uci: 'b1b2', ms: 500 }]);                 // K = max(2, 2)
  assert.deepStrictEqual(p(3, 1), [{ uci: 'a1a2', ms: 1000 }, { uci: 'b1b2', ms: 1000 }]);
  assert.deepStrictEqual(p(2, 3), R.slice(0, 6).map((uci) => ({ uci, ms: 500 })));                     // K = 2 x 3
  assert.deepStrictEqual(p(3, 3), R.slice(0, 6).map((uci) => ({ uci, ms: 1000 })));
  assert.deepStrictEqual(p(6, 1).map((x) => x.ms), [4000, 4000], 'slice capped at 4000');
  assert.deepStrictEqual(CV.ponderDeepenPlan({ ranked: ['a1a2'], pass: 2, workers: 3, firstSlice: 250, leftMs: 9000 }), [{ uci: 'a1a2', ms: 500 }], 'K <= ranked');
});
test('ponderDeepenPlan: slices fit the deadline; stops when no minimum slice fits', () => {
  const p = (leftMs, pass) => CV.ponderDeepenPlan({ ranked: R, results: {}, pass, workers: 1, firstSlice: 250, leftMs });
  assert.deepStrictEqual(p(400, 2).map((x) => x.ms), [400 - CV.PONDER_OVERRUN_MS, 400 - CV.PONDER_OVERRUN_MS]);
  assert.deepStrictEqual(p(CV.PONDER_MIN_SLICE_MS + CV.PONDER_OVERRUN_MS - 1, 2), []);
  assert.deepStrictEqual(p(CV.PONDER_MIN_SLICE_MS + CV.PONDER_OVERRUN_MS - 1, 1), []);
  assert.strictEqual(p(CV.PONDER_MIN_SLICE_MS + CV.PONDER_OVERRUN_MS, 2).length, 2);
  assert.deepStrictEqual(CV.ponderDeepenPlan({ ranked: [], pass: 1, workers: 1, firstSlice: 250, leftMs: 5000 }), []);
});
test('ponderDeepenPlan: depth cap stops deepening once every top result has depth N', () => {
  const results = { a1a2: { depth: 10 }, b1b2: { depth: 10 } };
  assert.deepStrictEqual(CV.ponderDeepenPlan({ ranked: R, results, pass: 2, workers: 1, firstSlice: 250, leftMs: 5000, depthCap: 10 }), []);
  const partial = { a1a2: { depth: 10 }, b1b2: { depth: 7 } };
  assert.strictEqual(CV.ponderDeepenPlan({ ranked: R, results: partial, pass: 2, workers: 1, firstSlice: 250, leftMs: 5000, depthCap: 10 }).length, 2);
  assert.strictEqual(CV.ponderDeepenPlan({ ranked: R, results, pass: 2, workers: 1, firstSlice: 250, leftMs: 5000, depthCap: 0 }).length, 2, 'no cap: keeps going');
});

run();
