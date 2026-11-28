// On-page control panel (Shadow DOM so chess.com's CSS can't touch it).
// Collapsed: a one-line pill with status and on/off. Expanded: every setting.
(function (root) {
  'use strict';
  const CV = (root.CV = root.CV || {});

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: fixed; z-index: 2147483647; width: min(300px, calc(100vw - 16px));
  font: 12.5px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e4e8e3;
  background: #151a19; border: 1px solid #2c3532; border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,.45); user-select: none; -webkit-user-select: none; }
.head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: grab; touch-action: none; }
.head.dragging { cursor: grabbing; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #5d6a66; flex: none; }
.dot.on { background: #5ec4b0; } .dot.warn { background: #e3b341; } .dot.err { background: #e5604d; }
.title { font-weight: 650; letter-spacing: .01em; }
.status { color: #8d9a95; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
.chev { width: 26px; height: 26px; border-radius: 6px; color: #8d9a95; font-size: 14px; flex: none; }
.chev:hover { background: #222a28; color: #e4e8e3; }
.body { max-height: min(72vh, 560px); overflow-y: auto; padding: 2px 12px 12px; border-top: 1px solid #232b29; }
.collapsed .body { display: none; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 9px 0 0; }
.row > label, .row > .lab { color: #c7cfca; }
.val { color: #5ec4b0; font-variant-numeric: tabular-nums; min-width: 4.5ch; text-align: right; }
.sl { margin: 9px 0 0; } .sl .row { margin: 0 0 2px; }
input[type=range] { width: 100%; height: 18px; accent-color: #5ec4b0; margin: 0; background: transparent; }
.sw { position: relative; width: 34px; height: 20px; flex: none; }
.sw input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; width: 100%; height: 100%; }
.sw i { position: absolute; inset: 0; border-radius: 10px; background: #36413d; transition: background .15s; pointer-events: none; }
.sw i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: #e4e8e3; transition: transform .15s; }
.sw input:checked + i { background: #3f9d8c; } .sw input:checked + i::after { transform: translateX(14px); }
.sw input:focus-visible + i { outline: 2px solid #5ec4b0; outline-offset: 2px; }
.seg { display: flex; background: #1d2321; border-radius: 7px; padding: 2px; gap: 2px; }
.seg button { padding: 4px 9px; border-radius: 5px; color: #8d9a95; }
.seg.tight button { padding: 4px 6px; }
.seg button[aria-pressed=true] { background: #2f3a37; color: #e4e8e3; }
.seg button:focus-visible, .chev:focus-visible, .link:focus-visible { outline: 2px solid #5ec4b0; outline-offset: 1px; }
details { margin-top: 12px; border-top: 1px solid #232b29; padding-top: 2px; }
summary { list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 8px 0 0; cursor: pointer; font-weight: 600; }
summary::-webkit-details-marker { display: none; }
summary .arrow { color: #6c7a75; font-weight: 400; margin-right: 4px; display: inline-block; transition: transform .15s; }
details[open] summary .arrow { transform: rotate(90deg); }
.group.off { opacity: .45; pointer-events: none; }
.note { color: #7a8782; font-size: 11.5px; margin: 6px 0 0; }
.btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.btn { padding: 5px 10px; border-radius: 6px; background: #222a28; border: 1px solid #2f3a37; color: #d3dad5; }
.btn:hover { background: #2a3431; }
.btn:focus-visible { outline: 2px solid #5ec4b0; outline-offset: 1px; }
.importbox { display: none; margin-top: 8px; }
.importbox.open { display: block; }
.ta { width: 100%; background: #101514; color: #d3dad5; border: 1px solid #2f3a37; border-radius: 6px; padding: 6px;
  font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; user-select: text; -webkit-user-select: text; }
.importbox .btn { margin-top: 6px; }
.msg { color: #5ec4b0; font-size: 11.5px; margin: 8px 0 0; min-height: 1em; }
.evalline { color: #5ec4b0; font-size: 11.5px; margin: 6px 0 0; min-height: 1em; }
.warnline { color: #e3b341; }
.game { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.game .gi { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c7cfca; font-size: 11.5px; }
.btn.sm { padding: 2px 7px; font-size: 11.5px; }
.sub { color: #8d9a95; font-size: 11.5px; margin: 10px 0 0; }
.foot { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; color: #7a8782; font-size: 11.5px; }
.link { color: #8d9a95; text-decoration: underline; padding: 0; }
.link:hover { color: #e4e8e3; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const kid of kids) n.append(kid);
    return n;
  };

  // opts: { onChange(patch), onPreview(patch) (2.0.4: apply in this tab without storing), onReset(), ... }
  CV.createOverlay = function (opts) {
    const host = el('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(el('style', {}, CSS));
    const wrap = el('div', { class: 'wrap' });
    shadow.append(wrap);

    const sync = []; // functions (cfg) => void that refresh each control
    let cfg = { ...CV.DEFAULTS };

    // ---- control builders ----
    function toggle(key, label) {
      const input = el('input', { type: 'checkbox' });
      input.addEventListener('change', () => opts.onChange({ [key]: input.checked }));
      sync.push((c) => { input.checked = !!c[key]; });
      return el('div', { class: 'row' }, el('span', { class: 'lab' }, label), el('span', { class: 'sw' }, input, el('i')));
    }
    function seg(key, label, options, cls) {
      const btns = options.map(([v, t]) => {
        const b = el('button', { type: 'button' }, t);
        b.addEventListener('click', () => opts.onChange({ [key]: v }));
        b.dataset.v = v;
        return b;
      });
      sync.push((c) => btns.forEach((b) => b.setAttribute('aria-pressed', String(c[key] === b.dataset.v))));
      return el('div', { class: 'row' }, el('span', { class: 'lab' }, label), el('div', { class: 'seg' + (cls ? ' ' + cls : '') }, ...btns));
    }
    function slider(key, label, fmt) {
      const [lo, hi, step] = CV.LIMITS[key];
      const val = el('span', { class: 'val' });
      const input = el('input', { type: 'range', min: lo, max: hi, step: step, 'aria-label': label });
      // 2.0.4 (C1): while the thumb moves only the label and this tab's settings follow (onPreview); the value is stored
      // once, on release ('change'). Every stored value reaches every chess.com tab (re-render, layout). CV.SETTINGS_FEWER_WRITES
      // = false: stored on every step (2.0.3).
      input.addEventListener('input', () => {
        val.textContent = fmt(+input.value);
        if (CV.SETTINGS_FEWER_WRITES && opts.onPreview) opts.onPreview({ [key]: +input.value }); else opts.onChange({ [key]: +input.value });
      });
      input.addEventListener('change', () => { if (CV.SETTINGS_FEWER_WRITES && opts.onPreview) opts.onChange({ [key]: +input.value }); });
      const wrapEl = el('div', { class: 'sl' }, el('div', { class: 'row' }, el('span', { class: 'lab' }, label), val), input);
      sync.push((c) => { input.value = c[key]; val.textContent = fmt(c[key]); });
      return wrapEl;
    }
    const fmtMs = (v) => v + ' ms';
    const fmtS = (v) => (v / 1000).toFixed(1) + ' s';
    const fmtMax = (v) => (v === 0 ? 'off' : v + ' ms');
    const fmtPct = (v) => v + '%';
    const fmtInt = (v) => String(v);
    const fmtSec = (v) => v + ' s';

    function section(title, masterKey, ...content) {
      const group = el('div', { class: 'group' }, ...content);
      const master = el('span', { class: 'sw' }, el('input', { type: 'checkbox', 'aria-label': title }), el('i'));
      const input = master.firstChild;
      // keep the toggle from also toggling the <details>
      input.addEventListener('click', (e) => e.stopPropagation());
      master.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', () => opts.onChange({ [masterKey]: input.checked }));
      const det = el('details', {}, el('summary', {}, el('span', {}, el('span', { class: 'arrow' }, '\u25b8'), title), master), group);
      sync.push((c) => { input.checked = !!c[masterKey]; group.classList.toggle('off', !c[masterKey]); });
      return det;
    }

    // ---- header ----
    const dot = el('span', { class: 'dot' });
    const status = el('span', { class: 'status' }, 'starting\u2026');
    const chev = el('button', { class: 'chev', type: 'button', 'aria-label': 'Expand or collapse ChessVision' }, '\u25be');
    const head = el('div', { class: 'head' }, dot, status, chev);   // no title: the whole header width is for the status

    // ---- tools & backup ----
    const msg = el('p', { class: 'msg', 'aria-live': 'polite' });
    let msgTimer = null;
    const flash = (t) => { msg.textContent = t; clearTimeout(msgTimer); msgTimer = setTimeout(() => { msg.textContent = ''; }, 6000); };
    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
      try {
        const t = document.createElement('textarea');
        t.value = text; t.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
        shadow.append(t); t.select();
        const ok = document.execCommand('copy');
        t.remove();
        return ok;
      } catch (e) { return false; }
    }
    const ta = el('textarea', { class: 'ta', rows: '6', placeholder: 'Paste exported settings here', 'aria-label': 'Settings JSON' });
    const importBox = el('div', { class: 'importbox' }, ta,
      el('button', { class: 'btn', type: 'button', onclick: () => {
        const r = opts.onImport(ta.value);
        flash(r.message);
        if (r.ok) { ta.value = ''; importBox.classList.remove('open'); }
      } }, 'Apply'));
    // Copies text; if the browser blocks the clipboard, shows it in the box so it can be copied by hand.
    async function copyOrShow(text, okMsg) {
      if (await copyText(text)) { flash(okMsg); return; }
      ta.value = text; importBox.classList.add('open');
      flash('Copy was blocked \u2013 text shown below, select and copy it');
    }
    const toolsBox = el('div', {},
      el('div', { class: 'btns' },
        el('button', { class: 'btn', type: 'button', onclick: () => copyOrShow(opts.onExport(), 'Settings copied') }, 'Export settings'),
        el('button', { class: 'btn', type: 'button', onclick: () => { importBox.classList.toggle('open'); } }, 'Import settings'),
        el('button', { class: 'btn', type: 'button', onclick: async () => copyOrShow(await opts.onDebug(), 'Debug info copied') }, 'Copy debug info'),
        el('button', { class: 'btn', type: 'button', onclick: async () => { await opts.onClearEngines(); flash('Engine memory cleared'); } }, 'Clear engine memory'),
        el('button', { class: 'btn', type: 'button', onclick: () => { opts.onReset(); flash('Settings reset'); } }, 'Reset settings')),
      importBox, msg,
      el('p', { class: 'note' }, 'Export/Import skip Auto-play, the panel position and saved games. Clear engine memory empties AggroChess\u2019s hash and starts a new game in Stockfish. Debug info contains settings and board state, no account data.'));


    // ---- AggroChess options (visible only for AggroChess) ----
    const evalLine = el('p', { class: 'evalline', 'aria-live': 'polite' });
    const warnLine = el('p', { class: 'note warnline' });
    const aggroDet = el('details', {},
      el('summary', {}, el('span', {}, el('span', { class: 'arrow' }, '\u25b8'), 'AggroChess options')),
      el('div', { class: 'group' },
        toggle('aggroUseClock', 'Use the game clock'),
        toggle('aggroPonder', 'Ponder on opponent\u2019s time'),
        toggle('earlyPonder', 'Ponder as soon as the move is chosen'),
        slider('aggroPonderMs', 'Ponder time', fmtMs),
        toggle('ponderUntilMove', 'Keep pondering until the opponent moves'),
        slider('ponderMaxMs', 'Ponder at most', fmtS),
        toggle('ponderHitTopUp', 'Deepen a ponder hit during the pause'),
        slider('aggroPonderWorkers', 'Ponder workers', fmtInt),
        slider('aggroPonderHashMb', 'Ponder hash', (v) => v + ' MB'),
        toggle('aggroShowEval', 'Show evaluation'),
        toggle('aggroVerify', 'Verify position with engine'),
        evalLine, warnLine,
        el('p', { class: 'note' }, 'Clock: size the search from your chess.com clock (falls back to Think time if no clock is found). Ponder: extra engines think while the opponent moves and a prepared answer is used only if the opponent plays that move. Each ponder worker takes about 50 MB of memory and is capped by your CPU count. Evaluation is shown from your side (+ is good for you). Verify only warns.')));

    // ---- Stockfish options (visible only for Stockfish) ----
    const sfDet = el('details', {},
      el('summary', {}, el('span', {}, el('span', { class: 'arrow' }, '\u25b8'), 'Stockfish options')),
      el('div', { class: 'group' },
        seg('sfSearchMode', 'Search', [['depth', 'Depth'], ['delay', 'Delay'], ['clock', 'Clock']], 'tight'),
        toggle('sfUseClock', 'Use the game clock'),
        toggle('sfPonder', 'Ponder on opponent\u2019s time'),
        toggle('earlyPonder', 'Ponder as soon as the move is chosen'),
        slider('sfPonderMs', 'Ponder time', fmtMs),
        toggle('ponderUntilMove', 'Keep pondering until the opponent moves'),
        slider('ponderMaxMs', 'Ponder at most', fmtS),
        toggle('ponderHitTopUp', 'Deepen a ponder hit during the pause'),
        slider('sfPonderWorkers', 'Ponder workers', fmtInt),
        slider('sfPonderHashMb', 'Ponder hash', (v) => v + ' MB'),
        slider('sfThreads', 'Search threads', fmtInt),
        el('p', { class: 'note' }, 'Search: Depth = stop at Search depth (old behaviour). Delay = keep searching through the human-like pause and stop when it is used up (Search depth is then the minimum), so moves come at the same speed but are deeper. Clock = Stockfish\u2019s own time manager from both chess.com clocks (falls back to Delay when your clock cannot be read; untested on the real site). Clock: caps the search time from your chess.com clock (never more than a quarter of what is left). Ponder: extra Stockfish workers rank the opponent\u2019s moves and prepare replies while they think; a prepared reply is used only if the opponent plays that move. Each ponder worker costs about 40 MB plus its hash and is capped by your CPU count. Pondering is off while Imperfection is above 0. Threads above 1 need the threaded engine and a browser that allows SharedArrayBuffer; otherwise it stays at 1 (see Copy debug info).')));

    // ---- Game saving ----
    const gmsg = el('p', { class: 'msg', 'aria-live': 'polite' });
    let gTimer = null;
    const flashG = (t) => { gmsg.textContent = t; clearTimeout(gTimer); gTimer = setTimeout(() => { gmsg.textContent = ''; }, 6000); };
    const gamesBox = el('div', {});
    let games = [];
    const pad2 = (n) => String(n).padStart(2, '0');
    function downloadText(name, text) {
      try {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/x-chess-pgn' }));
        const a = document.createElement('a');
        a.href = url; a.download = name; a.style.display = 'none';
        document.documentElement.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return true;
      } catch (e) { return false; }
    }
    async function downloadOrCopy(name, text) {
      if (downloadText(name, text)) { flashG('Download started (if nothing was saved, use Copy PGN)'); return; }
      await copyOrShow(text, 'Download failed \u2013 PGN copied instead');
    }
    const small = (t, fn) => el('button', { class: 'btn sm', type: 'button', onclick: fn }, t);
    function renderGames() {
      gamesBox.textContent = '';
      if (!games.length) { gamesBox.append(el('p', { class: 'note' }, 'No saved games yet.')); return; }
      for (const g of games) {
        const d = new Date(g.date);
        const when = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        const label = when + ' \u00b7 ' + g.result + ' \u00b7 sacrifices ' + (g.sacrifices === null || g.sacrifices === undefined ? 'n/a' : g.sacrifices) +
          ' \u00b7 brilliants ' + (g.brilliants === null || g.brilliants === undefined ? 'n/a' : g.brilliants);
        const tip = 'Opponent brilliants: ' + (g.brilliantsOpponent === null || g.brilliantsOpponent === undefined ? 'n/a' : g.brilliantsOpponent) + (g.opponent ? ' \u00b7 vs ' + g.opponent : '') + (g.engine ? ' \u00b7 ' + g.engine : '');
        gamesBox.append(el('div', { class: 'game' }, el('span', { class: 'gi', title: tip }, label),
          small('Download .pgn', () => downloadOrCopy('chessvision-' + when.replace(/[: ]/g, '-') + '.pgn', g.pgn)),
          small('Copy PGN', () => copyOrShow(g.pgn, 'PGN copied'))));
      }
    }
    async function refreshGames() {
      try { games = (await opts.onListGames()) || []; } catch (e) { games = []; }
      renderGames();
    }
    let clearArmed = false, clearTimer = null;
    const clearBtn = el('button', { class: 'btn', type: 'button' }, 'Clear saved games');
    const disarm = () => { clearArmed = false; clearBtn.textContent = 'Clear saved games'; clearTimeout(clearTimer); };
    clearBtn.addEventListener('click', async () => {
      if (!clearArmed) { clearArmed = true; clearBtn.textContent = 'Click again to confirm'; clearTimer = setTimeout(disarm, 4000); return; }
      disarm();
      await opts.onClearGames();
      await refreshGames();
      flashG('Saved games cleared');
    });
    const gameDet = el('details', {},
      el('summary', {}, el('span', {}, el('span', { class: 'arrow' }, '\u25b8'), 'Game saving')),
      el('div', { class: 'group' },
        toggle('saveWithSacrifices', 'Save games with sacrifices'),
        slider('saveSacrificeThreshold', 'Save game when sacrifices reach', fmtInt),
        toggle('saveEveryGame', 'Save every game'),
        el('p', { class: 'sub' }, 'Sacrifice types counted (type of the piece that moved)'),
        toggle('sacrificeTypePawn', 'Pawn'), toggle('sacrificeTypeKnight', 'Knight'), toggle('sacrificeTypeBishop', 'Bishop'),
        toggle('sacrificeTypeRook', 'Rook'), toggle('sacrificeTypeQueen', 'Queen'),
        slider('maxSavedGames', 'Keep at most', fmtInt),
        toggle('countBrilliants', 'Count chess.com brilliant moves'),
        slider('brilliantWaitSec', 'Brilliant check wait', fmtSec),
        el('p', { class: 'note' }, 'Sacrifices come from AggroChess\u2019s own flag, so only its moves count; a game without AggroChess moves shows n/a and is saved only by \u201cSave every game\u201d or \u201cSave current game now\u201d. Brilliant counts are read from chess.com\u2019s post-game popup on a best-effort basis (n/a when not found). A game still running when the tab closes is not saved.'),
        el('p', { class: 'sub' }, 'Saved games'),
        gamesBox,
        el('div', { class: 'btns' },
          el('button', { class: 'btn', type: 'button', onclick: async () => { flashG(await opts.onSaveNow()); await refreshGames(); } }, 'Save current game now'),
          el('button', { class: 'btn', type: 'button', onclick: () => { if (games.length) downloadOrCopy('chessvision-games.pgn', games.map((g) => g.pgn).join('\n')); else flashG('No saved games'); } }, 'Download all as one .pgn'),
          clearBtn),
        gmsg));
    gameDet.addEventListener('toggle', () => { if (gameDet.open) refreshGames(); });

    // ---- body ----
    const depthRow = slider('depth', 'Search depth', (v) => String(v));
    const thinkRow = slider('thinkMs', 'Think time', fmtS);
    const sfMaxRow = slider('sfMaxMs', 'Stockfish max think time', fmtMax);
    const sfMaxNote = el('p', { class: 'note' }, 'Stops the search after this time even if the depth is not reached. 0 = off.');
    const engineSeg = seg('engine', 'Engine', [['aggro', 'AggroChess'], ['stockfish', 'Stockfish']], 'tight');
    const imperfectionRow = slider('imperfection', 'Imperfection', fmtPct);
    const imperfectionNote = el('p', { class: 'note' }, 'Imperfection sometimes plays a near-best alternative. Stockfish only; 0% = always best.');

    const body = el('div', { class: 'body' },
      toggle('enabled', 'Auto-play'),
      engineSeg, thinkRow, depthRow, sfMaxRow, sfMaxNote,
      slider('minDelay', 'Min delay', fmtMs),
      slider('maxDelay', 'Max delay', fmtMs),

      section('Human-like play', 'humanize',
        seg('delayStyle', 'Delay', [['natural', 'Natural'], ['uniform', 'Uniform']]),
        toggle('hesitation', 'Rare long pauses'),
        toggle('mouseMove', 'Curved cursor path'),
        toggle('clickOffset', 'Off-centre clicks'),
        seg('inputMode', 'Input', [['click', 'Click'], ['drag', 'Drag'], ['mixed', 'Mixed']]),
        imperfectionRow, imperfectionNote),

      section('Quick replies', 'quickReplies',
        toggle('quickOnlyMove', 'Only legal move'),
        toggle('quickRecapture', 'Recapture'),
        toggle('quickPromotion', 'Promotion and pawn runs'),
        toggle('quickMate', 'Mate in one'),
        slider('quickMinDelay', 'Quick min delay', fmtMs),
        slider('quickMaxDelay', 'Quick max delay', fmtMs),
        slider('quickThinkMs', 'Quick think time', fmtMs),
        toggle('ponderHitFast', 'Fast reply on ponder hit'),
        el('p', { class: 'note' }, 'Quick think time is the AggroChess budget for obvious moves. Stockfish searches to depth 8 or less instead. Fast reply on ponder hit: a reply prepared while the opponent thought is played with the quick delay and the faster hand.')),

      aggroDet, sfDet,

      el('details', {},
        el('summary', {}, el('span', {}, el('span', { class: 'arrow' }, '\u25b8'), 'Watchdog')),
        el('div', { class: 'group' },
          slider('watchdogMs', 'Re-read board every', fmtMs),
          slider('boardDebounceMs', 'Read board after a change', fmtMs),
          el('p', { class: 'note' }, 'Re-checks the board on a timer so a missed update can\u2019t leave it waiting. Lower = faster recovery, slightly more CPU. After a change on the board it waits this long, then reads the board twice a frame apart and only goes on when both reads agree (250 ms = the old timing).'))),

      gameDet,

      el('details', {},
        el('summary', {}, el('span', {}, el('span', { class: 'arrow' }, '\u25b8'), 'Tools & backup')),
        el('div', { class: 'group' }, toolsBox)),

      el('div', { class: 'foot' }, el('span', {}, 'v' + (opts.version || '')),
        el('span', {}, 'Settings sync across tabs')));

    wrap.append(head, body);

    // ---- collapse + drag ----
    function applyOpen() { wrap.classList.toggle('collapsed', !cfg.overlayOpen); chev.textContent = cfg.overlayOpen ? '\u25be' : '\u25b8'; }
    chev.addEventListener('click', (e) => { e.stopPropagation(); opts.onChange({ overlayOpen: !cfg.overlayOpen }); });

    function place(x, y) {
      const r = wrap.getBoundingClientRect();
      const nx = Math.min(Math.max(4, x), Math.max(4, window.innerWidth - r.width - 4));
      const ny = Math.min(Math.max(4, y), Math.max(4, window.innerHeight - 40));
      wrap.style.left = nx + 'px'; wrap.style.top = ny + 'px';
      wrap.style.right = wrap.style.bottom = 'auto';
      return [nx, ny];
    }
    let placed = null;                // 2.0.4 (C1): the overlayX / overlayY / overlayOpen the panel was last placed with
    function applyPosition() {
      placed = cfg.overlayX + ',' + cfg.overlayY + ',' + cfg.overlayOpen;
      if (cfg.overlayX === null || cfg.overlayY === null) {
        wrap.style.left = 'auto'; wrap.style.top = 'auto'; wrap.style.right = '12px'; wrap.style.bottom = '12px';
      } else place(cfg.overlayX, cfg.overlayY);
    }
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target === chev) return;
      const r = wrap.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, id: e.pointerId };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.moved = true; head.classList.add('dragging');
      drag.pos = place(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const endDrag = () => {
      if (!drag) return;
      head.classList.remove('dragging');
      if (drag.moved && drag.pos) opts.onChange({ overlayX: Math.round(drag.pos[0]), overlayY: Math.round(drag.pos[1]) });
      else if (!drag.moved) opts.onChange({ overlayOpen: !cfg.overlayOpen });   // a tap on the header toggles
      drag = null;
    };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', () => { drag = null; head.classList.remove('dragging'); });
    window.addEventListener('resize', () => { if (cfg.overlayX !== null) place(cfg.overlayX, cfg.overlayY); });

    // Stop the page from reacting to clicks/keys inside the panel.
    for (const t of ['click', 'keydown', 'keyup', 'mousedown', 'pointerdown', 'touchstart']) {
      host.addEventListener(t, (e) => e.stopPropagation());
    }

    document.documentElement.appendChild(host);

    return {
      host,
      render(next) {
        cfg = { ...cfg, ...next };
        sync.forEach((fn) => fn(cfg));
        thinkRow.style.display = cfg.engine === 'aggro' ? '' : 'none';
        depthRow.style.display = sfMaxRow.style.display = sfMaxNote.style.display = cfg.engine === 'stockfish' ? '' : 'none';
        aggroDet.style.display = cfg.engine === 'aggro' ? '' : 'none';      // AggroChess options only for AggroChess
        sfDet.style.display = cfg.engine === 'stockfish' ? '' : 'none';
        applyOpen();
        // 2.0.4 (C1): place() forces a layout; only when the position or the open state changed (or always: 2.0.3)
        if (!CV.SETTINGS_FEWER_WRITES || placed !== cfg.overlayX + ',' + cfg.overlayY + ',' + cfg.overlayOpen) applyPosition();
      },
      setEval(text) { evalLine.textContent = text || ''; },
      setWarn(text) { warnLine.textContent = text || ''; },
      refreshGames,
      setStatus(text, tone) {
        status.textContent = text;
        status.title = text;
        dot.className = 'dot' + (tone ? ' ' + tone : '');
      },
    };
  };
})(window);
