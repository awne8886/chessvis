// Game recorder (no DOM, no storage). It does NOT trust the live tracker to reconstruct moves.
// Instead it keeps the list of distinct board positions that were ever seen ("anchors") - whoever made the move,
// the bot, the opponent, or you by hand while Auto-play was paused - and rebuilds the move list from them when the
// game is built (at its end, or on "Save now"). A gap between two anchors (a move was missed because the board was
// not read in between) is filled by searching the legal move sequences that lead from the earlier position to the
// later one, using everything known about the two positions (side to move, last-move square, moves the bot said it
// played). That happens once, afterwards, so every later anchor can be used as context.
(function (root) {
  'use strict';
  const CV = (root.CV = root.CV || {});

  const MAX_ANCHORS = 800;
  const MAX_GAP_PLIES = 6;         // longest missed stretch the search will try to explain
  const NODE_BUDGET = 400000;      // legal-move expansions per segment, so a hopeless gap can never hang the page
  const SKIP_AHEAD = 2;            // an anchor that cannot be explained is skipped (transient read); try this many later ones

  const C = () => CV.chess;
  const BS = () => CV.boardstate;
  const posKey = (placement, turn) => placement + ' ' + turn;
  const countPieces = (placement) => (placement.match(/[a-zA-Z]/g) || []).length;
  const boardPlacement = (pos) => BS().boardToPlacement(pos.b);

  // ---------- gap solver ----------
  // Finds legal move sequences from `pos` that end on a board whose placement equals `targetBoard` (a 64-array).
  // Returns an array of solutions (each: array of { m, next }), shortest length first; [] if none within the limits.
  function solveSegment(pos, targetBoard, opts) {
    const o = opts || {};
    const maxPlies = o.maxPlies || MAX_GAP_PLIES;
    let nodes = 0;
    const targetCount = targetBoard.reduce((n, p) => n + (p ? 1 : 0), 0);
    const pieces = (b) => b.reduce((n, p) => n + (p ? 1 : 0), 0);
    const diff = (b) => { let d = 0; for (let i = 0; i < 64; i++) if (b[i] !== targetBoard[i]) d++; return d; };

    for (let n = 1; n <= maxPlies; n++) {
      if (o.parity !== undefined && o.parity !== null && n % 2 !== o.parity) continue;
      const found = [];
      const path = [];
      const dfs = (p, rem) => {
        if (found.length >= 40 || nodes > NODE_BUDGET) return;
        for (const m of C().legalMoves(p)) {
          nodes++;
          const next = C().apply(p, m);
          if (rem === 1) {
            if (diff(next.b) === 0) { path.push({ m, next }); found.push(path.slice()); path.pop(); }
            continue;
          }
          const left = rem - 1;
          // a ply changes at most 2 squares (castling 4, en passant 3); pieces can only disappear
          const have = pieces(next.b);
          if (have < targetCount || have - targetCount > left) continue;
          if (diff(next.b) > 2 * left + 2) continue;
          path.push({ m, next });
          dfs(next, left);
          path.pop();
          if (found.length >= 40 || nodes > NODE_BUDGET) return;
        }
      };
      // quick reject: even the best case cannot reach the target in n plies
      if (diff(pos.b) <= 2 * n + 2 && pieces(pos.b) >= targetCount && pieces(pos.b) - targetCount <= n) dfs(pos, n);
      if (found.length) return found;
      if (nodes > NODE_BUDGET) return [];
    }
    return [];
  }

  // Picks the most plausible of several explanations: last-move square matches the observed highlight, moves the bot
  // announced, then a stable order (queen promotions before under-promotions, then generation order).
  function bestSolution(solutions, ctx) {
    let best = null, bestScore = -Infinity;
    for (const sol of solutions) {
      let score = 0;
      const last = sol[sol.length - 1].m;
      if (ctx.lastTo >= 0 && last.kind !== 'ck' && last.kind !== 'cq' && last.to === ctx.lastTo) score += 4;
      let p = ctx.pos;
      for (const step of sol) {
        const key = posKey(boardPlacement(p), p.turn);
        if (ctx.notes.some((nt) => nt.key === key && nt.uci === step.m.uci)) score += 2;
        if (step.m.promo && step.m.promo.toLowerCase() !== 'q') score -= 0.5;
        p = step.next;
      }
      if (score > bestScore) { best = sol; bestScore = score; }
    }
    return best;
  }

  function createRecorder(opts) {
    const clock = (opts && opts.now) || (() => Date.now());
    let g = null;   // the game in progress

    function fresh(obs, standard) {
      const t = clock();
      const startFen = standard ? CV.STANDARD_START_FEN : [obs.placement, obs.turn || 'w', obs.castle || '-', obs.ep || '-', 0, 1].join(' ');
      g = {
        id: 'g' + t + '-' + Math.random().toString(36).slice(2, 6),   // stable for this game: a re-save replaces, never duplicates
        startedAt: t, startFen, standard: startFen === CV.STANDARD_START_FEN,
        anchors: [{ placement: obs.placement, turn: obs.turn || 'w', turnKnown: !!obs.turnKnown, castle: obs.castle || '-', ep: obs.ep || '-', lastTo: obs.lastTo >= 0 ? obs.lastTo : -1 }],
        notes: [], ended: false, result: null, meta: {}, resolved: null,
      };
    }

    const parseAnchor = (a, turn) => C().parseFen(`${a.placement} ${turn} ${a.castle || '-'} ${a.ep || '-'}`);

    // Is `placement` one legal move away from anchor `a`? (both colours when the side to move is not certain)
    function oneMoveAway(a, placement) {
      const turns = a.turnKnown ? [a.turn] : ['w', 'b'];
      for (const t of turns) {
        let pos;
        try { pos = parseAnchor(a, t); } catch (e) { continue; }
        for (const m of C().legalMoves(pos)) if (boardPlacement(C().apply(pos, m)) === placement) return true;
      }
      return false;
    }

    // Feed EVERY board read here: { placement, turn, turnKnown, castle, ep, count, highlighted, lastTo }.
    // Returns the previous game when a new one began without it ever being seen to end (the caller may keep it), else null.
    function observe(obs) {
      const untouched = obs.placement === BS().START_PLACEMENT && !obs.highlighted;
      if (!g) { fresh(obs, untouched); return null; }
      const last = g.anchors[g.anchors.length - 1];
      if (obs.placement === last.placement) {
        if (!g.ended && obs.turnKnown && !last.turnKnown) { last.turn = obs.turn; last.turnKnown = true; }
        return null;
      }
      let abandoned = null;
      const startNew = () => { if (!g.ended && g.anchors.length > 1) abandoned = g; fresh(obs, untouched); return abandoned; };
      if (untouched) return startNew();
      if (g.ended) {
        if (obs.count > countPieces(last.placement)) return startNew();
        return null;                                            // the finished game stays as it was
      }
      const anchor = { placement: obs.placement, turn: obs.turn || 'w', turnKnown: !!obs.turnKnown, castle: obs.castle || '-', ep: obs.ep || '-', lastTo: obs.lastTo >= 0 ? obs.lastTo : -1 };
      if (oneMoveAway(last, obs.placement)) { push(anchor); return null; }      // an ordinary move
      // a takeback: the same placement as an earlier anchor (the latest one, preferring the same side to move)
      let hit = -1;
      for (let i = g.anchors.length - 2; i >= 0; i--) {
        if (g.anchors[i].placement !== obs.placement) continue;
        if (hit < 0) hit = i;
        if (!obs.turnKnown || !g.anchors[i].turnKnown || g.anchors[i].turn === obs.turn) { hit = i; break; }
      }
      if (hit >= 0) {
        g.anchors.length = hit + 1;
        const a = g.anchors[hit];
        if (obs.turnKnown) { a.turn = obs.turn; a.turnKnown = true; }
        a.lastTo = anchor.lastTo;
        g.resolved = null;
        return null;
      }
      if (obs.count > countPieces(last.placement)) return startNew();         // more pieces than before: a different game
      push(anchor);                                                           // a gap: kept as it is, explained at the end
      return null;
    }
    function push(anchor) {
      g.anchors.push(anchor);
      if (g.anchors.length > MAX_ANCHORS) g.anchors.splice(1, 1);             // pathological: drop the oldest non-start anchor
      g.resolved = null;
    }

    // Called when the extension actually executes a move. flagKnown: the engine's sacrifice flag exists (AggroChess answer).
    function noteBotMove({ fen, uci, color, sacrifice, engine, flagKnown }) {
      if (!g || g.ended) return;
      const [placement, turn] = String(fen).split(' ');
      g.notes.push({ key: posKey(placement, turn), uci, color, sacrifice: !!sacrifice, engine, flagKnown: !!flagKnown });
      if (g.notes.length > 400) g.notes.shift();
      g.resolved = null;
    }

    function setMeta(meta) { if (g) g.meta = { ...g.meta, ...meta }; }

    // Rebuilds the move list. Cached until the anchors or notes change.
    // Returns { plies, guessed, unresolved } - plies: [{ uci, san, color, piece, capture, promotion, fenBefore, fenAfter, by, engine, flagKnown, sacrifice, guessed }]
    function resolve(game) {
      if (game.resolved) return game.resolved;
      const plies = [];
      let unresolved = null, guessedPlies = 0;
      let pos = C().parseFen(game.startFen);
      let halfmove = 0, fullmove = Number(game.startFen.split(' ')[5]) || 1;
      const used = new Set();
      const fenOf = (p) => `${boardPlacement(p)} ${p.turn} ${p.castle && typeof p.castle === 'string' ? p.castle : BS().castleString(p.castle)} ${p.ep >= 0 ? C().sqName(p.ep) : '-'} ${halfmove} ${fullmove}`;

      const accept = (steps, guessed) => {
        for (const step of steps) {
          const legal = C().legalMoves(pos);
          const mv = legal.find((x) => x.uci === step.m.uci) || step.m;
          const key = posKey(boardPlacement(pos), pos.turn);
          const san = CV.pgn.sanFor(pos, mv, legal);
          const fenBefore = fenOf(pos);
          const ply = {
            uci: mv.uci, san, color: pos.turn, piece: mv.piece.toLowerCase(), capture: mv.capture ? mv.capture.toLowerCase() : null, promotion: mv.promo || null,
            fenBefore, by: 'other', engine: null, flagKnown: false, sacrifice: false, guessed: !!guessed,
          };
          for (let i = game.notes.length - 1; i >= 0; i--) {                    // the bot's move counts only if the board shows exactly it
            const nt = game.notes[i];
            if (used.has(i) || nt.key !== key || nt.uci !== mv.uci || nt.color !== pos.turn) continue;
            used.add(i);
            ply.by = 'bot'; ply.engine = nt.engine; ply.flagKnown = nt.flagKnown; ply.sacrifice = nt.sacrifice;
            break;
          }
          if (mv.piece.toLowerCase() === 'p' || mv.capture) halfmove = 0; else halfmove++;
          if (pos.turn === 'b') fullmove++;
          pos = C().apply(pos, mv);
          ply.fenAfter = fenOf(pos);
          plies.push(ply);
          if (guessed) guessedPlies++;
        }
      };

      const anchors = game.anchors;
      let i = 1;
      while (i < anchors.length) {
        const here = boardPlacement(pos);
        if (anchors[i].placement === here) { i++; continue; }
        let solved = null, usedIndex = -1;
        for (let j = i; j < anchors.length && j <= i + SKIP_AHEAD; j++) {
          const a = anchors[j];
          if (a.placement === here) { solved = { steps: [], single: true }; usedIndex = j; break; }
          const target = C().parseFen(a.placement + ' w - -').b;
          const parityOf = (turn) => (turn === pos.turn ? 0 : 1);
          let sols = [];
          if (a.turnKnown) sols = solveSegment(pos, target, { parity: parityOf(a.turn) });
          if (!sols.length) sols = solveSegment(pos, target, {});               // the side to move may have been misread
          if (!sols.length) continue;
          const sol = bestSolution(sols, { pos, lastTo: a.lastTo, notes: game.notes });
          solved = { steps: sol, single: sol.length === 1 && sols.length === 1 };
          usedIndex = j;
          break;
        }
        if (!solved) { unresolved = { afterPly: plies.length, anchor: i }; break; }
        accept(solved.steps, solved.steps.length > 1 || !solved.single);        // a lone, unambiguous move is as certain as an observed one
        i = usedIndex + 1;
      }
      game.resolved = { plies, guessed: guessedPlies, unresolved };
      return game.resolved;
    }

    // Marks the game as ended (once). Returns the game, or null if there is none, it already ended or it has no moves.
    function end(result) {
      if (!g || g.ended) return null;
      g.ended = true; g.result = result || '*';
      return resolve(g).plies.length ? g : null;
    }

    // Builds the stored record. brilliants: { mine, opp } (numbers or null).
    function build(game, o) {
      const cfg = o.cfg || {};
      const res = resolve(game);
      const myColor = o.myColor || game.meta.myColor || 'w';
      const me = (o.names && o.names.me) || (game.meta.names && game.meta.names.me) || 'You';
      const opp = (o.names && o.names.opp) || (game.meta.names && game.meta.names.opp) || 'Bot';
      const white = myColor === 'w' ? me : opp, black = myColor === 'w' ? opp : me;
      const result = o.result || game.result || '*';
      const sacrifices = CV.pgn.countSacrifices(res.plies, CV.pgn.togglesFrom(cfg));
      const br = o.brilliants || {};
      const mine = Number.isFinite(br.mine) ? br.mine : null, theirs = Number.isFinite(br.opp) ? br.opp : null;
      let engine = null;
      for (const p of res.plies) if (p.by === 'bot' && p.engine) engine = p.engine;
      const headers = [
        ['Event', 'chess.com computer game'], ['Site', 'chess.com'], ['Date', CV.pgn.pgnDate(new Date(game.startedAt))], ['Round', '-'],
        ['White', white], ['Black', black], ['Result', result],
        ['SetUp', game.standard ? null : '1'], ['FEN', game.standard ? null : game.startFen],
        ['Engine', engine], ['ChessVisionSacrifices', sacrifices], ['ChessVisionBrilliants', mine],
        ['ChessVisionReconstructedPlies', res.guessed || null],
        ['ChessVisionIncomplete', res.unresolved ? 'moves after ply ' + res.unresolved.afterPly + ' could not be reconstructed' : null],
      ];
      const pgn = CV.pgn.buildPgn({ headers, moves: res.plies.map((p) => ({ san: p.san })), result, startFen: game.startFen });
      return {
        id: game.id, date: new Date(game.startedAt).toISOString(), result, sacrifices, brilliants: mine, brilliantsOpponent: theirs,
        opponent: opp, engine, plies: res.plies.length, reconstructed: res.guessed, incomplete: !!res.unresolved, pgn,
      };
    }

    return {
      observe, noteBotMove, setMeta, end, build, resolve, current: () => g,
      // number of board positions seen after the first (cheap; the move count itself needs resolve())
      plyCount: () => (g ? g.anchors.length - 1 : 0),
      hasMoves: () => !!g && g.anchors.length > 1,
    };
  }

  CV.createRecorder = createRecorder;
  CV.recorderInternals = { solveSegment, MAX_GAP_PLIES };
  if (typeof module !== 'undefined' && module.exports) module.exports = createRecorder;
})(typeof window !== 'undefined' ? window : globalThis);
