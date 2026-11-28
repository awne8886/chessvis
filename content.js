(() => {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const CV = window.CV;
  if (!CV || window.__chessvisionLoaded) return;
  window.__chessvisionLoaded = true;

  const DEBUG = true;
  const FALLBACK_VERSION = '2.0.3';
  const VERSION = (() => { try { return api.runtime.getManifest().version || FALLBACK_VERSION; } catch (e) { return FALLBACK_VERSION; } })();
  const log = (...a) => DEBUG && console.log('[ChessVision]', ...a);
  const { FILES } = CV.chess;
  const BS = CV.boardstate;

  // Pages where auto-play is allowed come from allowed-pages.txt (served by background.js).
  // The page is an SPA, so the match is re-evaluated on every check, not once at load.
  let allowed = null;                       // null = list not loaded yet
  const isAllowedPage = () => !!allowed && CV.matchPage(allowed, location.hostname, location.pathname);
  api.runtime.sendMessage({ type: 'allowlist' })
    .then((text) => { allowed = CV.parseAllowlist(text); log('allowed pages:', allowed); schedule(0, 'allowlist'); })
    .catch((e) => { allowed = []; console.error('[ChessVision] could not load allowed-pages.txt', e); });

  const ATTEMPTS_MAX = 3;          // retries if a move does not register
  const RETRY_AFTER_MS = 1800;     // how long to wait before deciding a move did not register
  const BUSY_TIMEOUT_MS = 45000;   // a move attempt stuck longer than this is abandoned
  const STABLE_GAP_MS = 20;        // stable read: second board read one animation frame + this long after the first
  const UNSTABLE_MAX = 10;         // after this many unstable reads in a row, check() runs anyway (the watchdog would too)

  let cfg = { ...CV.DEFAULTS };
  let board = null, observer = null, debounceTimer = null, watchdogTimer = null;
  let busy = false, busySince = 0, playToken = 0, recheckPending = false;
  let lastHandledKey = null, attempts = 0;
  let unstableReads = 0, unstableRun = 0, stableSeq = 0;   // stable-read debounce (2.0.0): total / in a row / cancels an outdated check
  let stableArmed = false;                       // 2.0.2: a stable read is scheduled or under way (the watchdog then skips its tick)
  let lastCheckSig = null, lastCheckAt = 0;      // 2.0.4 (A1): signature of the board the last check() used, and when it ran
  let retryWaiting = false;                      // 2.0.4 (A1): play()'s move-confirmation timer is pending
  let attachSkips = 0;                           // 2.0.4 (A1): re-attach ticks skipped while the board is still in the page
  let filteredMutations = 0;                     // 2.0.4 (A3): mutation batches that could not change a board read
  let rights = BS.freshRights();
  const tracker = BS.createTracker();            // the one game-tracking mechanism (history, new game, takeback)
  const rec = CV.createRecorder();               // records every ply the tracker reports
  let lastGrid = null;                           // grid of the latest board read (for rights after tracker events)
  let lastClock = null;                          // { ms, mode } when the last full search was sized from my clock
  let idleKey = null, idlePondering = false, idleFound = 0;     // AggroChess idle work (evaluation line / pondering) for this position
  let metaAt = 0, saveChain = Promise.resolve();
  let ownMove = null;              // { afterCount } - piece count expected right after our own last move
  let ctxCache = null;             // { fen, opponentCaptured, lastTo }
  let mouse = { x: null, y: null };
  let dragDisabled = false;        // set when a drag did not register; clicks are used instead
  let lastMode = null;             // input method used for the last move
  let atStart = false;             // true while the untouched start position is on the board
  let overCache = null;            // { fen, value } game-over result per position
  let fast = false;                // true while executing a quick reply: faster hand, shorter pauses
  let ui = null;
  let wfoShown = false;            // 2.0.4: the status line shows the waiting state (a pushed ponder status may update it)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------- Status ----------
  function setStatus(text, tone) {
    wfoShown = false;
    if (ui) ui.setStatus(text, tone);
  }
  const hum = () => cfg.humanize;

  // ---------- Board / FEN ----------
  function findBoard() {
    return document.querySelector('wc-chess-board') ||
           document.querySelector('chess-board') ||
           document.querySelector('.board');
  }

  function squareFromClasses(el) {
    for (const c of el.classList) {
      const m = c.match(/^square-(\d)(\d)$/);
      if (m) return [+m[1], +m[2]]; // [file, rank]
    }
    return null;
  }

  function readPosition() {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null)); // grid[rank-1][file-1]
    let count = 0;
    board.querySelectorAll('.piece').forEach((el) => {
      let piece = null;
      for (const c of el.classList) if (/^[wb][pnbrqk]$/.test(c)) piece = c;
      const sq = squareFromClasses(el);
      if (!piece || !sq) return;
      grid[sq[1] - 1][sq[0] - 1] = piece[0] === 'w' ? piece[1].toUpperCase() : piece[1];
      count++;
    });
    const highlights = [...board.querySelectorAll('.highlight')]
      .map(squareFromClasses).filter(Boolean);
    return { grid, count, highlights };
  }

  // Forget everything that belongs to the previous game.
  function resetGameState() {
    ownMove = null; ctxCache = null; overCache = null;
    lastHandledKey = null; attempts = 0;
  }

  // 'checkmate' | 'stalemate' from the rules, or 'game over' if chess.com's result dialog is showing.
  // 2.0.4 (A1): the plain class selector on every check; the attribute-substring selector (a slower document-wide match)
  // only in the watchdog's forced check (CV.WATCHDOG_FORCE_MS) or with CV.WATCHDOG_SKIP_UNCHANGED off (2.0.3: both always).
  function gameOverFor(pos, forced) {
    if (!overCache || overCache.fen !== pos.fen) {
      overCache = { fen: pos.fen, value: CV.chess.gameState(CV.chess.parseFen(pos.fen)) };
    }
    if (overCache.value) return overCache.value;
    let modal;
    if (!CV.WATCHDOG_SKIP_UNCHANGED) modal = document.querySelector('.game-over-modal-container, [class*="game-over-modal"]');
    else {
      modal = document.querySelector('.game-over-modal-container');
      if (!(modal && modal.getClientRects().length) && forced) modal = document.querySelector('[class*="game-over-modal"]');
    }
    return modal && modal.getClientRects().length ? 'game over' : null;
  }

  function readBoardState() {
    if (!board) return null;
    const { grid, count, highlights } = readPosition();
    return count ? { grid, count, highlights } : null;
  }

  // 2.0.4 (A2): one board read with its signature: { grid, count, highlights, sig }, or null without a board. The stable
  // read's second read is handed to check() as it is, so a stable check costs two reads, not three.
  function readBoard() {
    if (!board) return null;
    const r = readPosition();
    r.sig = BS.signature(r.grid, r.highlights);
    return r;
  }

  // Reads the board and feeds the tracker. Only ever called on allowed pages, on every board read
  // (also while Auto-play is off), so moves made by hand or while paused are recorded too.
  // read (2.0.4, optional): a readBoard() result taken just before (synchronously), used instead of a fresh read.
  function observeBoard(read) {
    const st = read ? (read.count ? read : null) : readBoardState();
    if (!st) return null;
    lastGrid = st.grid;
    rights = BS.updateRights(rights, st.grid);
    const p = BS.buildPosition(st.grid, st.highlights, rights);
    atStart = p.placement === BS.START_PLACEMENT && !st.highlights.length;
    const obs = { placement: p.placement, turn: p.turn, turnKnown: !!p.lastMover, castle: p.castle, ep: p.ep, count: st.count, highlighted: st.highlights.length > 0, lastTo: p.lastTo };
    const events = tracker.observe(obs);                 // live history for the engines
    for (const ev of events) handleTrackerEvent(ev);
    const abandoned = rec.observe(obs);                  // the recorder keeps its own list of seen positions (see recorder.js)
    if (abandoned) {   // a new game began without the old one being seen to end: keep it with an unknown result
      const record = rec.build(abandoned, { cfg, result: '*' });
      if (CV.pgn.shouldSave(cfg, record)) storeGame(record);
    }
    return { st, p, sig: st.sig || BS.signature(st.grid, st.highlights) };
  }

  function handleTrackerEvent(ev) {
    if (ev.type === 'newGame') {
      rights = BS.freshRights();
      if (lastGrid) rights = BS.updateRights(rights, lastGrid);
      resetGameState();
      idleKey = null; if (ui) { ui.setEval(''); ui.setWarn(''); }
      api.runtime.sendMessage({ type: 'aggroClear' }).catch(() => {});      // a real new game, not a takeback
    } else if (ev.type === 'takeback') {
      rights = BS.rightsFromString(ev.castle);
      if (lastGrid) rights = BS.updateRights(rights, lastGrid);
      resetGameState();
      idleKey = null; if (ui) ui.setEval('');
      api.runtime.sendMessage({ type: 'aggroInvalidate' }).catch(() => {});
    }
  }

  // obs: the observation check() already made (observeBoard's result), so one check() reads the board once. Without it
  // (the re-check in play(), the retry timer, debug info) the board is read fresh.
  function buildFen(obs) {
    if (!board) return null;
    if (obs === undefined) obs = isAllowedPage() ? observeBoard() : null;
    let st = obs && obs.st, p = obs && obs.p;
    if (!obs) {
      st = readBoardState();
      if (!st) return null;
      p = BS.buildPosition(st.grid, st.highlights, BS.updateRights(rights, st.grid));
    }
    const prefix = p.placement + ' ' + p.turn;
    const info = obs && tracker.matches(prefix) ? tracker.info() : null;
    const myColor = board.classList.contains('flipped') ? 'b' : 'w';
    const fen = BS.assembleFen({ placement: p.placement, turn: p.turn, castle: p.castle, ep: p.ep, halfmove: info ? info.halfmove : 0, fullmove: info ? info.fullmove : 1 });
    return { fen, turn: p.turn, myColor, count: st.count, lastTo: p.lastTo };
  }

  // Pieces + highlights as one string (BS.signature); '' without a board.
  function boardSignature() {
    const r = readBoard();
    return r ? r.sig : '';
  }

  // startFen + moves for an engine, only when the tracked history ends exactly at this position; else null.
  function histFor(pos) {
    if (!tracker.matches(pos.fen)) return null;
    const i = tracker.info();
    return { startFen: i.startFen, moves: i.moves };
  }

  // ---------- Input: pointer events ----------
  // rect (2.0.4, D2): the board's rect, read once per move by movePoints (else read here, as in 2.0.3)
  function squareCenter(file, rank, rect) {
    rect = rect || board.getBoundingClientRect();
    const s = rect.width / 8;
    const flipped = board.classList.contains('flipped');
    const x = flipped ? (8 - file + 0.5) * s : (file - 0.5) * s;
    const y = flipped ? (rank - 0.5) * s : (8 - rank + 0.5) * s;
    return [rect.left + x, rect.top + y];
  }

  // Click target inside a square; off-centre (centre-weighted) when "Off-centre clicks" is on.
  function squarePoint(file, rank, rect) {
    const [cx, cy] = squareCenter(file, rank, rect);
    if (!(hum() && cfg.clickOffset)) return { x: cx, y: cy };
    const s = (rect || board.getBoundingClientRect()).width / 8;
    const off = () => (Math.random() + Math.random() - 1) * 0.32 * s;
    return { x: cx + off(), y: cy + off() };
  }

  function fire(el, type, x, y, buttons) {
    const isPointer = type.startsWith('pointer');
    const Ctor = isPointer && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: buttons === undefined ? (type.endsWith('down') ? 1 : 0) : buttons,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
  }

  // The synthetic events never depend on the real cursor, so the panel is skipped when choosing the target
  // (a panel dragged over the board must not swallow the moves).
  // 2.0.4 (D2): elementFromPoint first: it is the first element elementsFromPoint would list, and only a hit on the panel
  // (its shadow root retargets to ui.host) or on nothing needs the full list. The same element as before for every
  // point (checked in Chromium, tests/bench-hittest.js). CV.CHEAP_HIT_TEST = false: always elementsFromPoint (2.0.3).
  const targetAt = (x, y) => {
    const host = ui && ui.host;
    if (CV.CHEAP_HIT_TEST && document.elementFromPoint) {
      const top = document.elementFromPoint(x, y);
      if (top && top !== host) return top;
    }
    if (document.elementsFromPoint) return document.elementsFromPoint(x, y).find((el) => el !== host) || board;
    return document.elementFromPoint(x, y) || board;
  };

  function moveTo(x, y, buttons) {
    const el = targetAt(x, y);
    fire(el, 'pointermove', x, y, buttons);
    fire(el, 'mousemove', x, y, buttons);
    mouse = { x, y };
  }

  // Moves the cursor to (x, y): along a curved path when enabled, otherwise it just appears there.
  async function glideTo(x, y, buttons = 0, linearSteps, rect) {
    if (!(hum() && cfg.mouseMove) && !linearSteps) { mouse = { x, y }; return; }
    if (mouse.x === null) {
      const r = rect || board.getBoundingClientRect();
      mouse = { x: Math.min(innerWidth - 5, Math.max(5, r.left + rand(0.1, 0.9) * r.width)), y: Math.min(innerHeight - 5, r.bottom + rand(20, 120)) };
    }
    if (mouse.x === x && mouse.y === y) return;                  // already there (aimMove glided during the pause): no empty path
    const smooth = hum() && cfg.mouseMove;
    const path = CV.human.buildPath(mouse.x, mouse.y, x, y, smooth ? { speed: fast ? 2.2 : 1 } : { linear: true, steps: linearSteps });
    // 2.0.4 (D1): Firefox clamps timers in a background tab to about 1 s, so a path of 8-38 steps with a sleep per step took
    // tens of seconds there (and could run into BUSY_TIMEOUT_MS). While the tab is hidden the path's events are sent
    // without the per-step waits; nobody sees the cursor. The pause before the move is one timer and stays.
    // CV.HIDDEN_NO_STEP_WAIT = false: always wait (2.0.3).
    const noWait = !!CV.HIDDEN_NO_STEP_WAIT && document.hidden;
    for (const p of path) { moveTo(p.x, p.y, buttons); if (!noWait) await sleep(p.dt); }
  }

  async function pressAt(x, y) {
    const el = targetAt(x, y);
    fire(el, 'pointerdown', x, y); fire(el, 'mousedown', x, y);
  }
  async function releaseAt(x, y, click) {
    const el = targetAt(x, y);
    fire(el, 'pointerup', x, y); fire(el, 'mouseup', x, y);
    if (click) fire(el, 'click', x, y);
  }

  async function clickAt(x, y, rect) {
    await glideTo(x, y, 0, undefined, rect);
    await pressAt(x, y);
    await sleep(hum() ? (fast ? rand(25, 60) : rand(35, 95)) : 15);
    await releaseAt(x, y, true);
    await sleep(hum() ? 0 : 15);
  }

  async function dragFromTo(a, b, rect) {
    await glideTo(a.x, a.y, 0, undefined, rect);
    await pressAt(a.x, a.y);
    await sleep(fast ? rand(30, 70) : rand(60, 130));
    await glideTo(b.x, b.y, 1, 6, rect);
    await sleep(rand(20, 60));
    await releaseAt(b.x, b.y, false);
  }

  // The click points of a move, computed once (off-centre points are random, so aim and finish must use the same ones).
  // 2.0.4 (D2): the board's rect is read once per move and passed down (2.0.3 read it for every point).
  function movePoints(uci) {
    const f1 = FILES.indexOf(uci[0]) + 1, r1 = +uci[1];
    const f2 = FILES.indexOf(uci[2]) + 1, r2 = +uci[3];
    const rect = CV.CHEAP_HIT_TEST ? board.getBoundingClientRect() : undefined;
    return { from: squarePoint(f1, r1, rect), to: squarePoint(f2, r2, rect), rect };
  }

  // 2.0.0: the cursor glides to the from-square while the human-like pause runs (play() does both at once), then
  // finishMove presses / clicks / drags from there. Returns the points for finishMove.
  async function aimMove(uci) {
    const pts = movePoints(uci);
    await glideTo(pts.from.x, pts.from.y, 0, undefined, pts.rect);
    return pts;
  }

  async function finishMove(pts, uci, color) {
    const { from, to, rect } = pts;
    let mode = CV.human.pickInput(cfg);
    if (mode === 'drag' && dragDisabled) mode = 'click';   // drag did not register earlier
    lastMode = mode;
    log('input method:', mode);

    if (mode === 'drag') {
      await dragFromTo(from, to, rect);
    } else {
      await clickAt(from.x, from.y, rect);
      await sleep(hum() ? (fast ? rand(50, 130) : rand(110, 340)) : rand(80, 160));
      await clickAt(to.x, to.y, rect);
    }
    if (uci.length === 5) { // promotion
      await sleep(hum() ? (fast ? rand(150, 260) : rand(250, 520)) : 300);
      const cls = color + uci[4];
      const el = document.querySelector(`.promotion-window .${cls}`) ||
                 document.querySelector(`[class*="promotion"] [class~="${cls}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        const jitter = hum() && cfg.clickOffset ? 0.25 : 0;
        await clickAt(r.left + r.width / 2 + rand(-jitter, jitter) * r.width, r.top + r.height / 2 + rand(-jitter, jitter) * r.height);
      } else log('promotion picker not found');
    }
  }

  // Aim + finish in one go (the path without a concurrent pause).
  async function executeMove(uci, color) {
    await finishMove(await aimMove(uci), uci, color);
  }

  // ---------- Engine ----------
  // CANDIDATE selectors for chess.com's clocks / player names. Untested against the real site; each reader
  // returns null when nothing matches or parses and never throws.
  const CLOCK_SELECTORS = ['.clock-bottom', '.clock-top', '[class*="clock"]'];
  const INCREMENT_SELECTORS = ['[class*="increment"]', '[class*="time-control"]'];
  const NAME_SELECTORS = ['.player-component .user-username-component', '[data-test-element="user-tagline-username"]', '.user-tagline-username', '[class*="user-username"]'];
  const clsOf = (el) => String((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '').toLowerCase();

  // 2.0.4 (D3): both clocks and the increment from ONE pass over the page: { me, opp } (each { ms, inc } or null), the
  // same values readClock(myColor, 'me' | 'opp') returned in 2.0.3 (selection rules: CV.clock.pickClock). me = my
  // colour's clock, else the bottom one; opp = the other colour's, else the top one. The matched elements are cached and
  // read again directly while they are in the page, still parse and keep their class; a fresh scan otherwise, and at
  // least every CV.DOM_CACHE_RESCAN_MS (a new element would win only then). CANDIDATE selectors, unverified on the real site.
  let clockCache = null;           // { myColor, me: { el, cls }, opp: { el, cls } | null, at }
  let incCache = null;             // { el } of the increment element last read (only a non-zero increment is cached)
  const cacheFresh = (c) => !!c && CV.DOM_CACHE && Date.now() - c.at < CV.DOM_CACHE_RESCAN_MS;
  const clockOf = (x) => { if (!x || !x.el.isConnected || clsOf(x.el) !== x.cls) return undefined; const ms = CV.clock.parseClock(x.el.textContent); return ms === null ? undefined : ms; };
  function readIncrement() {
    if (CV.DOM_CACHE && incCache && incCache.el.isConnected) { const inc = CV.clock.parseIncrement(incCache.el.textContent); if (inc) return inc; }
    incCache = null;
    for (const sel of INCREMENT_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) { const inc = CV.clock.parseIncrement(el.textContent); if (inc) { incCache = { el }; return inc; } }
    }
    return 0;
  }
  function readClocks(myColor) {
    try {
      let meMs, oppMs;
      const c = clockCache;
      if (cacheFresh(c) && c.myColor === myColor && (meMs = clockOf(c.me)) !== undefined && (!c.opp || (oppMs = clockOf(c.opp)) !== undefined)) {
        if (!c.opp) oppMs = null;
      } else {
        clockCache = null;
        const seen = new Set(), cands = [];
        for (const sel of CLOCK_SELECTORS) {
          for (const el of document.querySelectorAll(sel)) {
            if (seen.has(el)) continue;
            seen.add(el);
            const ms = CV.clock.parseClock(el.textContent);
            if (ms !== null) cands.push({ ms, cls: clsOf(el), el });
          }
        }
        const p = CV.clock.pickClocks(cands, myColor);
        meMs = p.me ? p.me.ms : null; oppMs = p.opp ? p.opp.ms : null;
        if (p.me) clockCache = { myColor, me: { el: p.me.el, cls: p.me.cls }, opp: p.opp ? { el: p.opp.el, cls: p.opp.cls } : null, at: Date.now() };
      }
      if (meMs === null && oppMs === null) return { me: null, opp: null };
      const inc = readIncrement();
      return { me: meMs === null ? null : { ms: meMs, inc }, opp: oppMs === null ? null : { ms: oppMs, inc } };
    } catch (e) { return { me: null, opp: null }; }
  }
  const readMyClock = (myColor) => readClocks(myColor).me;

  // { me, opp } player names (top name = opponent, bottom = me), or null. 2.0.4 (D3): the two elements that gave them are
  // cached and re-read (text, position) while they are in the page and still valid; a fresh scan otherwise / every
  // CV.DOM_CACHE_RESCAN_MS.
  let nameCache = null;            // { a, b, at }: the elements of the topmost and the lowest name
  const nameText = (el) => { const t = (el.textContent || '').trim(); return t && t.length <= 40 ? t : null; };
  function readNames() {
    try {
      const c = nameCache;
      if (cacheFresh(c) && c.a.isConnected && c.b.isConnected) {
        const ta = nameText(c.a), tb = nameText(c.b);
        if (ta && tb && ta !== tb) return CV.clock.pickNames([{ t: ta, top: c.a.getBoundingClientRect().top }, { t: tb, top: c.b.getBoundingClientRect().top }]);
      }
      nameCache = null;
      const found = [], seen = new Set();
      for (const sel of NAME_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.textContent || '').trim();
          if (!t || t.length > 40 || seen.has(t)) continue;
          seen.add(t);
          found.push({ t, top: el.getBoundingClientRect().top, el });
        }
      }
      const r = CV.clock.pickNames(found);
      if (r) {
        const s = found.slice().sort((x, y) => x.top - y.top);
        nameCache = { a: s[0].el, b: s[s.length - 1].el, at: Date.now() };
      }
      return r;
    } catch (e) { return null; }
  }

  // Stockfish pondering is off while Imperfection is above 0: a prepared reply is always the best line, the imperfection choice would be skipped.
  function sfPonderOn() { return cfg.engine === 'stockfish' && cfg.sfPonder && !(hum() && cfg.imperfection > 0); }

  // The clock part of a FULL search (sets lastClock): AggroChess soft/hard from my clock (aggroUseClock), the Stockfish time
  // cap (sfMaxMs, combined with the clock budget when sfUseClock is on). Called before the human-like delay is drawn, so
  // the delay can be capped by the clock (CV.clock.delayCap) before the engine is asked.
  function fullPlan(pos) {
    lastClock = null;
    const plan = { soft: undefined, hard: undefined, sfCap: cfg.engine === 'stockfish' ? cfg.sfMaxMs : 0 };
    if (cfg.engine === 'aggro' && cfg.aggroUseClock) {
      const clk = readMyClock(pos.myColor);
      const budget = clk && CV.clock.clockBudget({ remainingMs: clk.ms, incrementMs: clk.inc, thinkMs: cfg.thinkMs });
      if (budget) { plan.soft = budget.soft; plan.hard = budget.hard; lastClock = { ms: clk.ms, mode: budget.mode, soft: budget.soft, hard: budget.hard }; log('clock', clk.ms, 'ms ->', budget); }
    }
    if (cfg.engine === 'stockfish' && cfg.sfSearchMode === 'clock') {
      // 2.0.0 'clock' mode: Stockfish's own time manager gets both clocks (go wtime/btime/winc/binc); a JS timer stops it at
      // the clock.js hard limit (<= a quarter of what is left, and <= sfMaxMs when set). No readable clock of mine = 'delay'
      // for this move. The opponent's clock unreadable = mine for both. Clock selectors: unverified on the real site.
      const both = readClocks(pos.myColor), clk = both.me;             // 2.0.4 (D3): one pass for both clocks
      const budget = clk && CV.clock.clockBudget({ remainingMs: clk.ms, incrementMs: clk.inc, thinkMs: cfg.sfMaxMs > 0 ? cfg.sfMaxMs : 5000 });
      if (!budget) { plan.searchMode = 'delay'; log('clock mode: my clock not readable, delay mode for this move'); }
      else {
        const opp = both.opp, oppMs = opp ? opp.ms : clk.ms, inc = clk.inc || 0;
        plan.uciClock = pos.myColor === 'w' ? { wtime: clk.ms, btime: oppMs, winc: inc, binc: inc } : { wtime: oppMs, btime: clk.ms, winc: inc, binc: inc };
        plan.sfCap = CV.sfSearchCap(cfg.sfMaxMs, budget.hard);
        lastClock = { ms: clk.ms, mode: budget.mode, soft: budget.soft, hard: budget.hard, opp: opp ? opp.ms : null };
        log('clock mode', plan.uciClock, 'hard', plan.sfCap);
      }
      return plan;
    }
    if (cfg.engine === 'stockfish' && cfg.sfUseClock) {            // optional: never more than the clock allows (clock.js: <= a quarter of what is left)
      const clk = readMyClock(pos.myColor);
      const budget = clk && CV.clock.clockBudget({ remainingMs: clk.ms, incrementMs: clk.inc, thinkMs: cfg.sfMaxMs > 0 ? cfg.sfMaxMs : 5000 });
      if (budget) { plan.sfCap = CV.sfSearchCap(cfg.sfMaxMs, budget.soft); lastClock = { ms: clk.ms, mode: budget.mode, soft: budget.soft, hard: budget.hard }; log('clock', clk.ms, 'ms -> sf cap', plan.sfCap); }
    }
    return plan;
  }

  // Does the full search use the human-like pause as engine time (2.0.0)? Stockfish: sfSearchMode 'delay' / 'clock';
  // AggroChess: the constant CV.AGGRO_DELAY_MATCH (false = 1.8.0).
  const delayMatched = () => (cfg.engine === 'stockfish' ? cfg.sfSearchMode !== 'depth' : !!CV.AGGRO_DELAY_MATCH);

  // Is pondering on for the current engine? (the `ponder` flag of a request)
  const ponderOn = () => sfPonderOn() || (cfg.engine === 'aggro' && cfg.aggroPonder);

  // quick = the cheap look for an obvious move (Stockfish depth <= 8, AggroChess quickThinkMs; no clock, no pause budget).
  // plan / softMs: only for the full search (fullPlan, and the delay-matched budget). hitSoftMs (2.0.2): the engine time
  // inside the pause a ponder hit would be played after (0 = no top-up).
  function askEngine(pos, quick, plan, softMs, hitSoftMs) {
    const depth = quick ? Math.min(cfg.depth, 8) : cfg.depth;
    const ms = quick ? Math.min(cfg.thinkMs, cfg.quickThinkMs) : cfg.thinkMs;
    const h = histFor(pos);
    if (quick) lastClock = null;
    const p = quick || !plan ? { sfCap: 0 } : plan;              // time cap only for the full search; quick looks stay depth <= 8
    return api.runtime.sendMessage({
      type: 'analyze', fen: pos.fen, engine: cfg.engine, depth, ms,
      startFen: h ? h.startFen : null, moves: h ? h.moves : null,       // null = no reliable history: engines get the bare FEN
      soft: p.soft, hard: p.hard, verify: cfg.engine === 'aggro' && cfg.aggroVerify, ponder: ponderOn(), sfThreads: cfg.engine === 'stockfish' ? cfg.sfThreads : undefined,
      imperfection: !quick && cfg.engine === 'stockfish' && hum() ? cfg.imperfection : 0,
      sfMaxMs: p.sfCap,
      sfSearchMode: quick ? 'depth' : (p.searchMode || cfg.sfSearchMode), softMs: quick ? 0 : (softMs || 0), uciClock: quick ? undefined : p.uciClock, spentMs: quick ? 0 : (p.spentMs || 0),
      hitSoftMs: quick ? 0 : (hitSoftMs || 0),
    });
  }

  // Context about the position that the FEN alone doesn't carry (cached per FEN so retries agree).
  function contextFor(pos) {
    if (ctxCache && ctxCache.fen === pos.fen) return ctxCache;
    ctxCache = {
      fen: pos.fen,
      opponentCaptured: !!(ownMove && pos.count < ownMove.afterCount),
      lastTo: pos.lastTo,
    };
    return ctxCache;
  }

  // ---------- Main loop ----------
  async function play(pos) {
    const token = ++playToken;
    busy = true; busySince = Date.now(); recheckPending = false;
    lastHandledKey = pos.fen;
    idleKey = null; idlePondering = false; idleFound = 0; if (ui) ui.setEval('');
    const t0 = Date.now();
    try {
      const parsed = CV.chess.parseFen(pos.fen);
      const legal = CV.chess.legalMoves(parsed);
      if (!legal.length) { setStatus('no legal moves (game over?)', 'warn'); return; }
      const ctx = contextFor(pos);
      const byUci = (u) => legal.find((m) => m.uci === u);
      const engineName = cfg.engine === 'stockfish' ? 'Stockfish' : 'AggroChess';

      let uci = null, category = null, sacrifice = false, ponderHit = false, topUp = null;
      // 2.0.0: the human-like delay of a normal move is drawn BEFORE the full search, so the engine can search through it
      // (delay-matched search). The move timing is unchanged: the wait is still max(delay, engine time).
      let plannedDelay = null;
      let hitDelay = null;                                  // 2.0.2 (C2): the pause a ponder hit gets, drawn with plannedDelay
      let quickSpent = 0;                                   // T10: AggroChess quick look that turned out not obvious
      const fullSearch = () => {
        const plan = fullPlan(pos);
        if (quickSpent && cfg.engine === 'aggro') plan.spentMs = quickSpent;
        plannedDelay = CV.human.delayFor(cfg, { legalCount: legal.length, category: null });
        if (lastClock) plannedDelay = CV.clock.delayCap(plannedDelay, lastClock.ms);       // the pause must not eat a short clock
        // 2.0.2 (C2): a ponder hit is played after the fast-reply pause (ponderHitFast) or the normal one; drawing it now lets
        // the background search on through it (ponderHitTopUp). The pause itself is the one it always was.
        hitDelay = null;
        if (cfg.ponderHitTopUp && ponderOn()) {
          hitDelay = cfg.ponderHitFast && cfg.quickReplies ? CV.human.delayFor(cfg, { legalCount: legal.length, category: null, fastReply: true }) : plannedDelay;
          if (lastClock) hitDelay = CV.clock.delayCap(hitDelay, lastClock.ms);
        }
        const spent = Date.now() - t0;
        const softMs = delayMatched() ? Math.max(0, Math.round(plannedDelay - CV.SF_DELAY_MARGIN_MS - spent)) : 0;
        const hitSoftMs = hitDelay === null ? 0 : Math.max(0, Math.round(hitDelay - CV.SF_DELAY_MARGIN_MS - spent));
        return askEngine(pos, false, plan, softMs, hitSoftMs);
      };

      if (cfg.quickReplies && cfg.quickOnlyMove && legal.length === 1) {
        uci = legal[0].uci; category = 'only';            // forced: no need to ask the engine
      } else {
        const likely = CV.human.likelyObvious(parsed, legal, ctx, cfg);
        setStatus(likely ? 'quick look (' + engineName + ')\u2026' : 'thinking (' + engineName + ')\u2026', 'on');
        const tq = Date.now();
        let res = likely ? await askEngine(pos, true) : await fullSearch();
        if (likely) quickSpent = Date.now() - tq;
        if (token !== playToken || !cfg.enabled) return;
        if (cfg.engine === 'aggro' && cfg.aggroVerify && ui) ui.setWarn(res && res.verifyWarning ? 'Verify: ' + res.verifyWarning : '');
        if (res && res.error) {                             // e.g. an engine failed to start: show it, don't hammer the engine
          setStatus(res.error, 'err'); log('engine error', res.error);
          return;                                           // lastHandledKey stays set; toggle Auto-play or play on to retry
        }
        if (likely) {
          category = res && res.uci ? CV.human.classify(parsed, byUci(res.uci), ctx, cfg, legal.length) : null;
          if (!category) {                                  // looked obvious, wasn't: think properly
            setStatus('thinking (' + engineName + ')\u2026', 'on');
            res = await fullSearch();
            if (token !== playToken || !cfg.enabled) return;
          }
        } else if (res && res.imperfect && res.best) {
          // an imperfect pick must never replace an obvious best move
          if (CV.human.classify(parsed, byUci(res.best), ctx, cfg, legal.length)) res = { ...res, uci: res.best };
        }
        uci = res && res.uci;
        sacrifice = !!(res && res.sacrifice);
        ponderHit = !!(res && res.ponderHit);
        topUp = ponderHit && res.topUp && !category ? res.topUp : null;     // 2.0.2: uci is provisional, the final move comes before the click
        if (res && res.imperfect && uci !== res.best) log('imperfection: played', uci, 'instead of', res.best);
      }

      if (!uci || uci === '(none)') {
        setStatus('no move returned', 'warn'); log('no move', uci);
        lastHandledKey = null;                              // let the watchdog try again, a few times
        if (attempts++ < ATTEMPTS_MAX) schedule(500, 'no-move retry');
        return;
      }

      // Early ponder (2.0.0): the move is final, so the opponent's turn can be prepared now instead of after the pause, the
      // cursor, chess.com's animation and the next board read. If the move is then discarded or does not register, the
      // next check() computes another key and restarts the job, and the background's decide() answers `miss` for any
      // position that does not extend this one (see sameBase in CV.createPonderState).
      const earlyPonder = () => {
        if (cfg.earlyPonder && idleWanted() && byUci(uci) && !document.hidden) {
          const h = histFor(pos);
          if (h) startIdle(h.startFen, [...h.moves, uci], pos.myColor);
        }
      };
      // 2.0.2 (C2): with a ponder-hit top-up the main worker is still searching: the final move is asked for now (it arrives
      // within the pause) and pondering starts once it is known (a ponder job never runs beside a real search).
      const finalP = topUp ? api.runtime.sendMessage({ type: 'hitTopUp', id: topUp.id }).catch(() => null) : null;
      if (!topUp) earlyPonder();

      // Human-like pause. The engine already ran, so only the remainder is waited. A quick category has its own short
      // delay; otherwise the delay drawn before the full search is used.
      // 2.0.0: a ponder hit with ponderHitFast gets the quick range too (fastReply), without becoming a quick category.
      const fastReply = !category && ponderHit && cfg.ponderHitFast && cfg.quickReplies;
      let delay = fastReply && hitDelay !== null ? hitDelay                 // 2.0.2: the hit pause drawn before the search
        : category || fastReply || plannedDelay === null ? CV.human.delayFor(cfg, { legalCount: legal.length, category, fastReply }) : plannedDelay;
      if (lastClock) delay = CV.clock.delayCap(delay, lastClock.ms);          // the pause must not eat a short clock
      const wait = Math.max(0, delay - (Date.now() - t0));
      fast = !!category || fastReply || !!(lastClock && lastClock.mode === 'low');     // low on time: the faster hand too (set before the glide below)
      // 2.0.0: with the curved cursor the glide to the from-square runs DURING the pause (if it takes longer than the
      // pause, no extra wait is added). The position is re-checked after both, before anything is clicked; if it changed
      // the cursor simply stays where it is.
      let pts = null;
      if (hum() && cfg.mouseMove) {
        [pts] = await Promise.all([aimMove(uci), wait ? sleep(wait) : null]);
      } else if (wait) await sleep(wait);
      if (token !== playToken || !cfg.enabled) return;
      if (topUp) {
        // never waits long: the top-up search ends with the pause (hitSoftMs = pause - margin - time spent)
        const fin = await Promise.race([finalP, sleep(Math.max(150, (topUp.ms || 0) + 300))]);
        if (token !== playToken || !cfg.enabled) return;
        if (fin && fin.uci && fin.uci !== uci && byUci(fin.uci)) {
          log('ponder hit deepened: depth', fin.before, '->', fin.depth, ', move', uci, '->', fin.uci);
          uci = fin.uci; sacrifice = !!fin.sacrifice;
          if (pts) pts = await aimMove(uci);               // the cursor was aimed at the provisional move: re-aim
          if (token !== playToken || !cfg.enabled) return;
        } else if (fin) log('ponder hit top-up: depth', fin.before, '->', fin.depth, fin.used ? '(same move)' : '(prepared reply kept)');
        earlyPonder();
      }

      const now = buildFen();
      if (!now || now.fen !== pos.fen) { log('position changed, discarding', uci); return; }
      log('playing', uci, category ? '[quick: ' + category + ']' : '', 'for', pos.fen);
      setStatus('playing ' + uci + (category ? ' \u00b7 quick ' + category : '') + (sacrifice ? ' \u00b7 sacrifice!' : '') + (ponderHit ? ' \u00b7 ponder hit' : '') +
        (dragDisabled && cfg.inputMode !== 'click' ? ' \u00b7 click fallback' : ''), 'on');

      const mv = byUci(uci);
      ownMove = { afterCount: pos.count - (mv && mv.capture ? 1 : 0) };
      // remember what is being played; it counts only if the board then shows exactly this move from this position
      rec.noteBotMove({ fen: pos.fen, uci, color: pos.myColor, sacrifice, engine: cfg.engine, flagKnown: cfg.engine === 'aggro' && category !== 'only' });
      if (pts) await finishMove(pts, uci, pos.myColor);
      else await executeMove(uci, pos.myColor);
    } catch (e) {
      setStatus('error: ' + (e && e.message ? e.message : e), 'err');
      console.error('[ChessVision]', e);
    } finally {
      if (token === playToken) {
        busy = false;
        if (recheckPending) { recheckPending = false; schedule(150); }   // something changed while we were busy
      }
    }
    if (token !== playToken) return;
    // If the move didn't register, retry a few times
    retryWaiting = true;
    setTimeout(() => {
      retryWaiting = false;
      if (token !== playToken || busy) return;
      const now = buildFen();
      if (cfg.enabled && isAllowedPage() && now && now.fen === pos.fen) {
        if (lastMode === 'drag' && !dragDisabled) {
          dragDisabled = true;                          // the drag didn't register: use clicks from now on
          log('drag did not register, falling back to click');
        }
        if (attempts < ATTEMPTS_MAX) { attempts++; lastHandledKey = null; schedule(0); }
        else setStatus('move not registering \u2013 check the board', 'warn');
      }
    }, RETRY_AFTER_MS);
  }

  // opt (2.0.4): { forced } = the watchdog's forced check (CV.WATCHDOG_FORCE_MS); { read } = a readBoard() result taken
  // just before (A2: the stable read's second read), used instead of reading the board again.
  function check(reason, opt) {
    const forced = !!(opt && opt.forced);
    const read = opt && opt.read && CV.STABLE_READ_REUSE ? opt.read : undefined;
    let obs;
    if (board && allowed !== null && isAllowedPage()) {          // observe before anything can return early
      try { obs = observeBoard(read) || undefined; } catch (e) { console.error('[ChessVision] observe failed', e); }
    }
    if (CV.WATCHDOG_SKIP_UNCHANGED) { lastCheckAt = Date.now(); lastCheckSig = obs ? obs.sig : read ? read.sig : boardSignature(); }   // A1: what the next watchdog ticks compare with
    if (!cfg.enabled) { setStatus('off'); return; }
    if (allowed === null) { setStatus('loading page list\u2026'); return; }
    if (!isAllowedPage()) { setStatus('paused \u2013 this page is not in allowed-pages.txt', 'warn'); return; }
    maybeWarm();                                                 // 2.0.4 (B1): the engine starts before it is needed
    if (busy) {
      if (Date.now() - busySince > BUSY_TIMEOUT_MS) {
        log('busy for too long, abandoning the attempt');
        playToken++; busy = false;                      // late results from the old attempt are ignored
      } else { recheckPending = true; return; }         // don't lose the update, look again once free
    }
    const pos = buildFen(obs);                                   // the observation above: no second board read
    if (!pos) { setStatus('no board found', 'warn'); return; }
    const over = gameOverFor(pos, forced);
    if (over) {
      attempts = 0;
      setStatus((over === 'game over' ? '' : 'game over: ') + over + (over === 'checkmate' ? (pos.turn === pos.myColor ? ' \u2013 you lost' : ' \u2013 you won') : ''), 'warn');
      onGameOver(over, pos);
      return;
    }
    refreshMeta(pos);
    if (pos.turn !== pos.myColor) {
      attempts = 0;
      idleWork(pos);
      setStatus(wfoText(), 'on');
      wfoShown = true;
      return;
    }
    if (pos.fen === lastHandledKey) return;
    log('check (' + reason + ') -> our move');
    play(pos);
  }

  // ---------- Background port and engine start (2.0.4) ----------
  // One runtime port per tab: while a chess.com tab holds one, the background never shuts the engines down (B1), and it
  // reconnects when the background page was reloaded. `warm` starts the engine before the first move needs it: sent when
  // Auto-play is on on an allowed page, and again after the engine setting changed or the port was lost.
  let port = null, portRetries = 0, warmedFor = null;
  function connectPort() {
    if (port) return;
    let p;
    try { p = api.runtime.connect({ name: 'chessvision' }); } catch (e) { return; }   // no connect (old browser) or the extension is gone
    if (!p) return;
    port = p;
    p.onMessage.addListener(onPortMessage);
    const since = Date.now();
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      warmedFor = null;
      if (Date.now() - since > 10000) portRetries = 0;
      if (++portRetries <= 5) setTimeout(connectPort, 1000 * portRetries);
    });
  }
  // 2.0.4 (A4): the ponder status of this tab's idle job, pushed by the background when it changes (see idleWork)
  function onPortMessage(m) {
    if (!m || m.type !== 'idleStatus' || !idleKey || m.key !== idleKey) return;
    idlePondering = !!m.pondering; idleFound = m.found || 0;
    if (ui) ui.setEval(m.evalLine || '');
    if (wfoShown) { setStatus(wfoText(), 'on'); wfoShown = true; }
  }
  function maybeWarm() {
    if (!CV.LAZY_ENGINES || !cfg.enabled || !isAllowedPage() || warmedFor === cfg.engine) return;
    const engine = cfg.engine;
    warmedFor = engine;
    api.runtime.sendMessage({ type: 'warm', engine }).then((r) => { if (r && r.ok === false && warmedFor === engine) warmedFor = null; }, () => { if (warmedFor === engine) warmedFor = null; });
  }

  // ---------- Idle work (opponent's turn): pondering / evaluation line ----------
  // The waiting status, short so the ponder state fits in the collapsed header.
  const wfoText = () => 'WFO' + (idlePondering ? ' \u00b7 pondering' : idleFound ? ' \u00b7 pondered' : '') + (idleFound ? ' ' + idleFound : '');
  // Is idle work wanted for the current engine and settings? (idleWork and the early ponder in play() use the same rule)
  function idleWanted() { return sfPonderOn() || (cfg.engine === 'aggro' && (cfg.aggroPonder || cfg.aggroShowEval)); }

  // Starts the background idle job for the position startFen + moves (the opponent to move there). The idle key is the
  // HISTORY key, not the FEN: play() starts the job for the position after our move before the board shows it (early
  // ponder, 2.0.0), and idleWork() later recognises the same position by the same key and only polls.
  function startIdle(startFen, moves, myColor) {
    idleKey = CV.ponderKey(startFen, moves); idlePondering = false; idleFound = 0; if (ui) ui.setEval('');
    api.runtime.sendMessage(sfPonderOn()
      ? { type: 'aggroIdle', engine: 'stockfish', startFen, moves, ponder: true, ponderMs: cfg.sfPonderMs, ponderWorkers: cfg.sfPonderWorkers, ponderHashMb: cfg.sfPonderHashMb, depth: cfg.depth, myColor,
        ponderUntilMove: cfg.ponderUntilMove, ponderMaxMs: cfg.ponderMaxMs, sfSearchMode: cfg.sfSearchMode }
      : { type: 'aggroIdle', startFen, moves, ponder: cfg.aggroPonder, showEval: cfg.aggroShowEval, ponderMs: cfg.aggroPonderMs, ponderWorkers: cfg.aggroPonderWorkers, ponderHashMb: cfg.aggroPonderHashMb, myColor,
        ponderUntilMove: cfg.ponderUntilMove, ponderMaxMs: cfg.ponderMaxMs }).catch(() => {});
  }

  function idleWork(pos) {
    if (!idleWanted()) return;
    const h = histFor(pos);
    if (!h) return;
    const key = CV.ponderKey(h.startFen, h.moves);
    if (idleKey !== key) {                                       // start once per position (unless the early ponder already did)
      startIdle(h.startFen, h.moves, pos.myColor);
    } else if (!(CV.IDLE_STATUS_PUSH && port)) {                 // then poll (the watchdog ticks drive this); 2.0.4: pushed on the port instead
      api.runtime.sendMessage({ type: 'aggroIdleStatus' }).then((r) => {
        if (idleKey !== key || !r) return;
        idlePondering = !!r.pondering; idleFound = r.found || 0;
        if (ui) ui.setEval(r.evalLine || '');
      }).catch(() => {});
    }
  }

  // ---------- Game recording / saving ----------
  function refreshMeta(pos) {
    if (Date.now() - metaAt < 5000) return;
    metaAt = Date.now();
    const names = readNames();
    rec.setMeta(names ? { myColor: pos.myColor, names } : { myColor: pos.myColor });
  }

  // 2.0.4 (C2): the background stores the game (one key per game + an index, one save at a time for every tab; see
  // saveGame in background.js). 2.0.3 rewrote the whole savedGames list from here, serialised per tab only.
  function storeGame(record) {
    saveChain = saveChain.then(async () => {
      const r = await api.runtime.sendMessage({ type: 'saveGame', record, max: cfg.maxSavedGames });
      if (!r || !r.ok) throw new Error((r && r.error) || 'no answer');
      log('saved game', record.id, record.result, 'sacrifices', record.sacrifices);
    }).catch((e) => console.error('[ChessVision] could not save the game', e));
    return saveChain;
  }

  // Once per game (rec.end guards against the watchdog re-checking).
  function onGameOver(over, pos) {
    const result = over === 'checkmate' ? (pos.turn === 'w' ? '0-1' : '1-0') : over === 'stalemate' ? '1/2-1/2' : '*';
    const game = rec.end(result);
    if (!game) return;
    const names = readNames() || game.meta.names;
    const save = (brilliants) => {
      const record = rec.build(game, { cfg, result, myColor: pos.myColor, names, brilliants });
      if (CV.pgn.shouldSave(cfg, record)) storeGame(record);
    };
    if (!cfg.countBrilliants) { save(null); return; }
    // runs in the background of the normal flow: nothing waits for it
    setTimeout(async () => {
      let found = null;
      try {
        found = await Promise.race([
          CV.brilliant.lookupAsync(document, pos.myColor, (m) => log('brilliant:', m), getIconPixels),
          new Promise((resolve) => setTimeout(() => resolve(null), 8000)),   // the save never waits longer than this
        ]);
      } catch (e) { log('brilliant lookup failed', e); }
      save(found && found.found ? { mine: found.mine, opp: found.opp } : null);
    }, cfg.brilliantWaitSec * 1000);
  }

  // RGBA pixels (64x64) of an icon: the background page downloads it, so the canvas is never tainted. null on any problem.
  async function getIconPixels(url) {
    const abs = new URL(url, location.href).href;
    const r = await api.runtime.sendMessage({ type: 'fetchImage', url: abs });
    if (!r || !r.ok) return null;
    const blob = new Blob([r.bytes], { type: r.type || 'image/png' });
    let src, objectUrl = null;
    try { src = await createImageBitmap(blob); } catch (e) {            // SVG blobs: through an <img> instead
      objectUrl = URL.createObjectURL(blob);
      src = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = objectUrl; });
    }
    try {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, 0, 0, 64, 64);
      return g.getImageData(0, 0, 64, 64).data;
    } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
  }

  async function saveCurrentNow() {
    const game = rec.current();
    if (!game || !rec.hasMoves()) return 'No moves recorded yet';
    const myColor = game.meta.myColor || (board && board.classList.contains('flipped') ? 'b' : 'w');
    const record = rec.build(game, { cfg, result: game.result || '*', myColor, names: readNames() || game.meta.names });
    await storeGame(record);
    return 'Saved current game (' + record.plies + ' moves' + (record.reconstructed ? ', ' + record.reconstructed + ' reconstructed' : '') + (record.incomplete ? ', incomplete' : '') + ')';
  }

  function schedule(ms, reason = 'event') {
    clearTimeout(debounceTimer);
    stableSeq++;                                                 // a stable check still waiting for its second read is outdated
    stableArmed = false;                                         // ... and this direct check replaces it
    debounceTimer = setTimeout(() => check(reason), ms);
  }

  // Board mutations (2.0.0): a short debounce, then a STABLE READ: the board is read twice, one animation frame + 20 ms
  // apart, and check() only runs when both reads agree. The tracker treats "more pieces than before" as a new game, so a
  // read taken while chess.com is half-way through an update (piece removed, not re-added yet) followed by a full read
  // could clear the hash and restart the recorder; the second read rules that out. A short debounce alone would not.
  // boardDebounceMs 250 = the 1.8.0 timing (the stability check stays).
  const nextFrame = () => new Promise((r) => {                   // rAF does not fire in a hidden tab: a timeout backs it up
    let done = false; const go = () => { if (!done) { done = true; r(); } };
    try { requestAnimationFrame(go); } catch (e) { /* no rAF */ }
    setTimeout(go, 100);
  });
  function scheduleStable(ms, reason, forced) {
    clearTimeout(debounceTimer);
    const seq = ++stableSeq;
    stableArmed = true;
    debounceTimer = setTimeout(async () => {
      const a = boardSignature();
      await nextFrame();
      await sleep(STABLE_GAP_MS);
      if (seq !== stableSeq) return;                             // a newer mutation (or schedule) took over
      const rb = readBoard(), b = rb ? rb.sig : '';
      if (a === b || unstableRun >= UNSTABLE_MAX) { unstableRun = 0; stableArmed = false; check(reason, { forced, read: rb }); return; }
      unstableReads++; unstableRun++;
      scheduleStable(cfg.boardDebounceMs, 'unstable', forced);
    }, ms);
  }

  // Watchdog: re-reads the board on a timer, independent of any DOM event.
  // check() is idempotent, so this is cheap and recovers from any missed mutation.
  // 2.0.2 (C4): the watchdog uses the stable read too (two reads a frame + 20 ms apart must agree): a tick that landed
  // in the middle of a board update made of two DOM steps fed the tracker a half-updated board (a gap, then a ponder
  // miss). When a stable read is already scheduled or running, the tick has nothing to add. CV.WATCHDOG_STABLE_READ =
  // false: the 2.0.0 direct read.
  // 2.0.4 (A1): a tick reads the board ONCE. Same signature as the board the last check() used, and nothing pending (no
  // move in progress, no re-check, no move-confirmation timer): the tick ends there. A changed board gets the stable read
  // as before. Every CV.WATCHDOG_FORCE_MS without a check a full check runs anyway (a result popup or an SPA navigation
  // changes nothing on the board); when the board is unchanged it needs no stable read (it equals the last checked board).
  function startWatchdog() {
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(watchdogTick, cfg.watchdogMs);
  }
  function watchdogTick() {
    if (!CV.WATCHDOG_STABLE_READ) { check('watchdog', { forced: true }); return; }
    if (stableArmed) return;
    if (!CV.WATCHDOG_SKIP_UNCHANGED) { scheduleStable(0, 'watchdog'); return; }
    const forced = Date.now() - lastCheckAt >= CV.WATCHDOG_FORCE_MS;
    const read = readBoard(), same = (read ? read.sig : '') === lastCheckSig;
    if (same && !forced && !busy && !recheckPending && !retryWaiting) return;
    if (same && forced && !busy) { check('watchdog (forced)', { forced: true, read }); return; }
    scheduleStable(0, forced ? 'watchdog (forced)' : 'watchdog', forced);
  }

  // The 1-second re-attach timer. 2.0.4 (A1): while the board it is attached to is still in the page, the document is
  // searched only every CV.ATTACH_FULL_EVERY ticks (chess.com could put a new board in beside it); a board that left the
  // page is replaced at the next tick. CV.ATTACH_LAZY = false: every tick (2.0.3).
  function attachTick() {
    if (CV.ATTACH_LAZY && board && observer && board.isConnected && ++attachSkips < CV.ATTACH_FULL_EVERY) return;
    attachSkips = 0;
    attach();
  }

  function attach() {
    const b = findBoard();
    if (b === board && observer) return;
    if (observer) observer.disconnect();
    board = b;
    observer = null;
    if (!b) return;
    // 2.0.4 (A3): only mutations that can change a board read schedule one (BS.mutationRelevant: pieces, highlights, the
    // board's own class); hover squares, arrows, drag ghosts and the reaction to our cursor glide do not. The watchdog
    // stays the safety net for anything the filter misses. CV.MUTATION_FILTER = false: every mutation (2.0.3).
    const filter = !!CV.MUTATION_FILTER;
    observer = new MutationObserver((records) => {
      if (filter && !BS.mutationRelevant(records, b)) { filteredMutations++; return; }
      scheduleStable(cfg.boardDebounceMs, 'mutation');
    });
    observer.observe(b, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['class'], attributeOldValue: filter,
    });
    log('board attached');
    setStatus(cfg.enabled ? 'board found' : 'off');
    schedule(300, 'attach');
  }

  // ---------- Settings ----------
  function applyCfg(next, fromStorage) {
    const prevWatchdog = cfg.watchdogMs, prevInput = cfg.inputMode + cfg.humanize, prevCfg = cfg;
    cfg = CV.fixRanges({ ...cfg, ...CV.sanitize(next) });
    if (CV.ponderCfgChange(prevCfg, cfg)) {                     // engine switched away / ponder or evaluation turned off
      idleKey = null; idlePondering = false; idleFound = 0; if (ui) ui.setEval('');
      api.runtime.sendMessage({ type: 'aggroInvalidate' }).catch(() => {});
    }
    if (cfg.inputMode + cfg.humanize !== prevInput) dragDisabled = false;
    if (cfg.engine !== prevCfg.engine && allowed !== null) maybeWarm();   // 2.0.4 (B1): the other engine, before its first move
    if (ui) ui.render(cfg);
    if (cfg.watchdogMs !== prevWatchdog || !watchdogTimer) startWatchdog();
    if (!cfg.enabled) setStatus('off');
    else if (next.enabled !== undefined || fromStorage) { lastHandledKey = null; schedule(100, 'settings'); }
  }

  function cleanPatch(patch) {
    const clean = CV.fixRanges({ ...cfg, ...CV.sanitize(patch) });
    const out = {};
    for (const k of Object.keys(patch)) if (k in clean) out[k] = clean[k];
    // range fixes may have moved the partner value too
    for (const k of ['minDelay', 'maxDelay', 'quickMinDelay', 'quickMaxDelay']) if (clean[k] !== cfg[k]) out[k] = clean[k];
    return out;
  }
  function onUiChange(patch) {
    const out = cleanPatch(patch);
    applyCfg(out, false);
    api.storage.local.set(out);
  }
  // 2.0.4 (C1): a slider being dragged: this tab follows at once, the value is stored once on release (onUiChange).
  function onUiPreview(patch) { applyCfg(cleanPatch(patch), false); }

  // Text for "Copy debug info": state only, no page content, no account data.
  async function debugInfo() {
    const info = {
      chessvision: VERSION, time: new Date().toISOString(), userAgent: navigator.userAgent,
      page: location.hostname + location.pathname,
      allowedPage: isAllowedPage(), allowedEntries: allowed ? allowed.length : null,
      settings: cfg,
      state: { busy, busyForMs: busy ? Date.now() - busySince : 0, attempts, dragDisabled, lastMode, atStart, ownMove, watchdogTimerRunning: !!watchdogTimer, unstableReads, filteredMutations },
      history: (() => { const i = tracker.info(); return { length: i.plies, halfmove: i.halfmove, fullmove: i.fullmove, repetitionCount: i.repetitionCount, historyResets: i.resets, startFen: i.startFen }; })(),
      recording: { positionsSeen: rec.plyCount() },
      clock: { lastClock, myClockNow: board ? readMyClock(board.classList.contains('flipped') ? 'b' : 'w') : null },
      idle: { idleKey: !!idleKey, pondering: idlePondering },
      background: null,
      board: null,
    };
    try { info.background = await api.runtime.sendMessage({ type: 'aggroDebug' }); } catch (e) { info.background = String(e && e.message || e); }
    try {
      if (board) {
        const r = board.getBoundingClientRect(), p = readPosition(), pos = buildFen();
        info.board = {
          tag: board.tagName.toLowerCase(), size: Math.round(r.width) + 'x' + Math.round(r.height),
          flipped: board.classList.contains('flipped'), pieces: p.count, highlights: p.highlights.length,
          fen: pos && pos.fen, turn: pos && pos.turn, myColor: pos && pos.myColor, lastTo: pos && pos.lastTo,
          gameState: pos ? CV.chess.gameState(CV.chess.parseFen(pos.fen)) : null,
        };
      }
    } catch (e) { info.boardError = String(e && e.message || e); }
    return JSON.stringify(info, null, 2);
  }

  function importFromText(text) {
    const r = CV.importSettings(text);
    if (!r.ok) return { ok: false, message: 'Import failed: ' + r.error };
    onUiChange(r.values);
    return { ok: true, message: 'Imported ' + r.count + ' settings (Auto-play unchanged)' };
  }

  ui = CV.createOverlay({
    version: VERSION,
    onChange: onUiChange,
    onPreview: onUiPreview,
    onExport: () => CV.exportSettings(cfg),
    onImport: importFromText,
    onDebug: debugInfo,
    onClearEngines: () => api.runtime.sendMessage({ type: 'clearEngines' }).catch(() => {}),
    onSaveNow: () => saveCurrentNow().catch((e) => 'Could not save: ' + (e && e.message || e)),
    onListGames: async () => { const g = await api.runtime.sendMessage({ type: 'listGames' }); return Array.isArray(g) ? g : []; },
    onClearGames: () => api.runtime.sendMessage({ type: 'clearGames' }),
    onReset() {
      const keep = { overlayOpen: cfg.overlayOpen, overlayX: cfg.overlayX, overlayY: cfg.overlayY };
      const fresh = { ...CV.DEFAULTS, ...keep };
      applyCfg(fresh, false);
      api.storage.local.set(fresh);
    },
  });
  ui.render(cfg);
  setStatus('starting\u2026');

  api.storage.local.get(CV.DEFAULTS).then((v) => {
    applyCfg(v, true);
    setStatus(cfg.enabled ? 'on' : 'off');
  });
  document.addEventListener('visibilitychange', () => {          // a hidden tab: stop idle work
    if (document.hidden && (cfg.engine === 'aggro' || cfg.sfPonder)) { idleKey = null; idlePondering = false; idleFound = 0; api.runtime.sendMessage({ type: 'aggroInvalidate' }).catch(() => {}); }
  });
  api.storage.onChanged.addListener((changes) => {
    // 2.0.4 (C2): saved games are 'game:<id>' keys + 'savedGameIds' (and the old 'savedGames' during the migration); the
    // list is re-read only while "Game saving" is open (else when it is next opened)
    const keys = Object.keys(changes);
    if (keys.some(CV.isSavedGameKey) && ui) ui.gamesChanged();
    if (keys.every(CV.isSavedGameKey)) return;
    const next = {};
    for (const k in changes) next[k] = changes[k].newValue;
    // 2.0.4 (C1): the echo of this tab's own write (every value already equals cfg): nothing to apply or re-render
    if (CV.SETTINGS_FEWER_WRITES) { const clean = CV.sanitize(next); if (Object.keys(clean).every((k) => clean[k] === cfg[k])) return; }
    applyCfg(next, false);
    if (next.enabled !== undefined) setStatus(cfg.enabled ? 'on' : 'off');
  });

  connectPort();
  setInterval(attachTick, 1000); // re-attach if chess.com swaps the board element
  startWatchdog();
  attach();
})();
