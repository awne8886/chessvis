(() => {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const CV = window.CV;
  if (!CV || window.__chessvisionLoaded) return;
  window.__chessvisionLoaded = true;

  const DEBUG = true;
  const FALLBACK_VERSION = '1.8.0';
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

  let cfg = { ...CV.DEFAULTS };
  let board = null, observer = null, debounceTimer = null, watchdogTimer = null;
  let busy = false, busySince = 0, playToken = 0, recheckPending = false;
  let lastHandledKey = null, attempts = 0;
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------- Status ----------
  function setStatus(text, tone) {
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
  function gameOverFor(pos) {
    if (!overCache || overCache.fen !== pos.fen) {
      overCache = { fen: pos.fen, value: CV.chess.gameState(CV.chess.parseFen(pos.fen)) };
    }
    if (overCache.value) return overCache.value;
    const modal = document.querySelector('.game-over-modal-container, [class*="game-over-modal"]');
    return modal && modal.getClientRects().length ? 'game over' : null;
  }

  function readBoardState() {
    if (!board) return null;
    const { grid, count, highlights } = readPosition();
    return count ? { grid, count, highlights } : null;
  }

  // Reads the board and feeds the tracker. Only ever called on allowed pages, on every board read
  // (also while Auto-play is off), so moves made by hand or while paused are recorded too.
  function observeBoard() {
    const st = readBoardState();
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
    return { st, p };
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

  function buildFen() {
    if (!board) return null;
    const obs = isAllowedPage() ? observeBoard() : null;
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

  // startFen + moves for an engine, only when the tracked history ends exactly at this position; else null.
  function histFor(pos) {
    if (!tracker.matches(pos.fen)) return null;
    const i = tracker.info();
    return { startFen: i.startFen, moves: i.moves };
  }

  // ---------- Input: pointer events ----------
  function squareCenter(file, rank) {
    const rect = board.getBoundingClientRect();
    const s = rect.width / 8;
    const flipped = board.classList.contains('flipped');
    const x = flipped ? (8 - file + 0.5) * s : (file - 0.5) * s;
    const y = flipped ? (rank - 0.5) * s : (8 - rank + 0.5) * s;
    return [rect.left + x, rect.top + y];
  }

  // Click target inside a square; off-centre (centre-weighted) when "Off-centre clicks" is on.
  function squarePoint(file, rank) {
    const [cx, cy] = squareCenter(file, rank);
    if (!(hum() && cfg.clickOffset)) return { x: cx, y: cy };
    const s = board.getBoundingClientRect().width / 8;
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
  const targetAt = (x, y) => {
    const host = ui && ui.host;
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
  async function glideTo(x, y, buttons = 0, linearSteps) {
    if (!(hum() && cfg.mouseMove) && !linearSteps) { mouse = { x, y }; return; }
    if (mouse.x === null) {
      const r = board.getBoundingClientRect();
      mouse = { x: Math.min(innerWidth - 5, Math.max(5, r.left + rand(0.1, 0.9) * r.width)), y: Math.min(innerHeight - 5, r.bottom + rand(20, 120)) };
    }
    const smooth = hum() && cfg.mouseMove;
    const path = CV.human.buildPath(mouse.x, mouse.y, x, y, smooth ? { speed: fast ? 2.2 : 1 } : { linear: true, steps: linearSteps });
    for (const p of path) { moveTo(p.x, p.y, buttons); await sleep(p.dt); }
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

  async function clickAt(x, y) {
    await glideTo(x, y);
    await pressAt(x, y);
    await sleep(hum() ? (fast ? rand(25, 60) : rand(35, 95)) : 15);
    await releaseAt(x, y, true);
    await sleep(hum() ? 0 : 15);
  }

  async function dragFromTo(a, b) {
    await glideTo(a.x, a.y);
    await pressAt(a.x, a.y);
    await sleep(fast ? rand(30, 70) : rand(60, 130));
    await glideTo(b.x, b.y, 1, 6);
    await sleep(rand(20, 60));
    await releaseAt(b.x, b.y, false);
  }

  async function executeMove(uci, color) {
    const f1 = FILES.indexOf(uci[0]) + 1, r1 = +uci[1];
    const f2 = FILES.indexOf(uci[2]) + 1, r2 = +uci[3];
    const from = squarePoint(f1, r1), to = squarePoint(f2, r2);
    let mode = CV.human.pickInput(cfg);
    if (mode === 'drag' && dragDisabled) mode = 'click';   // drag did not register earlier
    lastMode = mode;
    log('input method:', mode);

    if (mode === 'drag') {
      await dragFromTo(from, to);
    } else {
      await clickAt(from.x, from.y);
      await sleep(hum() ? (fast ? rand(50, 130) : rand(110, 340)) : rand(80, 160));
      await clickAt(to.x, to.y);
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

  // ---------- Engine ----------
  // CANDIDATE selectors for chess.com's clocks / player names. Untested against the real site; each reader
  // returns null when nothing matches or parses and never throws.
  const CLOCK_SELECTORS = ['.clock-bottom', '.clock-top', '[class*="clock"]'];
  const INCREMENT_SELECTORS = ['[class*="increment"]', '[class*="time-control"]'];
  const NAME_SELECTORS = ['.player-component .user-username-component', '[data-test-element="user-tagline-username"]', '.user-tagline-username', '[class*="user-username"]'];
  const clsOf = (el) => String((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '').toLowerCase();

  // My clock in ms (+ increment if the page shows one), or null.
  function readMyClock(myColor) {
    try {
      const seen = new Set(), cands = [];
      for (const sel of CLOCK_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const ms = CV.clock.parseClock(el.textContent);
          if (ms !== null) cands.push({ ms, cls: clsOf(el) });
        }
      }
      const mine = myColor === 'w' ? 'white' : 'black', other = myColor === 'w' ? 'black' : 'white';
      // my colour's clock first (works with a flipped board), else the clock at the bottom, which is mine
      const pick = cands.find((c) => c.cls.includes('clock-' + mine)) ||
                   cands.find((c) => c.cls.includes(mine) && !c.cls.includes(other)) ||
                   cands.find((c) => /(^|[\s-])bottom($|[\s-])/.test(c.cls));
      if (!pick) return null;
      let inc = 0;
      for (const sel of INCREMENT_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) { inc = CV.clock.parseIncrement(el.textContent); if (inc) break; }
        if (inc) break;
      }
      return { ms: pick.ms, inc };
    } catch (e) { return null; }
  }

  // { me, opp } player names (top name = opponent, bottom = me), or null.
  function readNames() {
    try {
      const found = [], seen = new Set();
      for (const sel of NAME_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.textContent || '').trim();
          if (!t || t.length > 40 || seen.has(t)) continue;
          seen.add(t);
          found.push({ t, top: el.getBoundingClientRect().top });
        }
      }
      if (found.length < 2) return null;
      found.sort((x, y) => x.top - y.top);
      return { opp: found[0].t, me: found[found.length - 1].t };
    } catch (e) { return null; }
  }

  // Stockfish pondering is off while Imperfection is above 0: a prepared reply is always the best line, the imperfection choice would be skipped.
  function sfPonderOn() { return cfg.engine === 'stockfish' && cfg.sfPonder && !(hum() && cfg.imperfection > 0); }

  function askEngine(pos, quick) {
    const depth = quick ? Math.min(cfg.depth, 8) : cfg.depth;
    const ms = quick ? Math.min(cfg.thinkMs, cfg.quickThinkMs) : cfg.thinkMs;
    const h = histFor(pos);
    let soft, hard;
    lastClock = null;
    if (!quick && cfg.engine === 'aggro' && cfg.aggroUseClock) {     // the quick-reply path keeps its small budget
      const clk = readMyClock(pos.myColor);
      const budget = clk && CV.clock.clockBudget({ remainingMs: clk.ms, incrementMs: clk.inc, thinkMs: cfg.thinkMs });
      if (budget) { soft = budget.soft; hard = budget.hard; lastClock = { ms: clk.ms, mode: budget.mode, soft, hard }; log('clock', clk.ms, 'ms ->', budget); }
    }
    let sfCap = !quick && cfg.engine === 'stockfish' ? cfg.sfMaxMs : 0;      // time cap only for the full search; quick looks stay depth <= 8
    if (!quick && cfg.engine === 'stockfish' && cfg.sfUseClock) {            // optional: never more than the clock allows (clock.js: <= a quarter of what is left)
      const clk = readMyClock(pos.myColor);
      const budget = clk && CV.clock.clockBudget({ remainingMs: clk.ms, incrementMs: clk.inc, thinkMs: cfg.sfMaxMs > 0 ? cfg.sfMaxMs : 5000 });
      if (budget) { sfCap = CV.sfSearchCap(cfg.sfMaxMs, budget.soft); lastClock = { ms: clk.ms, mode: budget.mode, soft: budget.soft, hard: budget.hard }; log('clock', clk.ms, 'ms -> sf cap', sfCap); }
    }
    return api.runtime.sendMessage({
      type: 'analyze', fen: pos.fen, engine: cfg.engine, depth, ms,
      startFen: h ? h.startFen : null, moves: h ? h.moves : null,       // null = no reliable history: engines get the bare FEN
      soft, hard, verify: cfg.engine === 'aggro' && cfg.aggroVerify, ponder: sfPonderOn() || (cfg.engine === 'aggro' && cfg.aggroPonder), sfThreads: cfg.engine === 'stockfish' ? cfg.sfThreads : undefined,
      imperfection: !quick && cfg.engine === 'stockfish' && hum() ? cfg.imperfection : 0,
      sfMaxMs: sfCap,
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

      let uci = null, category = null, sacrifice = false, ponderHit = false;

      if (cfg.quickReplies && cfg.quickOnlyMove && legal.length === 1) {
        uci = legal[0].uci; category = 'only';            // forced: no need to ask the engine
      } else {
        const likely = CV.human.likelyObvious(parsed, legal, ctx, cfg);
        setStatus(likely ? 'quick look (' + engineName + ')\u2026' : 'thinking (' + engineName + ')\u2026', 'on');
        let res = await askEngine(pos, likely);
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
            res = await askEngine(pos, false);
            if (token !== playToken || !cfg.enabled) return;
          }
        } else if (res && res.imperfect && res.best) {
          // an imperfect pick must never replace an obvious best move
          if (CV.human.classify(parsed, byUci(res.best), ctx, cfg, legal.length)) res = { ...res, uci: res.best };
        }
        uci = res && res.uci;
        sacrifice = !!(res && res.sacrifice);
        ponderHit = !!(res && res.ponderHit);
        if (res && res.imperfect && uci !== res.best) log('imperfection: played', uci, 'instead of', res.best);
      }

      if (!uci || uci === '(none)') {
        setStatus('no move returned', 'warn'); log('no move', uci);
        lastHandledKey = null;                              // let the watchdog try again, a few times
        if (attempts++ < ATTEMPTS_MAX) schedule(500, 'no-move retry');
        return;
      }

      // Human-like pause. The engine already ran, so only the remainder is waited.
      let delay = CV.human.delayFor(cfg, { legalCount: legal.length, category });
      if (lastClock) delay = CV.clock.delayCap(delay, lastClock.ms);          // the pause must not eat a short clock
      const wait = Math.max(0, delay - (Date.now() - t0));
      if (wait) await sleep(wait);
      if (token !== playToken || !cfg.enabled) return;

      const now = buildFen();
      if (!now || now.fen !== pos.fen) { log('position changed, discarding', uci); return; }
      log('playing', uci, category ? '[quick: ' + category + ']' : '', 'for', pos.fen);
      setStatus('playing ' + uci + (category ? ' \u00b7 quick ' + category : '') + (sacrifice ? ' \u00b7 sacrifice!' : '') + (ponderHit ? ' \u00b7 ponder hit' : '') +
        (dragDisabled && cfg.inputMode !== 'click' ? ' \u00b7 click fallback' : ''), 'on');

      const mv = byUci(uci);
      ownMove = { afterCount: pos.count - (mv && mv.capture ? 1 : 0) };
      fast = !!category || !!(lastClock && lastClock.mode === 'low');     // low on time: the faster hand too
      // remember what is being played; it counts only if the board then shows exactly this move from this position
      rec.noteBotMove({ fen: pos.fen, uci, color: pos.myColor, sacrifice, engine: cfg.engine, flagKnown: cfg.engine === 'aggro' && category !== 'only' });
      await executeMove(uci, pos.myColor);
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
    setTimeout(() => {
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

  function check(reason) {
    if (board && allowed !== null && isAllowedPage()) {          // observe before anything can return early
      try { observeBoard(); } catch (e) { console.error('[ChessVision] observe failed', e); }
    }
    if (!cfg.enabled) { setStatus('off'); return; }
    if (allowed === null) { setStatus('loading page list\u2026'); return; }
    if (!isAllowedPage()) { setStatus('paused \u2013 this page is not in allowed-pages.txt', 'warn'); return; }
    if (busy) {
      if (Date.now() - busySince > BUSY_TIMEOUT_MS) {
        log('busy for too long, abandoning the attempt');
        playToken++; busy = false;                      // late results from the old attempt are ignored
      } else { recheckPending = true; return; }         // don't lose the update, look again once free
    }
    const pos = buildFen();
    if (!pos) { setStatus('no board found', 'warn'); return; }
    const over = gameOverFor(pos);
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
      setStatus('WFO' + (idlePondering ? ' \u00b7 pondering' : idleFound ? ' \u00b7 pondered' : '') + (idleFound ? ' ' + idleFound : ''), 'on');   // short: fits the collapsed header   // short, so the ponder state fits in the collapsed header
      return;
    }
    if (pos.fen === lastHandledKey) return;
    log('check (' + reason + ') -> our move');
    play(pos);
  }

  // ---------- AggroChess idle work (opponent's turn) ----------
  function idleWork(pos) {
    const sfIdle = sfPonderOn();
    if (!sfIdle && (cfg.engine !== 'aggro' || !(cfg.aggroPonder || cfg.aggroShowEval))) return;
    const h = histFor(pos);
    if (!h) return;
    if (idleKey !== pos.fen) {                                   // start once per position
      idleKey = pos.fen; idlePondering = false; idleFound = 0; if (ui) ui.setEval('');
      api.runtime.sendMessage(sfIdle
        ? { type: 'aggroIdle', engine: 'stockfish', startFen: h.startFen, moves: h.moves, ponder: true, ponderMs: cfg.sfPonderMs, ponderWorkers: cfg.sfPonderWorkers, ponderHashMb: cfg.sfPonderHashMb, depth: cfg.depth, myColor: pos.myColor }
        : { type: 'aggroIdle', startFen: h.startFen, moves: h.moves, ponder: cfg.aggroPonder, showEval: cfg.aggroShowEval, ponderMs: cfg.aggroPonderMs, ponderWorkers: cfg.aggroPonderWorkers, ponderHashMb: cfg.aggroPonderHashMb, myColor: pos.myColor }).catch(() => {});
    } else {                                                     // then poll (the watchdog ticks drive this)
      api.runtime.sendMessage({ type: 'aggroIdleStatus' }).then((r) => {
        if (idleKey !== pos.fen || !r) return;
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

  // Stored under savedGames, newest first; saves are serialised so two games ending together cannot overwrite each other.
  function storeGame(record) {
    saveChain = saveChain.then(async () => {
      const got = await api.storage.local.get({ savedGames: [] });
      const list = CV.pgn.mergeSaved(Array.isArray(got.savedGames) ? got.savedGames : [], record, { max: cfg.maxSavedGames });
      await api.storage.local.set({ savedGames: list });
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
    debounceTimer = setTimeout(() => check(reason), ms);
  }

  // Watchdog: re-reads the board on a timer, independent of any DOM event.
  // check() is idempotent, so this is cheap and recovers from any missed mutation.
  function startWatchdog() {
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => check('watchdog'), cfg.watchdogMs);
  }

  function attach() {
    const b = findBoard();
    if (b === board && observer) return;
    if (observer) observer.disconnect();
    board = b;
    observer = null;
    if (!b) return;
    observer = new MutationObserver(() => schedule(250, 'mutation'));
    observer.observe(b, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['class'],
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
    if (ui) ui.render(cfg);
    if (cfg.watchdogMs !== prevWatchdog || !watchdogTimer) startWatchdog();
    if (!cfg.enabled) setStatus('off');
    else if (next.enabled !== undefined || fromStorage) { lastHandledKey = null; schedule(100, 'settings'); }
  }

  function onUiChange(patch) {
    const clean = CV.fixRanges({ ...cfg, ...CV.sanitize(patch) });
    const out = {};
    for (const k of Object.keys(patch)) if (k in clean) out[k] = clean[k];
    // range fixes may have moved the partner value too
    for (const k of ['minDelay', 'maxDelay', 'quickMinDelay', 'quickMaxDelay']) if (clean[k] !== cfg[k]) out[k] = clean[k];
    applyCfg(out, false);
    api.storage.local.set(out);
  }

  // Text for "Copy debug info": state only, no page content, no account data.
  async function debugInfo() {
    const info = {
      chessvision: VERSION, time: new Date().toISOString(), userAgent: navigator.userAgent,
      page: location.hostname + location.pathname,
      allowedPage: isAllowedPage(), allowedEntries: allowed ? allowed.length : null,
      settings: cfg,
      state: { busy, busyForMs: busy ? Date.now() - busySince : 0, attempts, dragDisabled, lastMode, atStart, ownMove, watchdogTimerRunning: !!watchdogTimer },
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
    onExport: () => CV.exportSettings(cfg),
    onImport: importFromText,
    onDebug: debugInfo,
    onClearEngines: () => api.runtime.sendMessage({ type: 'clearEngines' }).catch(() => {}),
    onSaveNow: () => saveCurrentNow().catch((e) => 'Could not save: ' + (e && e.message || e)),
    onListGames: async () => { const g = await api.storage.local.get({ savedGames: [] }); return Array.isArray(g.savedGames) ? g.savedGames : []; },
    onClearGames: () => api.storage.local.set({ savedGames: [] }),
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
    if (changes.savedGames && ui) ui.refreshGames();
    if (Object.keys(changes).every((k) => k === 'savedGames')) return;
    const next = {};
    for (const k in changes) next[k] = changes[k].newValue;
    applyCfg(next, false);
    if (next.enabled !== undefined) setStatus(cfg.enabled ? 'on' : 'off');
  });

  setInterval(attach, 1000); // re-attach if chess.com swaps the board element
  startWatchdog();
  attach();
})();
