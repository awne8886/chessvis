// Minimal chess rules engine: FEN parsing, legal move generation, make-move, check/mate.
// Used only to recognise "obvious" positions for quick replies; the real moves come from the engines.
// Squares are indexed 0..63 as rank*8 + file (a1 = 0, h1 = 7, a8 = 56).
(function (root) {
  'use strict';
  const CV = (root.CV = root.CV || {});
  const FILES = 'abcdefgh';

  const idx = (f, r) => r * 8 + f;
  const fileOf = (s) => s & 7;
  const rankOf = (s) => s >> 3;
  const sqName = (s) => FILES[fileOf(s)] + (rankOf(s) + 1);
  const isWhite = (p) => p === p.toUpperCase();
  const colorOf = (p) => (isWhite(p) ? 'w' : 'b');

  function parseFen(fen) {
    const [place, turn, cast = '-', ep = '-'] = fen.split(' ');
    const b = new Array(64).fill(null);
    place.split('/').forEach((row, i) => {
      let f = 0;
      const r = 7 - i;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') f += +ch;
        else b[idx(f++, r)] = ch;
      }
    });
    return {
      b, turn,
      castle: { K: cast.includes('K'), Q: cast.includes('Q'), k: cast.includes('k'), q: cast.includes('q') },
      ep: ep !== '-' && ep.length === 2 ? idx(FILES.indexOf(ep[0]), +ep[1] - 1) : -1,
    };
  }

  const KN = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KG = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  // Is square `sq` attacked by any piece of colour `by`?
  function attacked(b, sq, by) {
    const f = fileOf(sq), r = rankOf(sq);
    const own = (p, set) => p && colorOf(p) === by && set.includes(p.toLowerCase());
    const pr = by === 'w' ? r - 1 : r + 1;
    if (pr >= 0 && pr < 8) {
      for (const df of [-1, 1]) {
        const pf = f + df;
        if (pf >= 0 && pf < 8 && b[idx(pf, pr)] === (by === 'w' ? 'P' : 'p')) return true;
      }
    }
    for (const [df, dr] of KN) {
      const nf = f + df, nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && own(b[idx(nf, nr)], ['n'])) return true;
    }
    for (const [df, dr] of KG) {
      const nf = f + df, nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && own(b[idx(nf, nr)], ['k'])) return true;
    }
    for (const [dirs, kinds] of [[ORTHO, ['r', 'q']], [DIAG, ['b', 'q']]]) {
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const p = b[idx(nf, nr)];
          if (p) { if (own(p, kinds)) return true; break; }
          nf += df; nr += dr;
        }
      }
    }
    return false;
  }

  function kingSquare(b, color) {
    const k = color === 'w' ? 'K' : 'k';
    return b.indexOf(k);
  }

  function inCheck(pos, color = pos.turn) {
    const k = kingSquare(pos.b, color);
    return k >= 0 && attacked(pos.b, k, color === 'w' ? 'b' : 'w');
  }

  function pseudoMoves(pos) {
    const { b, turn } = pos;
    const me = turn, them = turn === 'w' ? 'b' : 'w';
    const out = [];
    const add = (from, to, promo = '', kind = 'n') => out.push({ from, to, promo, kind });

    for (let s = 0; s < 64; s++) {
      const p = b[s];
      if (!p || colorOf(p) !== me) continue;
      const t = p.toLowerCase(), f = fileOf(s), r = rankOf(s);

      if (t === 'p') {
        const dir = me === 'w' ? 1 : -1, start = me === 'w' ? 1 : 6, last = me === 'w' ? 7 : 0;
        const pushTo = (to, kind) => {
          if (rankOf(to) === last) for (const pr of 'qrbn') add(s, to, pr, kind);
          else add(s, to, '', kind);
        };
        const r1 = r + dir;
        if (r1 >= 0 && r1 < 8 && !b[idx(f, r1)]) {
          pushTo(idx(f, r1), 'n');
          if (r === start && !b[idx(f, r + 2 * dir)]) add(s, idx(f, r + 2 * dir), '', 'dp');
        }
        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nf < 0 || nf > 7 || r1 < 0 || r1 > 7) continue;
          const to = idx(nf, r1), q = b[to];
          if (q && colorOf(q) === them) pushTo(to, 'n');
          else if (!q && to === pos.ep) add(s, to, '', 'ep');
        }
      } else if (t === 'n' || t === 'k') {
        for (const [df, dr] of t === 'n' ? KN : KG) {
          const nf = f + df, nr = r + dr;
          if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
          const q = b[idx(nf, nr)];
          if (!q || colorOf(q) === them) add(s, idx(nf, nr));
        }
      } else {
        const dirs = t === 'r' ? ORTHO : t === 'b' ? DIAG : ORTHO.concat(DIAG);
        for (const [df, dr] of dirs) {
          let nf = f + df, nr = r + dr;
          while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
            const q = b[idx(nf, nr)];
            if (!q) add(s, idx(nf, nr));
            else { if (colorOf(q) === them) add(s, idx(nf, nr)); break; }
            nf += df; nr += dr;
          }
        }
      }
    }

    // Castling (king and rook on their home squares, path empty, king not passing through check)
    const base = me === 'w' ? 0 : 56, K = me === 'w' ? 'K' : 'k', R = me === 'w' ? 'R' : 'r';
    if (b[base + 4] === K && !attacked(b, base + 4, them)) {
      if (pos.castle[K] && b[base + 7] === R && !b[base + 5] && !b[base + 6] &&
          !attacked(b, base + 5, them) && !attacked(b, base + 6, them)) add(base + 4, base + 6, '', 'ck');
      const q = me === 'w' ? 'Q' : 'q';
      if (pos.castle[q] && b[base] === R && !b[base + 1] && !b[base + 2] && !b[base + 3] &&
          !attacked(b, base + 3, them) && !attacked(b, base + 2, them)) add(base + 4, base + 2, '', 'cq');
    }
    return out;
  }

  // Plays `m` and returns the new position (the input is not modified).
  function apply(pos, m) {
    const b = pos.b.slice();
    const piece = b[m.from], me = colorOf(piece), captured = b[m.to];
    b[m.to] = m.promo ? (me === 'w' ? m.promo.toUpperCase() : m.promo) : piece;
    b[m.from] = null;
    if (m.kind === 'ep') b[m.to + (me === 'w' ? -8 : 8)] = null;
    if (m.kind === 'ck') { b[m.to - 1] = b[m.to + 1]; b[m.to + 1] = null; }
    if (m.kind === 'cq') { b[m.to + 1] = b[m.to - 2]; b[m.to - 2] = null; }
    const castle = { ...pos.castle };
    if (piece === 'K') castle.K = castle.Q = false;
    if (piece === 'k') castle.k = castle.q = false;
    for (const s of [m.from, m.to]) {
      if (s === 7) castle.K = false;
      if (s === 0) castle.Q = false;
      if (s === 63) castle.k = false;
      if (s === 56) castle.q = false;
    }
    return {
      b, castle,
      turn: pos.turn === 'w' ? 'b' : 'w',
      ep: m.kind === 'dp' ? (m.from + m.to) / 2 : -1,
      captured: captured || (m.kind === 'ep' ? (me === 'w' ? 'p' : 'P') : null),
    };
  }

  function legalMoves(pos) {
    const out = [];
    for (const m of pseudoMoves(pos)) {
      const next = apply(pos, m);
      if (inCheck(next, pos.turn)) continue;
      m.piece = pos.b[m.from];
      m.capture = next.captured;
      m.uci = sqName(m.from) + sqName(m.to) + m.promo;
      out.push(m);
    }
    return out;
  }

  const isMate = (pos) => inCheck(pos) && legalMoves(pos).length === 0;

  // 'checkmate' | 'stalemate' | null for the side to move.
  function gameState(pos) {
    if (legalMoves(pos).length) return null;
    return inCheck(pos) ? 'checkmate' : 'stalemate';
  }

  function perft(pos, depth) {
    if (depth === 0) return 1;
    let n = 0;
    for (const m of legalMoves(pos)) n += depth === 1 ? 1 : perft(apply(pos, m), depth - 1);
    return n;
  }

  CV.chess = { FILES, idx, fileOf, rankOf, sqName, colorOf, parseFen, attacked, inCheck, legalMoves, apply, isMate, gameState, perft };
  if (typeof module !== 'undefined' && module.exports) module.exports = CV.chess;
})(typeof window !== 'undefined' ? window : globalThis);
