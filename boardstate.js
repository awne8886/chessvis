// Pure board-state logic (no DOM): grid -> FEN, last-move highlights, castling rights and the history tracker.
// content.js only reads the page and calls into this module. Works in the browser and under Node.
// The tracker is the ONE game-tracking mechanism: engines (history, repetition, 50-move rule), new-game
// detection, takebacks and the PGN recorder all use its events.
(function (root) {
  'use strict';
  const CV = (root.CV = root.CV || {});
  const FILES = 'abcdefgh';
  const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  const START_FEN = START_PLACEMENT + ' w KQkq - 0 1';
  const chess = () => CV.chess;                       // chessmini, resolved at call time

  // ---------- grid <-> FEN ----------
  // grid[rank-1][file-1] holds a piece letter ('P' white, 'p' black) or null.
  function gridToPlacement(grid) {
    const rows = [];
    for (let r = 8; r >= 1; r--) {
      let row = '', empty = 0;
      for (let f = 1; f <= 8; f++) {
        const p = grid[r - 1][f - 1];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += p;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join('/');
  }

  function placementToGrid(placement) {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    placement.split('/').forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') f += +ch; else grid[7 - i][f++] = ch;
      }
    });
    return grid;
  }

  // chessmini board (index = rank * 8 + file) -> placement
  function boardToPlacement(b) {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = '', empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = b[r * 8 + f];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += p;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join('/');
  }

  const countPieces = (placement) => (placement.match(/[a-zA-Z]/g) || []).length;

  function assembleFen({ placement, turn, castle, ep, halfmove, fullmove }) {
    return `${placement} ${turn} ${castle || '-'} ${ep || '-'} ${halfmove || 0} ${fullmove || 1}`;
  }

  // ---------- last-move highlights ----------
  // highlights: [[file, rank], ...] (1-based). Returns the last mover, the en-passant square (from a highlighted
  // two-square pawn push) and the 0-63 index of the square the last piece moved to (-1 if unclear).
  function analyzeHighlights(grid, highlights) {
    let lastMover = null, ep = '-', lastTo = -1;
    const occupied = highlights.filter(([f, r]) => grid[r - 1][f - 1]);
    const empty = highlights.filter(([f, r]) => !grid[r - 1][f - 1]);
    if (occupied.length) {
      const p = grid[occupied[0][1] - 1][occupied[0][0] - 1];
      lastMover = p === p.toUpperCase() ? 'w' : 'b';
      if (occupied.length === 1) lastTo = (occupied[0][1] - 1) * 8 + (occupied[0][0] - 1);
      if (occupied.length === 1 && empty.length === 1 && p.toLowerCase() === 'p') {
        const [tf, tr] = occupied[0], [ff, fr] = empty[0];
        if (tf === ff && Math.abs(tr - fr) === 2) ep = FILES[tf - 1] + (tr + fr) / 2;
      }
    }
    return { lastMover, ep, lastTo };
  }

  // ---------- board signature (2.0.0, stable reads) ----------
  // A string that changes when any piece or any last-move highlight changes, and only then. Two reads with the same
  // signature a frame apart mean chess.com has finished updating the board. Highlights are sorted, so their DOM order
  // does not matter.
  function signature(grid, highlights) {
    const hl = (highlights || []).map(([f, r]) => f + '' + r).sort().join(',');
    return gridToPlacement(grid) + '|' + hl;
  }

  // ---------- board mutations worth a read (2.0.4, A3) ----------
  // A MutationObserver on the board reports hover squares, drag ghosts, arrows, coordinates and the board's reaction to
  // our own synthetic pointer moves as well as real moves. Only these can change what readPosition() sees: a `class`
  // change on an element that has (or, by attributeOldValue, had) the class `piece` or `highlight`; a `class` change on
  // the board element itself (`flipped`); a child list change that adds or removes an element that is, or contains, a
  // `.piece` or `.highlight`. Works on real MutationRecords and on plain objects of the same shape (tests).
  const WATCH = ['piece', 'highlight'];
  const hasCls = (el, c) => !!el && (el.classList && typeof el.classList.contains === 'function' ? el.classList.contains(c)
    : (' ' + (typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '') + ' ').includes(' ' + c + ' '));
  const tokens = (v) => String(v || '').split(/\s+/);
  const watched = (el) => !!el && el.nodeType === 1 && (WATCH.some((c) => hasCls(el, c)) ||
    (typeof el.querySelector === 'function' && !!el.querySelector('.piece, .highlight')));
  function mutationRelevant(records, board) {
    for (const r of records || []) {
      if (r.type === 'attributes') {
        if (r.attributeName && r.attributeName !== 'class') continue;
        if (r.target === board) return true;
        if (WATCH.some((c) => hasCls(r.target, c))) return true;
        if (r.oldValue !== undefined && r.oldValue !== null && tokens(r.oldValue).some((t) => WATCH.includes(t))) return true;
      } else if (r.type === 'childList') {
        for (const n of r.addedNodes || []) if (watched(n)) return true;
        for (const n of r.removedNodes || []) if (watched(n)) return true;
      }
    }
    return false;
  }

  // ---------- castling rights (inferred from the page) ----------
  const freshRights = () => ({ K: true, Q: true, k: true, q: true });
  const castleString = (r) => ['K', 'Q', 'k', 'q'].filter((k) => r[k]).join('') || '-';
  const rightsFromString = (s) => ({ K: s.includes('K'), Q: s.includes('Q'), k: s.includes('k'), q: s.includes('q') });

  // Returns a NEW rights object: rights are only ever lost (king or rook no longer on its home square).
  function updateRights(rights, grid) {
    const r = { ...rights };
    const at = (f, rk) => grid[rk - 1][f - 1];
    if (at(5, 1) !== 'K') r.K = r.Q = false;
    if (at(8, 1) !== 'R') r.K = false;
    if (at(1, 1) !== 'R') r.Q = false;
    if (at(5, 8) !== 'k') r.k = r.q = false;
    if (at(8, 8) !== 'r') r.k = false;
    if (at(1, 8) !== 'r') r.q = false;
    return r;
  }

  // Everything the FEN needs from one board read (side to move: the colour opposite the last mover, else White).
  function buildPosition(grid, highlights, rights) {
    const { lastMover, ep, lastTo } = analyzeHighlights(grid, highlights);
    const turn = lastMover ? (lastMover === 'w' ? 'b' : 'w') : 'w';
    return { placement: gridToPlacement(grid), turn, castle: castleString(rights), ep, lastMover, lastTo };
  }

  // ---------- gap matching (the tracker) ----------
  // Which legal move (matchOne) or two-ply sequence (matchTwo) from `pos` gives the observed placement? Results in
  // legal-move order: [{ m, next }] / [[{ m, next }, { m, next }]].
  // 2.0.3 (CV.TRACKER_FAST_MATCH = false): every legal move, and for matchTwo every reply to it (~35 x 35 applies plus a
  // legalMoves per first move), each move applied twice (in legalMoves and here).
  function matchOneFull(pos, placement) {
    const res = [];
    for (const m of chess().legalMoves(pos)) {
      const next = chess().apply(pos, m);
      if (boardToPlacement(next.b) === placement) res.push({ m, next });
    }
    return res;
  }
  function matchTwoFull(pos, placement) {
    const res = [];
    for (const m1 of chess().legalMoves(pos)) {
      const n1 = chess().apply(pos, m1);
      for (const m2 of chess().legalMoves(n1)) {
        const n2 = chess().apply(n1, m2);
        if (boardToPlacement(n2.b) === placement) res.push([{ m: m1, next: n1 }, { m: m2, next: n2 }]);
      }
    }
    return res;
  }
  // 2.0.4 (E1): the same results, faster. In any matching sequence the from-square of every ply holds something else at
  // the end than at the start: right after a ply its from-square is empty (castling: the king's square), and a later ply
  // of the other side can only put a piece of the other colour there (also for en passant and promotion). So only moves
  // from changed squares are tried (chess.legalMovesFrom, which also hands back the position after each move instead of
  // applying it a second time); a ply changes at most 4 squares (castling), so a first ply that leaves more than 4 squares
  // different from the target cannot be completed by a second. tests/tracker-match.test.js compares both on random games.
  function placementBoard(placement) {
    const b = new Array(64).fill(null);
    const rows = placement.split('/');
    for (let i = 0; i < rows.length && i < 8; i++) {
      let f = 0;
      for (const ch of rows[i]) { if (ch >= '1' && ch <= '8') f += +ch; else if (f < 8) b[(7 - i) * 8 + f++] = ch; }
    }
    return b;
  }
  function changedSquares(a, b) {
    const s = new Set();
    for (let i = 0; i < 64; i++) if (a[i] !== b[i]) s.add(i);
    return s;
  }
  const sameBoard = (a, b) => { for (let i = 0; i < 64; i++) if (a[i] !== b[i]) return false; return true; };
  function matchOneFast(pos, placement, target) {
    const t = target || placementBoard(placement);
    const ch = changedSquares(pos.b, t);
    if (!ch.size || ch.size > 4) return [];
    return chess().legalMovesFrom(pos, ch).filter((x) => sameBoard(x.next.b, t));
  }
  function matchTwoFast(pos, placement) {
    const t = placementBoard(placement);
    const ch = changedSquares(pos.b, t);
    if (!ch.size || ch.size > 8) return [];
    const res = [];
    for (const first of chess().legalMovesFrom(pos, ch)) {
      for (const second of matchOneFast(first.next, placement, t)) res.push([first, second]);
    }
    return res;
  }

  // ---------- history tracker ----------
  function createTracker() {
    const listeners = [];
    let startFen = null;          // FEN of the baseline (entry 0)
    let entries = [];             // entries[0] = baseline, entries[i] = position after move i
    let moves = [];               // UCI moves from the baseline
    let resets = 0;               // gaps that forced a new baseline

    const epName = (pos) => (pos.ep >= 0 ? chess().sqName(pos.ep) : '-');
    const castleOf = (pos) => castleString(pos.castle);

    function makeEntry(pos, halfmove, fullmove) {
      const placement = boardToPlacement(pos.b);
      let epRelevant = '-';
      if (pos.ep >= 0 && chess().legalMoves(pos).some((m) => m.kind === 'ep')) epRelevant = epName(pos);
      return { pos, placement, halfmove, fullmove, rep: placement + ' ' + pos.turn + ' ' + castleOf(pos) + ' ' + epRelevant };
    }
    const fenOf = (e) => assembleFen({ placement: e.placement, turn: e.pos.turn, castle: castleOf(e.pos), ep: epName(e.pos), halfmove: e.halfmove, fullmove: e.fullmove });
    const lastEntry = () => entries[entries.length - 1];

    function setBaseline(pos, fullmove) {
      entries = [makeEntry(pos, 0, fullmove || 1)];
      moves = [];
      startFen = fenOf(entries[0]);
    }
    const posFromObs = (obs) => chess().parseFen(`${obs.placement} ${obs.turn || 'w'} ${obs.castle || '-'} ${obs.ep || '-'}`);

    const emit = (out, ev) => {
      out.push(ev);
      for (const fn of listeners) { try { fn(ev); } catch (e) { /* a listener must never break tracking */ } }
    };

    function addPly(out, step) {
      const prev = lastEntry();
      const m = step.m;
      const mover = prev.pos.turn;
      const reset = m.piece.toLowerCase() === 'p' || !!m.capture;
      const e = makeEntry(step.next, reset ? 0 : prev.halfmove + 1, prev.fullmove + (mover === 'b' ? 1 : 0));
      const ev = {
        type: 'ply', uci: m.uci, color: mover, piece: m.piece.toLowerCase(), capture: m.capture ? m.capture.toLowerCase() : null,
        promotion: m.promo || null, enPassant: m.kind === 'ep', castle: m.kind === 'ck' ? 'K' : m.kind === 'cq' ? 'Q' : null,
        index: moves.length, fenBefore: fenOf(prev),
      };
      entries.push(e);
      moves.push(m.uci);
      ev.fenAfter = fenOf(e);
      emit(out, ev);
    }

    const matchOne = (pos, placement) => (CV.TRACKER_FAST_MATCH ? matchOneFast : matchOneFull)(pos, placement);
    const matchTwo = (pos, placement) => (CV.TRACKER_FAST_MATCH ? matchTwoFast : matchTwoFull)(pos, placement);

    // obs: { placement, turn, castle, ep, count, highlighted }. Returns the events this observation caused.
    function observe(obs) {
      const out = [];
      const untouched = obs.placement === START_PLACEMENT && !obs.highlighted;
      const newGame = (reason) => {
        if (reason === 'start') setBaseline(chess().parseFen(START_FEN), 1); else setBaseline(posFromObs(obs), 1);
        emit(out, { type: 'newGame', reason, startFen });
      };

      if (!entries.length) {
        if (untouched) newGame('start');
        else { setBaseline(posFromObs(obs), 1); emit(out, { type: 'reset', reason: 'midgame', startFen }); }
        return out;
      }
      const last = lastEntry();
      if (obs.placement === last.placement) return out;                 // nothing changed
      if (untouched) { newGame('start'); return out; }                  // the untouched start appears (also: back to the start)

      // 1) one legal move from the last known position?
      const one = matchOne(last.pos, obs.placement);
      if (one.length === 1) { addPly(out, one[0]); return out; }

      if (one.length === 0) {
        // 2) takeback: the same placement as an earlier entry (the most recent one, preferring the same side to move)
        let hit = -1;
        for (let i = entries.length - 2; i >= 0; i--) {
          if (entries[i].placement !== obs.placement) continue;
          if (hit < 0) hit = i;
          if (!obs.turn || entries[i].pos.turn === obs.turn) { hit = i; break; }
        }
        if (hit >= 0) {
          const removed = entries.length - 1 - hit;
          entries.length = hit + 1; moves.length = hit;
          const e = lastEntry();
          emit(out, { type: 'takeback', toIndex: hit, removed, castle: castleOf(e.pos), fen: fenOf(e) });
          return out;
        }
        // 3) more pieces than before and no earlier match: a different game
        if (obs.count > countPieces(last.placement)) { newGame('count'); return out; }
        // 4) a ply was missed: exactly one two-ply explanation
        const two = obs.turnKnown && obs.turn !== last.pos.turn ? [] : matchTwo(last.pos, obs.placement);   // two plies keep the side to move
        if (two.length === 1) { addPly(out, two[0][0]); addPly(out, two[0][1]); return out; }
      }

      // never guess: report a gap and continue from the current position
      resets++;
      emit(out, { type: 'gap', fenBefore: fenOf(last), plies: moves.length });
      setBaseline(posFromObs(obs), last.fullmove);
      emit(out, { type: 'reset', reason: 'gap', startFen });
      return out;
    }

    return {
      observe,
      on(fn) { listeners.push(fn); },
      reset() { entries = []; moves = []; startFen = null; },
      info() {
        const e = lastEntry();
        if (!e) return { startFen: null, moves: [], fen: null, halfmove: 0, fullmove: 1, repetitionCount: 0, plies: 0, resets, turn: null };
        return {
          startFen, moves: moves.slice(), fen: fenOf(e), halfmove: e.halfmove, fullmove: e.fullmove,
          repetitionCount: entries.filter((x) => x.rep === e.rep).length, plies: moves.length, resets, turn: e.pos.turn,
        };
      },
      // True when the tracked history ends exactly at the given FEN's placement and side to move,
      // i.e. startFen + moves can be handed to an engine instead of the bare FEN.
      matches(fen) {
        const e = lastEntry();
        if (!e || !fen) return false;
        const [placement, turn] = String(fen).split(' ');
        return e.placement === placement && e.pos.turn === turn;
      },
    };
  }

  // Test helper: an observation from a FEN (side to move, castling and en passant are taken from it).
  function obsFromFen(fen, highlighted) {
    const [placement, turn, castle = '-', ep = '-'] = fen.split(' ');
    return { placement, turn, castle, ep, count: countPieces(placement), highlighted: !!highlighted };
  }

  CV.boardstate = {
    START_PLACEMENT, START_FEN, gridToPlacement, placementToGrid, boardToPlacement, countPieces, assembleFen,
    analyzeHighlights, signature, mutationRelevant, matchOneFull, matchTwoFull, matchOneFast, matchTwoFast, freshRights, castleString, rightsFromString, updateRights, buildPosition, createTracker, obsFromFen,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CV.boardstate;
})(typeof window !== 'undefined' ? window : globalThis);
