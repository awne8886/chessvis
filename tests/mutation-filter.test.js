// 2.0.4 (A3): CV.boardstate.mutationRelevant, the board MutationObserver filter, on synthetic MutationRecords (plain objects
// shaped like the DOM's: type, target, attributeName, oldValue, addedNodes, removedNodes; elements with classList /
// querySelector). The markup imitates chess.com's board (pieces "piece wp square-52", highlights "highlight square-52",
// hover squares, arrows, coordinates); the real site is unverified.
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load('boardstate.js');
const BS = CV.boardstate;
const { test, run } = runner('mutation-filter');

// a minimal element: classes, children, querySelector('.a, .b') by class
function el(cls, kids = []) {
  const e = { nodeType: 1, className: cls, children: kids };
  e.classList = { contains: (c) => cls.split(/\s+/).includes(c) };
  e.querySelector = (sel) => {
    const want = sel.split(',').map((x) => x.trim().replace(/^\./, ''));
    const walk = (n) => { for (const k of n.children) { if (want.some((c) => k.classList.contains(c))) return k; const f = walk(k); if (f) return f; } return null; };
    return walk(e);
  };
  return e;
}
const text = { nodeType: 3, textContent: 'a' };
const board = el('board');
const attr = (target, oldValue) => ({ type: 'attributes', attributeName: 'class', target, oldValue });
const child = (added, removed) => ({ type: 'childList', target: board, addedNodes: added || [], removedNodes: removed || [] });
const yes = (recs) => assert.strictEqual(BS.mutationRelevant(recs, board), true, JSON.stringify(recs, (k, v) => (k === 'classList' || k === 'querySelector' ? undefined : v)));
const no = (recs) => assert.strictEqual(BS.mutationRelevant(recs, board), false);

test('pieces and highlights: class changes, including a lost class (oldValue)', () => {
  yes([attr(el('piece wp square-54'), 'piece wp square-52')]);        // a piece moved
  yes([attr(el('piece wp square-52 dragging'), 'piece wp square-52')]);   // a class change on a piece (conservative)
  yes([attr(el('highlight square-54'), 'highlight square-52')]);
  yes([attr(el('hover-square square-52'), 'piece wp square-52')]);     // an element that is no longer a piece
  yes([attr(el('piece bq square-11'), 'promotion-piece')]);           // an element that became one
  yes([attr(el('something'), 'highlight square-33')]);
});

test('the board element itself (flipped)', () => {
  yes([attr(board, 'board')]);
  yes([{ type: 'attributes', attributeName: 'class', target: board, oldValue: null }]);
});

test('child list: a piece / highlight added or removed, directly or inside a container', () => {
  yes([child([el('piece bp square-75')])]);
  yes([child(null, [el('piece wn square-71')])]);
  yes([child([el('highlight square-44')])]);
  yes([child([el('pieces-layer', [el('wrapper', [el('piece wk square-51')])])])]);   // the whole board re-rendered
  yes([child([text]), child(null, [el('piece wp square-52')])]);      // any record of the batch
});

test('not relevant: hover squares, arrows, coordinates, drag ghosts outside .piece, text, other attributes', () => {
  no([child([el('hover-square square-52')])]);
  no([child(null, [el('hover-square square-52')])]);
  no([attr(el('hover-square square-53'), 'hover-square square-52')]);
  no([child([el('arrows', [el('arrow')])])]);
  no([child([el('coordinates', [el('coordinate-light')])])]);
  no([child([el('ghost-image')])]);
  no([child([text], [text])]);
  no([attr(el('square-52 hint'), 'square-52')]);
  no([{ type: 'attributes', attributeName: 'style', target: el('piece wp square-52'), oldValue: '' }]);
  no([{ type: 'characterData', target: text }]);
  no([]);
});

test('className as an SVG animated string and a string without classList', () => {
  const svgPiece = { nodeType: 1, className: { baseVal: 'piece wq square-41' }, children: [] };
  yes([attr(svgPiece, 'piece wq square-31')]);
  const plain = { nodeType: 1, className: 'highlight square-11' };
  yes([child([plain])]);
  no([child([{ nodeType: 1, className: 'arrow' }])]);
});

run();
