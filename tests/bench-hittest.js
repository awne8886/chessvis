// 2.0.4 (D2) check in headless Chromium (Playwright, not a test): content.js's targetAt picks the element a synthetic
// pointer event is sent to, skipping the ChessVision panel (a shadow host). 2.0.4 asks document.elementFromPoint first
// and only falls back to elementsFromPoint on the panel / nothing. This compares the 2.0.3 and the 2.0.4 rule on every
// point of a grid over a mock chess.com board (squares, pieces, highlights, a hover square and an arrow layer with
// pointer-events: none, coordinates) with the real panel (overlay.js in its Shadow DOM) placed over part of the board,
// open and collapsed. Firefox is not available here (unverified there).
//   node tests/bench-hittest.js
'use strict';
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('needs Playwright (preinstalled in the dev container)'); process.exit(2); }

const ROOT = path.join(__dirname, '..');
const PAGE = `<!doctype html><html><body style="margin:0">
<div id="board" class="board" style="position:absolute;left:40px;top:60px;width:640px;height:640px;background:#9b7">
</div><div class="coordinates" style="position:absolute;left:40px;top:60px;width:20px;height:640px;font:10px sans-serif">1 2 3</div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent(PAGE);
  await page.addScriptTag({ content: 'window.CV = {};' + fs.readFileSync(path.join(ROOT, 'settings.js'), 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'overlay.js'), 'utf8') });
  const out = await page.evaluate(() => {
    const board = document.getElementById('board');
    const sq = 80;
    for (let f = 0; f < 8; f++) for (let r = 0; r < 8; r++) {
      if ((f + r) % 3 === 0) {
        const p = document.createElement('div');
        p.className = 'piece wp square-' + (f + 1) + (8 - r);
        p.style.cssText = `position:absolute;left:${f * sq}px;top:${r * sq}px;width:${sq}px;height:${sq}px;background:rgba(255,255,255,.4)`;
        board.appendChild(p);
      }
    }
    const hl = document.createElement('div'); hl.className = 'highlight square-55';
    hl.style.cssText = `position:absolute;left:${4 * sq}px;top:${3 * sq}px;width:${sq}px;height:${sq}px;background:rgba(255,255,0,.4)`;
    board.appendChild(hl);
    const hover = document.createElement('div'); hover.className = 'hover-square square-33';
    hover.style.cssText = `position:absolute;left:${2 * sq}px;top:${5 * sq}px;width:${sq}px;height:${sq}px;border:3px solid #fff;pointer-events:none`;
    board.appendChild(hover);
    const arrows = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); arrows.setAttribute('class', 'arrows');
    arrows.setAttribute('style', 'position:absolute;left:0;top:0;width:640px;height:640px;pointer-events:none');
    arrows.innerHTML = '<line x1="40" y1="600" x2="600" y2="40" stroke="orange" stroke-width="20"/>';
    board.appendChild(arrows);
    const ui = window.CV.createOverlay({ version: 'x', onChange() {}, onPreview() {}, onExport() { return ''; }, onImport() { return {}; }, onDebug() { return ''; },
      onClearEngines() {}, onSaveNow() {}, onListGames() { return []; }, onClearGames() {}, onReset() {} });
    const host = ui.host;
    const oldTarget = (x, y) => document.elementsFromPoint(x, y).find((el) => el !== host) || board;
    const newTarget = (x, y) => { const top = document.elementFromPoint(x, y); if (top && top !== host) return top; return document.elementsFromPoint(x, y).find((el) => el !== host) || board; };
    const res = [];
    for (const [label, cfg] of [['panel open over the board', { overlayOpen: true, overlayX: 300, overlayY: 200 }], ['panel collapsed over the board', { overlayOpen: false, overlayX: 200, overlayY: 400 }]]) {
      ui.render({ ...window.CV.DEFAULTS, ...cfg });
      let points = 0, same = 0, onPanel = 0;
      const diffs = [];
      for (let x = 0; x < 1000; x += 7) for (let y = 0; y < 800; y += 7) {
        points++;
        const a = oldTarget(x, y), b = newTarget(x, y);
        if (document.elementFromPoint(x, y) === host) onPanel++;
        if (a === b) same++; else if (diffs.length < 5) diffs.push([x, y, a && a.className, b && b.className]);
      }
      res.push({ label, points, same, onPanel, diffs });
    }
    return res;
  });
  await browser.close();
  console.table(out.map((r) => ({ case: r.label, points: r.points, 'same target': r.same, 'points on the panel': r.onPanel })));
  const bad = out.filter((r) => r.same !== r.points);
  if (bad.length) { console.log('DIFFERENT:', JSON.stringify(bad, null, 1)); process.exit(1); }
  console.log('2.0.3 and 2.0.4 pick the same element at every point.');
})().catch((e) => { console.error(e); process.exit(1); });
