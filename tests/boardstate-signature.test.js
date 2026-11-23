// BS.signature (boardstate.js): the string the stable-read debounce compares (2.0.0, T2).
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load('boardstate.js');
const BS = CV.boardstate;
const { test, run } = runner('boardstate-signature');

const grid = () => BS.placementToGrid(BS.START_PLACEMENT);

test('highlight order does not matter', () => {
  const g = grid();
  assert.strictEqual(BS.signature(g, [[5, 2], [5, 4]]), BS.signature(g, [[5, 4], [5, 2]]));
  assert.strictEqual(BS.signature(g, []), BS.signature(g, undefined));
});

test('changes when a highlight changes', () => {
  const g = grid();
  assert.notStrictEqual(BS.signature(g, [[5, 2], [5, 4]]), BS.signature(g, [[5, 2]]));
  assert.notStrictEqual(BS.signature(g, [[5, 4]]), BS.signature(g, [[4, 5]]));     // "54" vs "45": not confused
});

test('changes when any piece changes (removed, added, replaced, moved)', () => {
  const base = BS.signature(grid(), []);
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const g = grid();
      const before = g[r][f];
      g[r][f] = before ? null : 'Q';                       // remove a piece / add one on an empty square
      assert.notStrictEqual(BS.signature(g, []), base, 'square ' + f + ',' + r);
      if (before) { const g2 = grid(); g2[r][f] = before === 'q' ? 'Q' : 'q'; assert.notStrictEqual(BS.signature(g2, []), base); }
    }
  }
  const g = grid(); g[3][4] = g[1][4]; g[1][4] = null;    // e2-e4
  assert.notStrictEqual(BS.signature(g, []), base);
});

test('a half-updated board (capture in progress) differs from the finished one', () => {
  const g1 = grid(); g1[6][3] = null;                      // the captured piece removed ...
  const g2 = grid(); g2[6][3] = 'N'; g2[0][1] = null;      // ... and the capturer arrived
  assert.notStrictEqual(BS.signature(g1, [[2, 1]]), BS.signature(g2, [[2, 1], [4, 7]]));
});

run();
