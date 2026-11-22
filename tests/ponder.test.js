// Ponder state (settings.js: CV.createPonderState, CV.ponderKey) and the 2.0.0 ponder helpers.
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load();
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

run();
