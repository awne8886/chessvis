// Smoke harness (not a test, 2.0.2 C4): every content script in jsdom on a mock chess.com board, talking to the REAL
// background.js with fake engine workers (tests/_fakebg.js). A scripted bot answers our moves; its board updates come
// in one DOM step, or in two (the moved piece removed, the whole board re-rendered --gap ms later, default 15: the
// pattern where a read can catch a half-updated board).
//
//   npm install --no-save --prefix .build jsdom@31.0.1
//   NODE_PATH=.build/node_modules node tests/smoke-board.js [--games 3] [--moves 8] [--engine stockfish|aggro]
//       [--debounce 80,40,20] [--steps 1,2] [--gap 15] [--watchdog 1000] [--watchdog-stable both|on|off] [--v200] [--json]
// --v202: CV.PONDER_SETTLE and CV.SF_CLAIM_STOPPING off (2.0.3 changes). --v200: the 2.0.0 behaviour (ponderHitTopUp off and the 2.0.2 constants off: CV.AGGRO_PONDER_RECYCLE,
// CV.AGGRO_SCAN_FLOOR_MS 20, CV.AGGRO_INTERRUPT; --debounce 80 and --watchdog-stable off give the rest).
//
// Reported per configuration (sums over the games): our moves played, tracker resets (history gaps; ideally 0),
// unstable reads (the stable read caught a moving board), ponder hits / misses / late (background counters), and the
// reaction time from the bot's board update to our first click (median ms, includes the human-like pause).
'use strict';
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.error('This harness needs jsdom:\n  npm install --no-save --prefix .build jsdom@31.0.1\n  NODE_PATH=.build/node_modules node tests/smoke-board.js');
  process.exit(2);
}
const fs = require('fs');
const path = require('path');
const { makeBackground, sleep, CV } = require('./_fakebg');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SCRIPTS = ['settings.js', 'chessmini.js', 'humanize.js', 'boardstate.js', 'clock.js', 'pgn.js', 'brilliant.js', 'recorder.js', 'overlay.js', 'content.js'];
const START = CV.STANDARD_START_FEN;

let seed = 99;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 2 ** 31; };

const GAP_MS = Number(opt('--gap', 15));
const V200 = args.includes('--v200');
const V202 = args.includes('--v202') || V200;     // 2.0.3 off: CV.PONDER_SETTLE, CV.SF_CLAIM_STOPPING
async function game({ engine, debounce, steps, watchdogMs, watchdogStable, moves: maxMoves }) {
  const bg = makeBackground({ stepMs: 3, aggroStartMs: 30 });
  if (V200) bg.get('CV.AGGRO_PONDER_RECYCLE = false; CV.AGGRO_SCAN_FLOOR_MS = 20; CV.AGGRO_INTERRUPT = false');
  if (V202) bg.get('CV.PONDER_SETTLE = false; CV.SF_CLAIM_STOPPING = false');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.chess.com/play/computer', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  window.innerWidth = 1200; window.innerHeight = 900;

  // ---- the mock board ----
  const board = document.createElement('wc-chess-board');
  board.className = 'board';
  document.body.appendChild(board);
  board.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 800, width: 800, height: 800, x: 0, y: 0 });
  document.elementsFromPoint = () => [board];
  let pos = CV.chess.parseFen(START), last = null, gameMoves = [], selected = null, ourMoves = 0, botUpdateAt = null;
  const reactions = [];
  const render = (half) => {
    board.textContent = '';
    for (let s = 0; s < 64; s++) {
      const p = pos.b[s];
      if (!p) continue;
      if (half && last && (s === last.to)) continue;            // two-step update: the moved piece is gone for a moment
      const el = document.createElement('div');
      el.className = 'piece ' + (p === p.toUpperCase() ? 'w' : 'b') + p.toLowerCase() + ' square-' + ((s & 7) + 1) + ((s >> 3) + 1);
      board.appendChild(el);
    }
    if (last) for (const s of [last.from, last.to]) { const h = document.createElement('div'); h.className = 'highlight square-' + ((s & 7) + 1) + ((s >> 3) + 1); board.appendChild(h); }
  };
  const play = (m, twoStep) => {
    pos = CV.chess.apply(pos, m); last = m; gameMoves.push(m.uci);
    if (twoStep) { render(true); setTimeout(() => render(false), GAP_MS); } else render(false);
  };
  render(false);
  const sqAt = (x, y) => CV.chess.FILES[Math.floor(x / 100)] + (8 - Math.floor(y / 100));
  board.addEventListener('click', (ev) => {
    if (pos.turn !== 'w') return;
    const sq = sqAt(ev.clientX, ev.clientY);
    if (botUpdateAt !== null) { reactions.push(Date.now() - botUpdateAt); botUpdateAt = null; }
    if (!selected) { selected = sq; return; }
    const m = CV.chess.legalMoves(pos).find((x) => x.uci.slice(0, 4) === selected + sq && (!x.promo || x.promo === 'q'));
    selected = null;
    if (!m) return;
    play(m, false);
    ourMoves++;
    if (ourMoves >= maxMoves) return;
    // the bot: thinks 300-1500 ms, plays the fake engine's first move most of the time (a predictable opponent: hits)
    setTimeout(() => {
      const legal = CV.chess.legalMoves(pos);
      if (!legal.length) return;
      const sorted = legal.slice().sort((a, b) => (a.uci < b.uci ? -1 : 1));
      const mv = rnd() < 0.7 ? sorted[0] : legal[Math.floor(rnd() * legal.length)];
      play(mv, steps === 2);
      botUpdateAt = Date.now();
    }, 300 + rnd() * 1200);
  });

  // ---- the extension's environment ----
  const store = { enabled: true, engine, boardDebounceMs: debounce, watchdogMs, overlayOpen: false, ...(V200 ? { ponderHitTopUp: false } : {}) };
  const listeners = [];
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  window.browser = {
    runtime: {
      getManifest: () => ({ version: 'smoke' }),
      getURL: (p) => p,
      sendMessage: (msg) => (msg && msg.type === 'allowlist' ? Promise.resolve('chess.com/play/computer\n') : bg.send(clone(msg)).then(clone)),
    },
    storage: {
      local: {
        get: async (defs) => ({ ...(defs || {}), ...clone(store) }),
        set: async (obj) => { Object.assign(store, obj); const ch = {}; for (const k in obj) ch[k] = { newValue: obj[k] }; listeners.forEach((fn) => fn(ch)); },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  window.console = { log() {}, warn() {}, error: (...a) => { if (process.env.SHOW_ERRORS) console.error('[content]', ...a); }, info() {}, debug() {} };
  let overlayOpts = null;
  for (const f of SCRIPTS) {
    window.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    if (f === 'settings.js') window.CV.WATCHDOG_STABLE_READ = watchdogStable;
    if (f === 'overlay.js') { const orig = window.CV.createOverlay; window.CV.createOverlay = (o) => { overlayOpts = o; return orig(o); }; }
  }
  const deadline = Date.now() + 8000 + maxMoves * 4000;
  while (ourMoves < maxMoves && Date.now() < deadline && !CV.chess.gameState(pos)) await sleep(50);
  await sleep(300);
  const info = JSON.parse(await overlayOpts.onDebug());
  window.close();
  await bg.send({ type: 'aggroInvalidate' });
  const p = info.background.ponder;
  const tu = p.hitTopUp || { started: 0, changed: 0 };
  const aw = p.aggroWorkers || {};
  return { moves: ourMoves, resets: info.history.historyResets, unstable: info.state.unstableReads, hits: p.hits, misses: p.misses, late: p.late, topUps: tu.started, changed: tu.changed,
    leadMs: p.avgLeadMs || 0, spawns: aw.spawns || 0, jobs: aw.jobs || 0, hitDepths: p.hitDepths || [], reactions,
    sfStarts: (info.background.stockfish || {}).workerStarts || 0, attempts: p.attempts || 0 };
}

async function main() {
  const games = Number(opt('--games', 3)), moves = Number(opt('--moves', 8));
  const engine = opt('--engine', 'stockfish');
  const debounces = opt('--debounce', '80,40,20').split(',').map(Number);
  const stepsList = opt('--steps', '1,2').split(',').map(Number);
  const watchdogMs = Number(opt('--watchdog', 1000));
  const wsOpt = opt('--watchdog-stable', 'on');
  const wsList = wsOpt === 'both' ? [false, true] : [wsOpt !== 'off'];
  const rows = [];
  for (const steps of stepsList) {
    for (const ws of wsList) {
      for (const debounce of debounces) {
        const sum = { steps, watchdogStable: ws, debounce, moves: 0, resets: 0, unstable: 0, hits: 0, misses: 0, late: 0, topUps: 0, changed: 0, spawns: 0, jobs: 0, sfStarts: 0, attempts: 0, leads: [], reactions: [] };
        for (let g = 0; g < games; g++) {
          const r = await game({ engine, debounce, steps, watchdogMs, watchdogStable: ws, moves });
          for (const k of ['moves', 'resets', 'unstable', 'hits', 'misses', 'late', 'topUps', 'changed', 'spawns', 'jobs', 'sfStarts', 'attempts']) sum[k] += r[k];
          if (r.leadMs) sum.leads.push(r.leadMs);
          sum.reactions.push(...r.reactions);
        }
        const rs = sum.reactions.sort((a, b) => a - b);
        rows.push({ steps: sum.steps + '-step', watchdog: (ws ? 'stable' : 'direct') + ' ' + watchdogMs, debounce: sum.debounce, moves: sum.moves, resets: sum.resets, unstable: sum.unstable,
          hits: sum.hits, misses: sum.misses, late: sum.late, topUps: sum.topUps, changed: sum.changed, reactMedian: rs.length ? rs[rs.length >> 1] : null,
          leadMs: sum.leads.length ? Math.round(sum.leads.reduce((a, b) => a + b, 0) / sum.leads.length) : null,
          respawnsPerMove: engine === 'aggro' && sum.jobs ? +(sum.spawns / sum.jobs).toFixed(2) : null,
          sfStartsPerJob: engine !== 'aggro' && sum.attempts ? +(sum.sfStarts / sum.attempts).toFixed(2) : null });
      }
    }
  }
  if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else { console.log(games + ' games x ' + moves + ' moves, engine ' + engine + ' (fake workers), watchdog ' + watchdogMs + ' ms'); console.table(rows); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
