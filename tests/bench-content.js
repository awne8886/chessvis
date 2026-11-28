// 2.0.4 measuring harness (not a test): every content script in jsdom on a mock chess.com board, against the REAL
// background.js with fake engine workers (tests/_fakebg.js), with every DOM / messaging / storage call of interest
// counted. Three scenarios (OPUS_PROMPT_2.0.4 §3):
//   idle      SECONDS with nothing happening on the board: the opponent to move, pondering off (our turn handled,
//             nothing left to do)
//   ponder    SECONDS with the opponent to move and pondering on (Stockfish, the defaults: until the opponent moves)
//   cycle     one full move cycle: the opponent moves -> our move is played (counted until 2.5 s after our move
//             landed, so the move-confirmation read at 1.8 s is included); also prints the move and the recorded PGN
//
//   npm install --no-save --prefix .build jsdom@31.0.1
//   NODE_PATH=.build/node_modules node tests/bench-content.js [--seconds 60] [--only idle,ponder,cycle] [--root DIR] [--json]
//
// --root DIR loads the extension scripts (content + background) from another checkout, e.g. the 2.0.3 files:
//   mkdir -p /tmp/cv203 && git archive v2.0.3-commit -- . ':!allowed-pages.txt' | tar -x -C /tmp/cv203
// Counted: board reads (readPosition = board.querySelectorAll('.piece')), document-wide querySelector/All, getBoundingClientRect
// (any element), getClientRects, elementsFromPoint / elementFromPoint, runtime.sendMessage (by type), runtime.connect,
// port messages, storage.local.set / get.
'use strict';
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.error('This harness needs jsdom:\n  npm install --no-save --prefix .build jsdom@31.0.1\n  NODE_PATH=.build/node_modules node tests/bench-content.js');
  process.exit(2);
}
const fs = require('fs');
const path = require('path');
const { makeBackground, makeStorage, sleep, CV } = require('./_fakebg');

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ROOT = path.resolve(opt('--root', path.join(__dirname, '..')));
const SECONDS = Number(opt('--seconds', 60));
const SCRIPTS = ['settings.js', 'chessmini.js', 'humanize.js', 'boardstate.js', 'clock.js', 'pgn.js', 'brilliant.js', 'recorder.js', 'overlay.js', 'content.js'];
const START = CV.STANDARD_START_FEN;

function newCounters() {
  return { boardReads: 0, docQueries: 0, rects: 0, clientRects: 0, elementsFromPoint: 0, elementFromPoint: 0,
    sendMessage: 0, byType: {}, connects: 0, portIn: 0, portOut: 0, storageSet: 0, storageGet: 0 };
}

// opens the page with the given settings and the given moves already played (one-step renders)
async function openPage({ settings, moves }) {
  const storage = makeStorage();
  const bg = makeBackground({ stepMs: 3, aggroStartMs: 30, storage, root: ROOT });
  const c = { now: newCounters() };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.chess.com/play/computer', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  window.innerWidth = 1200; window.innerHeight = 900;
  const board = document.createElement('wc-chess-board');
  board.className = 'board';
  document.body.appendChild(board);
  const rect = { left: 0, top: 0, right: 800, bottom: 800, width: 800, height: 800, x: 0, y: 0 };
  board.getBoundingClientRect = () => rect;
  // instrumentation
  const EP = window.Element.prototype;
  const gbcr = EP.getBoundingClientRect, gcr = EP.getClientRects;
  EP.getBoundingClientRect = function () { c.now.rects++; return this === board ? rect : gbcr.call(this); };
  board.getBoundingClientRect = function () { c.now.rects++; return rect; };
  EP.getClientRects = function () { c.now.clientRects++; return gcr.call(this); };
  const bqsa = board.querySelectorAll.bind(board);
  board.querySelectorAll = (sel) => { if (sel === '.piece') c.now.boardReads++; return bqsa(sel); };
  const dqs = document.querySelector.bind(document), dqsa = document.querySelectorAll.bind(document);
  document.querySelector = (sel) => { c.now.docQueries++; return dqs(sel); };
  document.querySelectorAll = (sel) => { c.now.docQueries++; return dqsa(sel); };
  document.elementsFromPoint = () => { c.now.elementsFromPoint++; return [board]; };
  document.elementFromPoint = () => { c.now.elementFromPoint++; return board; };

  let pos = CV.chess.parseFen(START), last = null, selected = null;
  const played = [];
  let onOurMove = null;
  const render = () => {
    board.textContent = '';
    for (let s = 0; s < 64; s++) {
      const p = pos.b[s];
      if (!p) continue;
      const el = document.createElement('div');
      el.className = 'piece ' + (p === p.toUpperCase() ? 'w' : 'b') + p.toLowerCase() + ' square-' + ((s & 7) + 1) + ((s >> 3) + 1);
      board.appendChild(el);
    }
    if (last) for (const s of [last.from, last.to]) { const h = document.createElement('div'); h.className = 'highlight square-' + ((s & 7) + 1) + ((s >> 3) + 1); board.appendChild(h); }
  };
  const play = (uci) => { const m = CV.chess.legalMoves(pos).find((x) => x.uci === uci); pos = CV.chess.apply(pos, m); last = m; played.push(uci); render(); };
  for (const u of moves) play(u);
  const sqAt = (x, y) => CV.chess.FILES[Math.floor(x / 100)] + (8 - Math.floor(y / 100));
  board.addEventListener('click', (ev) => {
    if (pos.turn !== 'w') return;
    const sq = sqAt(ev.clientX, ev.clientY);
    if (!selected) { selected = sq; return; }
    const m = CV.chess.legalMoves(pos).find((x) => x.uci.slice(0, 4) === selected + sq && (!x.promo || x.promo === 'q'));
    selected = null;
    if (!m) return;
    play(m.uci);
    if (onOurMove) onOurMove(m.uci);
  });

  for (const [k, v] of Object.entries({ enabled: true, overlayOpen: false, ...settings })) storage.data[k] = v;
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  window.browser = {
    runtime: {
      getManifest: () => ({ version: 'bench' }),
      getURL: (p) => p,
      sendMessage: (msg) => {
        c.now.sendMessage++;
        const t = (msg && msg.type) || '?';
        c.now.byType[t] = (c.now.byType[t] || 0) + 1;
        return msg && msg.type === 'allowlist' ? Promise.resolve('chess.com/play/computer\n') : bg.send(clone(msg)).then(clone);
      },
      connect: (o) => {
        c.now.connects++;
        const p = bg.connect(o && o.name);
        return { name: p.name, postMessage: (m) => { c.now.portOut++; p.postMessage(m); },
          onMessage: { addListener: (fn) => p.onMessage.addListener((m) => { c.now.portIn++; fn(m); }) },
          onDisconnect: p.onDisconnect, disconnect: p.disconnect };
      },
    },
    storage: {
      local: {
        get: (q) => { c.now.storageGet++; return storage.local.get(q); },
        set: (o) => { c.now.storageSet++; return storage.local.set(o); },
        remove: (k) => storage.local.remove(k),
      },
      onChanged: storage.onChanged,
    },
  };
  window.console = { log() {}, warn() {}, error: (...a) => { if (process.env.SHOW_ERRORS) console.error('[content]', ...a); }, info() {}, debug() {} };
  let overlayOpts = null;
  for (const f of SCRIPTS) {
    window.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    if (f === 'overlay.js') { const orig = window.CV.createOverlay; window.CV.createOverlay = (o) => { overlayOpts = o; return orig(o); }; }
  }
  return {
    window, board, bg, storage, c, played, overlay: () => overlayOpts,
    turn: () => pos.turn, botPlay: play, onOurMove: (fn) => { onOurMove = fn; },
    reset: () => { const old = c.now; c.now = newCounters(); return old; },
    close: async () => { window.close(); await bg.send({ type: 'aggroInvalidate' }); },
  };
}

const OPENING = ['e2e4', 'e7e5', 'g1f3'];     // we are White; Black to move

async function idle(ponder) {
  const settings = ponder ? { engine: 'stockfish', sfPonder: true } : { engine: 'stockfish', sfPonder: false, aggroPonder: false };
  const p = await openPage({ settings, moves: OPENING });
  await sleep(3000);                            // attach, allowlist, first checks, the ponder job start
  p.reset();
  await sleep(SECONDS * 1000);
  const r = p.reset();
  await p.close();
  return r;
}

async function cycle() {
  const p = await openPage({ settings: { engine: 'stockfish' }, moves: OPENING });
  await sleep(3000);
  let ours = null, at = 0;
  p.onOurMove((u) => { ours = u; at = Date.now(); });
  p.reset();
  const t0 = Date.now();
  p.botPlay('b8c6');
  while (!ours && Date.now() - t0 < 15000) await sleep(20);
  const reactMs = ours ? at - t0 : null;
  if (ours) await sleep(2500);
  const r = p.reset();
  const dbg = JSON.parse(await p.overlay().onDebug());
  const msg = await p.overlay().onSaveNow();
  await sleep(200);
  const saved = Object.entries(p.storage.data).filter(([k]) => k === 'savedGames' || k.startsWith('game:'));
  let pgn = null;
  for (const [k, v] of saved) { const g = Array.isArray(v) ? v[0] : v; if (g && g.pgn) pgn = g.pgn.replace(/\[Date "[^"]*"\]\n/, ''); }
  await p.close();
  return { ...r, move: ours, reactMs, saveMsg: msg, pgn, history: dbg.history, unstableReads: dbg.state.unstableReads };
}

async function main() {
  const only = opt('--only', 'idle,ponder,cycle').split(',');
  const out = {};
  if (only.includes('idle')) out.idle = await idle(false);
  if (only.includes('ponder')) out.ponder = await idle(true);
  if (only.includes('cycle')) out.cycle = await cycle();
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  console.log('root ' + ROOT + ', idle ' + SECONDS + ' s');
  const rows = {};
  for (const [k, r] of Object.entries(out)) {
    rows[k] = { boardReads: r.boardReads, docQueries: r.docQueries, rects: r.rects, clientRects: r.clientRects, fromPoint: r.elementsFromPoint + '/' + r.elementFromPoint,
      sendMessage: r.sendMessage, connects: r.connects, portIn: r.portIn, storageSet: r.storageSet };
  }
  console.table(rows);
  for (const [k, r] of Object.entries(out)) console.log(k, 'messages by type:', JSON.stringify(r.byType));
  if (out.cycle) console.log('cycle: move', out.cycle.move, 'react', out.cycle.reactMs, 'ms;', out.cycle.saveMsg, '; history', JSON.stringify(out.cycle.history), '\n' + out.cycle.pgn);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
