// 2.0.4 (D3): the clock / name selection rules moved from content.js (readClock, readNames) into clock.js (pickClock,
// pickClocks, pickNames) so that one pass over the page serves both clocks. They must give exactly what 2.0.3 gave:
// the 2.0.3 code is kept below as the reference and compared on synthetic candidate lists (the classes chess.com might
// use, mixed at random; the real site is unverified).
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load('clock.js');
const { test, run } = runner('clock-select');

// ---- 2.0.3 reference (content.js readClock's choice and readNames' ordering), verbatim apart from the inputs ----
function oldPick(cands, myColor, which) {
  const mineC = myColor === 'w' ? 'white' : 'black', otherC = myColor === 'w' ? 'black' : 'white';
  const [want, avoid, side] = which === 'opp' ? [otherC, mineC, 'top'] : [mineC, otherC, 'bottom'];
  const pick = cands.find((c) => c.cls.includes('clock-' + want)) ||
               cands.find((c) => c.cls.includes(want) && !c.cls.includes(avoid)) ||
               cands.find((c) => new RegExp('(^|[\\s-])' + side + '($|[\\s-])').test(c.cls));
  return pick || null;
}
function oldNames(found) {
  found = found.slice();
  if (found.length < 2) return null;
  found.sort((x, y) => x.top - y.top);
  return { opp: found[0].t, me: found[found.length - 1].t };
}

let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 2 ** 31; };
const pickOne = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = ['clock-component', 'clock-white', 'clock-black', 'clock-bottom', 'clock-top', 'clock-player-turn', 'white', 'black', 'bottom', 'top',
  'clock-time-monospace', 'clock-low-time', 'player-bottom', 'player-top', 'topbar', 'bottomline', 'whitespace', 'blackout', 'clock'];

test('pickClock / pickClocks = the 2.0.3 rules (20 000 random candidate lists, both colours, both clocks)', () => {
  for (let t = 0; t < 20000; t++) {
    const n = Math.floor(rnd() * 6);
    const cands = [];
    for (let i = 0; i < n; i++) {
      const k = 1 + Math.floor(rnd() * 3);
      cands.push({ ms: Math.floor(rnd() * 600000), cls: Array.from({ length: k }, () => pickOne(WORDS)).join(' ') });
    }
    for (const color of ['w', 'b']) {
      const both = CV.clock.pickClocks(cands, color);
      for (const which of ['me', 'opp']) {
        const want = oldPick(cands, color, which);
        assert.strictEqual(CV.clock.pickClock(cands, color, which), want, JSON.stringify({ cands, color, which }));
        assert.strictEqual(both[which], want);
      }
    }
  }
});

test('the classic cases by hand', () => {
  const c = (cls, ms) => ({ cls, ms });
  const page = [c('clock-component clock-top clock-black', 1), c('clock-component clock-bottom clock-white', 2)];
  assert.deepStrictEqual(CV.clock.pickClocks(page, 'w'), { me: page[1], opp: page[0] });
  assert.deepStrictEqual(CV.clock.pickClocks(page, 'b'), { me: page[0], opp: page[1] }, 'flipped: by colour, not by position');
  const noColour = [c('clock-component clock-top', 1), c('clock-component clock-bottom', 2)];
  assert.deepStrictEqual(CV.clock.pickClocks(noColour, 'b'), { me: noColour[1], opp: noColour[0] });
  assert.deepStrictEqual(CV.clock.pickClocks([], 'w'), { me: null, opp: null });
  assert.strictEqual(CV.clock.pickClock([c('topbar', 1)], 'w', 'opp'), null, '"top" must be a whole word part');
});

test('pickNames = the 2.0.3 ordering (stable for equal positions)', () => {
  for (let t = 0; t < 5000; t++) {
    const n = Math.floor(rnd() * 5);
    const found = Array.from({ length: n }, (_, i) => ({ t: 'p' + i, top: Math.floor(rnd() * 4) * 100 }));
    assert.deepStrictEqual(CV.clock.pickNames(found), oldNames(found), JSON.stringify(found));
  }
});

run();
