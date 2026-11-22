// Pure SAN / PGN building and the rules for counting sacrifices and keeping saved games. No DOM, no storage.
(function (root) {
  'use strict';
  const CV = (root.CV = root.CV || {});
  const chess = () => CV.chess;

  const SAVED_MAX_BYTES = 4 * 1024 * 1024;       // the stored list is trimmed (oldest first) above this size
  const TYPE_KEYS = { p: 'sacrificeTypePawn', n: 'sacrificeTypeKnight', b: 'sacrificeTypeBishop', r: 'sacrificeTypeRook', q: 'sacrificeTypeQueen' };

  // SAN of `m` (a legal move object of chessmini) played in `pos`, with disambiguation and check / mate markers.
  function sanFor(pos, m, legal) {
    const C = chess();
    legal = legal || C.legalMoves(pos);
    let san;
    const type = m.piece.toLowerCase();
    if (m.kind === 'ck') san = 'O-O';
    else if (m.kind === 'cq') san = 'O-O-O';
    else {
      const to = C.sqName(m.to), cap = !!m.capture;
      if (type === 'p') {
        san = (cap ? C.sqName(m.from)[0] + 'x' : '') + to + (m.promo ? '=' + m.promo.toUpperCase() : '');
      } else {
        const others = legal.filter((o) => o !== m && o.to === m.to && o.piece === m.piece && o.from !== m.from);
        let dis = '';
        if (others.length) {
          const sameFile = others.some((o) => C.fileOf(o.from) === C.fileOf(m.from));
          const sameRank = others.some((o) => C.rankOf(o.from) === C.rankOf(m.from));
          if (!sameFile) dis = C.sqName(m.from)[0];
          else if (!sameRank) dis = C.sqName(m.from)[1];
          else dis = C.sqName(m.from);
        }
        san = type.toUpperCase() + dis + (cap ? 'x' : '') + to;
      }
    }
    const next = C.apply(pos, m);
    if (C.inCheck(next)) san += C.legalMoves(next).length ? '+' : '#';
    return san;
  }

  // Plays a UCI move on a FEN and returns its SAN, or null if the move is not legal there.
  function sanFromFen(fen, uci) {
    const pos = chess().parseFen(fen);
    const legal = chess().legalMoves(pos);
    const m = legal.find((x) => x.uci === uci);
    return m ? sanFor(pos, m, legal) : null;
  }

  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  const pad = (n) => String(n).padStart(2, '0');
  const pgnDate = (d) => d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate());

  // headers: [[name, value], ...] (null/undefined/empty values are skipped). moves: [{ san }].
  // startFen: baseline FEN (fullmove number and side to move for the numbering).
  // Movetext is plain: move numbers, SAN and the result, no comments, wrapped at 80 columns.
  function buildPgn({ headers, moves, result, startFen }) {
    const tags = headers.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => '[' + k + ' "' + esc(v) + '"]');
    const parts = (startFen || '').split(' ');
    let turn = parts[1] === 'b' ? 'b' : 'w', fullmove = Number(parts[5]) > 0 ? Number(parts[5]) : 1;
    const tokens = [];
    let first = true;
    for (const mv of moves) {
      if (turn === 'w') tokens.push(fullmove + '.');
      else if (first) tokens.push(fullmove + '...');       // a game that starts with Black to move
      tokens.push(mv.san);
      first = false;
      if (turn === 'b') fullmove++;
      turn = turn === 'w' ? 'b' : 'w';
    }
    tokens.push(result || '*');
    // wrap at 80 columns
    const lines = [];
    let line = '';
    for (const t of tokens) {
      if (line && line.length + 1 + t.length > 80) { lines.push(line); line = t; } else line = line ? line + ' ' + t : t;
    }
    if (line) lines.push(line);
    return tags.join('\n') + '\n\n' + lines.join('\n') + '\n';
  }

  // Sacrifices counted for a game. plies: [{ piece, by, engine, flagKnown, sacrifice }].
  // null (never 0) when the game has no AggroChess ply with a known flag: the flag only exists for AggroChess.
  // Only plies the bot made and the board confirmed carry `by: 'bot'`; manual moves and the opponent's are never counted.
  // A sacrificed piece's type is the type of the piece that moved; a king move has no toggle and is not counted.
  function countSacrifices(plies, toggles) {
    const t = toggles || {};
    let known = false, n = 0;
    for (const p of plies) {
      if (p.by !== 'bot' || p.engine !== 'aggro' || !p.flagKnown) continue;
      known = true;
      const key = TYPE_KEYS[p.piece];
      if (p.sacrifice && key && t[key] !== false) n++;
    }
    return known ? n : null;
  }
  const togglesFrom = (cfg) => {
    const t = {};
    for (const k of Object.values(TYPE_KEYS)) t[k] = cfg[k] !== false;
    return t;
  };

  // Auto-save rule, applied once when a game ends.
  function shouldSave(cfg, rec) {
    if (cfg.saveEveryGame) return true;
    return !!cfg.saveWithSacrifices && rec.sacrifices !== null && rec.sacrifices !== undefined && rec.sacrifices >= cfg.saveSacrificeThreshold;
  }

  // Newest first, one entry per id (a re-save replaces it in place), capped by count and by total size.
  function mergeSaved(list, rec, { max, maxBytes } = {}) {
    const limit = Math.max(1, max || 50), bytes = maxBytes || SAVED_MAX_BYTES;
    const out = list.slice();
    const i = out.findIndex((g) => g.id === rec.id);
    if (i >= 0) out[i] = rec; else out.unshift(rec);
    while (out.length > limit) out.pop();
    while (out.length > 1 && JSON.stringify(out).length > bytes) out.pop();
    return out;
  }

  CV.pgn = { sanFor, sanFromFen, buildPgn, countSacrifices, togglesFrom, shouldSave, mergeSaved, pgnDate, TYPE_KEYS, SAVED_MAX_BYTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = CV.pgn;
})(typeof window !== 'undefined' ? window : globalThis);
