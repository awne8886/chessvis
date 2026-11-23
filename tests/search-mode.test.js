// 2.0.0 search budgets (settings.js): CV.sfShouldStop, CV.sfHardMs, CV.aggroBudget, CV.sfParsePv.
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load();
const { test, run } = runner('search-mode');

test('sfShouldStop truth table', () => {
  const base = { softMs: 300, minDepth: 10, hardMs: 3000 };
  assert.strictEqual(CV.sfShouldStop({ ...base, elapsedMs: 100, depthDone: 15 }), false, 'soft not reached (deep enough)');
  assert.strictEqual(CV.sfShouldStop({ ...base, elapsedMs: 299, depthDone: 30 }), false, 'just before soft');
  assert.strictEqual(CV.sfShouldStop({ ...base, elapsedMs: 400, depthDone: 9 }), false, 'soft reached, depth too low');
  assert.strictEqual(CV.sfShouldStop({ ...base, elapsedMs: 300, depthDone: 10 }), true, 'both');
  assert.strictEqual(CV.sfShouldStop({ ...base, elapsedMs: 3000, depthDone: 3 }), true, 'hard cap, depth too low');
  assert.strictEqual(CV.sfShouldStop({ ...base, elapsedMs: 3000, depthDone: 0 }), true, 'hard cap, no depth at all');
  assert.strictEqual(CV.sfShouldStop({ softMs: 0, minDepth: 10, hardMs: 3000, elapsedMs: 5, depthDone: 10 }), true, 'soft 0 = stop at the min depth');
  assert.strictEqual(CV.sfShouldStop({ softMs: 300, minDepth: 10, hardMs: 0, elapsedMs: 99999, depthDone: 2 }), false, 'no hard cap given');
});

test('sfHardMs: the page cap if any, else max(3000, 3 x soft)', () => {
  assert.strictEqual(CV.sfHardMs(300, 0), 3000);
  assert.strictEqual(CV.sfHardMs(1500, 0), 4500);
  assert.strictEqual(CV.sfHardMs(800, 500), 500);
  assert.strictEqual(CV.sfHardMs(0, 0), 3000);
  assert.strictEqual(CV.sfHardMs(undefined, 'x'), 3000);
});

test('aggroBudget without a clock: never below thinkMs, max(thinkMs, softMs)', () => {
  for (const think of [200, 1000, 5000]) {
    for (const soft of [0, 50, 760, 1000, 4000, 10000]) {
      const b = CV.aggroBudget({ thinkMs: think, softMs: soft, clock: null });
      assert.strictEqual(b.hard, undefined);
      assert.ok(b.ms >= think, think + '/' + soft);
      assert.strictEqual(b.ms, Math.max(think, soft));
    }
  }
  assert.deepStrictEqual(CV.aggroBudget({ thinkMs: 1000 }), { ms: 1000 });            // no softMs = 1.8.0
  assert.deepStrictEqual(CV.aggroBudget({ thinkMs: 1000, softMs: 999999 }), { ms: CV.AGGRO_BUDGET_MAX_MS });
});

test('aggroBudget with a clock: never above hard, soft <= hard, soft >= the clock soft', () => {
  const clocks = [{ soft: 100, hard: 300 }, { soft: 500, hard: 1500 }, { soft: 30, hard: 66 }, { soft: 900, hard: 900 }];
  for (const clock of clocks) {
    for (const soft of [0, 50, 200, 760, 5000]) {
      const b = CV.aggroBudget({ thinkMs: 1000, softMs: soft, clock });
      assert.strictEqual(b.hard, clock.hard);
      assert.ok(b.soft <= b.hard, JSON.stringify([clock, soft, b]));
      assert.ok(b.soft >= clock.soft);
      assert.strictEqual(b.soft, Math.max(clock.soft, Math.min(soft, clock.hard)));
    }
  }
  assert.deepStrictEqual(CV.aggroBudget({ thinkMs: 1000, softMs: 0, clock: { soft: 400, hard: 1200 } }), { soft: 400, hard: 1200 });   // = 1.8.0
});

test('sfParsePv', () => {
  assert.deepStrictEqual(CV.sfParsePv('info depth 12 seldepth 14 multipv 1 score cp 31 nodes 12743 pv e2e4 c7c5 b1c3'), ['e2e4', 'c7c5', 'b1c3']);
  assert.deepStrictEqual(CV.sfParsePv('info depth 3 currmove e2e4 currmovenumber 1'), []);
  assert.deepStrictEqual(CV.sfParsePv('info depth 9 score mate 1 pv d8h4'), ['d8h4']);
});

test('settings: sfSearchMode is an enum with default delay', () => {
  assert.strictEqual(CV.DEFAULTS.sfSearchMode, 'delay');
  assert.deepStrictEqual(CV.sanitize({ sfSearchMode: 'depth' }), { sfSearchMode: 'depth' });
  assert.deepStrictEqual(CV.sanitize({ sfSearchMode: 'fast' }), {});
});

test('T10: aggroBudget subtracts a quick look (floor 100 ms) and stays within the clock', () => {
  assert.deepStrictEqual(CV.aggroBudget({ thinkMs: 1000, spentMs: 300 }), { ms: 700 });
  assert.deepStrictEqual(CV.aggroBudget({ thinkMs: 1000, spentMs: 990 }), { ms: 100 });
  assert.deepStrictEqual(CV.aggroBudget({ thinkMs: 1000, spentMs: 0 }), { ms: 1000 });
  assert.deepStrictEqual(CV.aggroBudget({ thinkMs: 1000, spentMs: 300, softMs: 900 }), { ms: 900 }, 'the pause still counts');
  const b = CV.aggroBudget({ thinkMs: 1000, spentMs: 300, clock: { soft: 800, hard: 2000 } });
  assert.deepStrictEqual(b, { soft: 500, hard: 1700 });
  const low = CV.aggroBudget({ thinkMs: 1000, spentMs: 300, clock: { soft: 40, hard: 90 } });
  assert.ok(low.soft <= low.hard && low.hard <= 90 && low.soft === 40, JSON.stringify(low));
});

run();
