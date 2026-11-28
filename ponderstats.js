// PONDER_STATS (temporary) begin: this whole file is the temporary 2.0.6 ponder-stats recorder (docs/REFERENCE.md,
// "Temporary: ponder stats", says how to remove it). Pure functions, loaded by the background page (and the tests).
//
// The store (in memory and, split by game, in storage.local; see background.js):
//   { v, nextGame, dropped, droppedGames, runs: [runKey], games: [{ g, c, at, recs: [record] }] }
// A game that is only in storage is { g, c, at, n, bytes } in the background's memory (no recs).
// runKey (CV.ponderStatsRunKey): the settings a record was made with, '|'-joined (RUN_FIELDS).
// A record (short keys; a missing key = unknown / not applicable):
//   p ply (moves before our move), r run index, d decision ('hit' | 'late' | 'miss' | 'none' | 'skipped'),
//   lh 1 = a late reply was harvested (played), hd reply depth (hit, or the harvested late reply), md main-search depth,
//   ot opponent think ms (our move on the board -> their move seen), lm lead ms (ponder job start -> their move),
//   rk rank of their move in the job's ranked list (0 = first), lat our latency ms (their move seen -> our move on the
//   board), k worker kills since the previous record { reason: n }, at time (ms since 1970).
(function (root) {
  'use strict';
  const CV = (root.CV = root.CV || {});

  CV.PONDER_STATS_FORMAT = 1;
  CV.PONDER_STATS_MAX_RECORDS = 60000;
  CV.PONDER_STATS_MAX_BYTES = 5 * 1024 * 1024;
  CV.PONDER_STATS_BUCKETS = [[0, 500, '<0.5 s'], [500, 1000, '0.5-1 s'], [1000, 2000, '1-2 s'], [2000, 4000, '2-4 s'], [4000, Infinity, '>4 s']];

  // [short key, long name] of the run key, in order
  const RUN_FIELDS = [['e', 'engine'], ['w', 'workers'], ['ws', 'setting'], ['t', 'threads'], ['pm', 'ponderMs'], ['px', 'ponderMaxMs'],
    ['ph', 'ponderHash'], ['mh', 'mainHash'], ['sm', 'mode'], ['b', 'build']];
  const REC_FIELDS = ['p', 'r', 'd', 'lh', 'hd', 'md', 'ot', 'lm', 'rk', 'lat', 'k', 'at'];
  const NUM_RUN = new Set(['w', 'ws', 't', 'pm', 'px', 'ph', 'mh']);
  const clean = (v) => String(v === null || v === undefined ? '' : v).replace(/[|,;=()\r\n]/g, ' ').trim();
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  CV.ponderStatsNew = () => ({ v: CV.PONDER_STATS_FORMAT, nextGame: 1, dropped: 0, droppedGames: 0, runs: [], games: [] });

  // run object { e, w, ws, t, pm, px, ph, mh, sm, b } <-> key string
  CV.ponderStatsRunKey = (run) => RUN_FIELDS.map(([k]) => clean(run && run[k])).join('|');
  CV.ponderStatsRunOf = (key) => {
    const parts = String(key).split('|'), out = {};
    RUN_FIELDS.forEach(([k], i) => { const v = parts[i] === undefined ? '' : parts[i]; out[k] = NUM_RUN.has(k) ? num(v) : v || null; });
    return out;
  };

  // The game numbered g (created when missing, with clock c and start time at); a known clock is never replaced.
  CV.ponderStatsGame = function (store, g, c, at) {
    let game = store.games.find((x) => x.g === g);
    if (!game) {
      game = { g, c: num(c), at: num(at), recs: [] };
      const i = store.games.findIndex((x) => x.g > g);
      if (i < 0) store.games.push(game); else store.games.splice(i, 0, game);
      if (store.nextGame <= g) store.nextGame = g + 1;
    } else if (game.c === null && num(c) !== null) game.c = num(c);
    if (!game.recs) game.recs = [];
    return game;
  };
  // A new game number (the next one); its game is created with the first record.
  CV.ponderStatsNewGame = (store) => store.nextGame++;

  // Adds one record to game rec.g (rec.run = the run object; the other fields as above, null / undefined left out).
  // Returns the stored record (the caller may fill later fields into it).
  CV.ponderStatsAdd = function (store, rec) {
    const g = Math.max(1, Math.floor(Number(rec.g)) || 1);
    const game = CV.ponderStatsGame(store, g, rec.c, rec.at);
    const key = CV.ponderStatsRunKey(rec.run || {});
    let r = store.runs.indexOf(key);
    if (r < 0) { store.runs.push(key); r = store.runs.length - 1; }
    const out = { r };
    for (const f of REC_FIELDS) {
      if (f === 'r') continue;
      const v = rec[f];
      if (v === null || v === undefined || (f === 'k' && (typeof v !== 'object' || !Object.keys(v).length))) continue;
      out[f] = v;
    }
    game.recs.push(out);
    game.bytes = undefined;                 // changed: its stored size is not known any more
    return out;
  };

  const gameCount = (g) => (g.recs ? g.recs.length : Number(g.n) || 0);
  const gameBytes = (g) => (Number.isFinite(g.bytes) ? g.bytes : JSON.stringify({ g: g.g, c: g.c, at: g.at, recs: g.recs || [] }).length);
  CV.ponderStatsCount = (store) => store.games.reduce((n, g) => n + gameCount(g), 0);

  // Drops the oldest whole games while there are more than maxRecords records or more than maxBytes (the games' JSON);
  // the newest game is always kept. Counts what was dropped (store.dropped records, store.droppedGames). Returns the
  // numbers of the dropped games (their storage keys are removed by the caller).
  CV.ponderStatsTrim = function (store, opts) {
    const maxR = (opts && opts.maxRecords) || CV.PONDER_STATS_MAX_RECORDS, maxB = (opts && opts.maxBytes) || CV.PONDER_STATS_MAX_BYTES;
    let recs = CV.ponderStatsCount(store), bytes = store.games.reduce((n, g) => n + gameBytes(g), 0);
    const out = [];
    while (store.games.length > 1 && (recs > maxR || bytes > maxB)) {
      const g = store.games.shift();
      recs -= gameCount(g); bytes -= gameBytes(g);
      store.dropped += gameCount(g); store.droppedGames++;
      out.push(g.g);
    }
    return out;
  };

  // Stored + live (records made before the stored data was read): the stored data first, the live games after it with
  // new numbers. The live record objects are moved, not copied (their run index renumbered), so a caller that keeps
  // references to them can still fill them in. Returns { store, map } (map: live game number -> new number).
  CV.ponderStatsMerge = function (stored, live) {
    const out = stored && stored.v === CV.PONDER_STATS_FORMAT ? JSON.parse(JSON.stringify(stored)) : CV.ponderStatsNew();
    for (const k of ['runs', 'games']) if (!Array.isArray(out[k])) out[k] = [];
    out.nextGame = Math.max(Number(out.nextGame) || 1, ...out.games.map((g) => g.g + 1), 1);
    out.dropped = Number(out.dropped) || 0; out.droppedGames = Number(out.droppedGames) || 0;
    const map = {};
    if (!live) return { store: out, map };
    for (const g of live.games || []) {
      const ng = out.nextGame++;
      map[g.g] = ng;
      const game = { ...g, g: ng, recs: (g.recs || []).map((r) => {
        const key = live.runs[r.r];
        let i = out.runs.indexOf(key);
        if (i < 0) { out.runs.push(key); i = out.runs.length - 1; }
        r.r = i;
        return r;
      }) };
      out.games.push(game);
    }
    out.dropped += Number(live.dropped) || 0; out.droppedGames += Number(live.droppedGames) || 0;
    return { store: out, map };
  };

  // ---- statistics ----
  CV.ponderStatsMedian = (a) => {
    const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y), n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };
  // nearest rank: the smallest value with at least 90% of the values at or below it
  CV.ponderStatsP90 = (a) => {
    const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    return s.length ? s[Math.ceil(0.9 * s.length) - 1] : null;
  };
  CV.ponderStatsBucket = (ms) => {
    if (!Number.isFinite(ms)) return null;
    const b = CV.PONDER_STATS_BUCKETS.find(([lo, hi]) => ms >= lo && ms < hi);
    return b ? b[2] : null;
  };
  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
  const ATTEMPT = new Set(['hit', 'late', 'miss']);

  // Rows sorted by engine, then workers, then the rest of the run key. Each: { run, key, workers, games, attempts, hits,
  // late, misses, none, skipped, hitPct, latePct, missPct, lateHarvested, oppMed, oppP90, latMed, latP90, hitDepthMed,
  // kills, buckets: [{ label, n, hits, late, misses, hitPct, latePct, missPct }] }. attempts = hit + late + miss (a
  // ponder entry existed); the percentages are of attempts. Buckets: attempts with a known opponent think time.
  CV.ponderStatsSummary = function (store) {
    const by = new Map();
    for (const game of store.games) {
      for (const rec of game.recs || []) {
        const key = store.runs[rec.r];
        if (!by.has(key)) by.set(key, { key, games: new Set(), recs: [] });
        const x = by.get(key);
        x.games.add(game.g); x.recs.push(rec);
      }
    }
    const rows = [...by.values()].map((x) => {
      const run = CV.ponderStatsRunOf(x.key);
      const cnt = (d) => x.recs.filter((r) => r.d === d).length;
      const hits = cnt('hit'), late = cnt('late'), misses = cnt('miss'), attempts = hits + late + misses;
      const kills = {};
      for (const r of x.recs) for (const [k, v] of Object.entries(r.k || {})) kills[k] = (kills[k] || 0) + v;
      const buckets = CV.PONDER_STATS_BUCKETS.map(([, , label]) => {
        const rs = x.recs.filter((r) => ATTEMPT.has(r.d) && CV.ponderStatsBucket(r.ot) === label);
        const h = rs.filter((r) => r.d === 'hit').length, l = rs.filter((r) => r.d === 'late').length, m = rs.filter((r) => r.d === 'miss').length;
        return { label, n: rs.length, hits: h, late: l, misses: m, hitPct: pct(h, rs.length), latePct: pct(l, rs.length), missPct: pct(m, rs.length) };
      });
      return {
        run, key: x.key, workers: run.w, games: x.games.size, attempts, hits, late, misses, none: cnt('none'), skipped: cnt('skipped'),
        hitPct: pct(hits, attempts), latePct: pct(late, attempts), missPct: pct(misses, attempts),
        lateHarvested: x.recs.filter((r) => r.d === 'late' && r.lh).length,
        oppMed: CV.ponderStatsMedian(x.recs.map((r) => r.ot)), oppP90: CV.ponderStatsP90(x.recs.map((r) => r.ot)),
        latMed: CV.ponderStatsMedian(x.recs.map((r) => r.lat)), latP90: CV.ponderStatsP90(x.recs.map((r) => r.lat)),
        hitDepthMed: CV.ponderStatsMedian(x.recs.filter((r) => r.d === 'hit').map((r) => r.hd)),
        kills, buckets,
      };
    });
    rows.sort((a, b) => String(a.run.e).localeCompare(String(b.run.e)) || (a.workers || 0) - (b.workers || 0) || a.key.localeCompare(b.key));
    return rows;
  };

  // ---- the text file ----
  const fmtN = (v) => (v === null || v === undefined ? '-' : String(Math.round(v * 10) / 10));
  const killsText = (k, sep) => Object.keys(k || {}).sort().map((r) => clean(r) + '=' + k[r]).join(sep);
  function table(head, rows) {
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const line = (r) => r.map((v, i) => String(v).padEnd(w[i])).join(' | ').replace(/\s+$/, '');
    return [line(head), w.map((n) => '-'.repeat(n)).join('-|-'), ...rows.map(line)].join('\n');
  }
  const runText = (run, i) => 'run ' + i + ', ' + RUN_FIELDS.filter(([k]) => k !== 'w').map(([k, name]) => name + ' ' + (run[k] === null || run[k] === undefined || run[k] === '' ? '-' : run[k])).join(', ');
  const CSV_HEAD = ['game', 'clockSec', 'ply', 'decision', 'lateHarvested', 'harvestDepth', 'hitDepth', 'mainDepth', 'oppThinkMs', 'leadMs', 'rank', 'latencyMs', 'kills', 'at'];
  const csvVal = (v) => (v === null || v === undefined ? '' : String(v));
  // The summary table alone (Copy summary).
  CV.ponderStatsSummaryText = function (store) {
    const rows = CV.ponderStatsSummary(store);
    return table(['workers', 'run', 'engine', 'setting', 'threads', 'ponderMs', 'ponderMaxMs', 'ponderHash', 'mainHash', 'mode', 'build', 'games', 'attempts', 'hits', 'late', 'misses', 'none', 'skipped',
      'hit%', 'late%', 'miss%', 'lateHarvested', 'oppThinkMed', 'oppThinkP90', 'latencyMed', 'latencyP90', 'hitDepthMed', 'kills'],
    rows.map((r, i) => [fmtN(r.workers), i + 1, r.run.e || '-', fmtN(r.run.ws), fmtN(r.run.t), fmtN(r.run.pm), fmtN(r.run.px), fmtN(r.run.ph), fmtN(r.run.mh), r.run.sm || '-', r.run.b || '-',
      r.games, r.attempts, r.hits, r.late, r.misses, r.none, r.skipped, fmtN(r.hitPct), fmtN(r.latePct), fmtN(r.missPct), r.lateHarvested,
      fmtN(r.oppMed), fmtN(r.oppP90), fmtN(r.latMed), fmtN(r.latP90), fmtN(r.hitDepthMed), killsText(r.kills, '; ') || '-']));
  };
  // The whole file. meta: { version, exportedAt, userAgent, hardwareConcurrency }.
  CV.ponderStatsFormat = function (store, meta) {
    meta = meta || {};
    const rows = CV.ponderStatsSummary(store);
    const out = [];
    out.push('# ChessVision ponder stats (temporary recorder, format ' + CV.PONDER_STATS_FORMAT + ')');
    out.push('version: ' + (meta.version || '-'));
    out.push('exported: ' + (meta.exportedAt || '-'));
    out.push('userAgent: ' + (meta.userAgent || '-'));
    out.push('hardwareConcurrency: ' + (meta.hardwareConcurrency === undefined || meta.hardwareConcurrency === null ? '-' : meta.hardwareConcurrency));
    out.push('records: ' + CV.ponderStatsCount(store));
    out.push('games: ' + store.games.length);
    out.push('dropped: ' + (store.dropped || 0) + ' records in ' + (store.droppedGames || 0) + ' games (oldest first, over the size cap)');
    out.push('');
    out.push('attempts = hit + late + miss (a ponder job existed); hit% / late% / miss% are of attempts. Times in ms.');
    out.push('oppThink = our move on the board -> the opponent\'s move seen; latency = the opponent\'s move seen -> our move on the board.');
    out.push('');
    out.push('== Summary (one row per run; by engine, then workers) ==');
    out.push(CV.ponderStatsSummaryText(store));
    out.push('');
    out.push('== Hit rate by opponent think time (attempts with a known think time) ==');
    const brows = [];
    rows.forEach((r, i) => { for (const b of r.buckets) brows.push([fmtN(r.workers), i + 1, r.run.e || '-', b.label, b.n, b.hits, b.late, b.misses, fmtN(b.hitPct), fmtN(b.latePct), fmtN(b.missPct)]); });
    out.push(table(['workers', 'run', 'engine', 'oppThink', 'n', 'hits', 'late', 'misses', 'hit%', 'late%', 'miss%'], brows));
    rows.forEach((r, i) => {
      out.push('');
      out.push('=== workers: ' + fmtN(r.workers) + ' (' + runText(r.run, i + 1) + ') ===');
      out.push(CSV_HEAD.join(','));
      const ri = store.runs.indexOf(r.key);
      for (const game of store.games) {
        for (const rec of game.recs || []) {
          if (rec.r !== ri) continue;
          out.push([game.g, game.c, rec.p, rec.d, rec.d === 'late' ? (rec.lh ? 1 : 0) : '', rec.lh ? rec.hd : '', rec.d === 'hit' ? rec.hd : '', rec.md, rec.ot, rec.lm, rec.rk, rec.lat,
            killsText(rec.k, ';'), Number.isFinite(rec.at) ? new Date(rec.at).toISOString() : ''].map(csvVal).join(','));
        }
      }
    });
    return out.join('\n') + '\n';
  };

  // Reads the per-run CSV sections of a file back: [{ run, records: [{ g, c, p, d, lh, hd, md, ot, lm, rk, lat, k, at }] }]
  // (the round trip of CV.ponderStatsFormat; also handy for the owner's own scripts, see docs/REFERENCE.md).
  CV.ponderStatsParse = function (text) {
    const out = [];
    let cur = null, head = null;
    for (const line of String(text).split(/\r?\n/)) {
      const m = /^=== workers: (\S+) \(run \d+, (.*)\) ===$/.exec(line);
      if (m) {
        const run = { w: num(m[1]) };
        for (const part of m[2].split(', ')) {
          const sp = part.indexOf(' '), name = part.slice(0, sp), v = part.slice(sp + 1);
          const f = RUN_FIELDS.find(([, n]) => n === name);
          if (f) run[f[0]] = v === '-' ? null : NUM_RUN.has(f[0]) ? num(v) : v;
        }
        cur = { run, records: [] }; out.push(cur); head = null; continue;
      }
      if (!line.trim()) { cur = null; continue; }                  // a section ends at the first blank line
      if (!cur) continue;
      if (!head) { head = line.split(','); continue; }
      const v = line.split(','), o = {};
      head.forEach((h, i) => { o[h] = v[i] === undefined ? '' : v[i]; });
      const rec = { g: num(o.game), c: num(o.clockSec), p: num(o.ply), d: o.decision || null, lh: o.lateHarvested === '1' ? 1 : null,
        hd: num(o.harvestDepth) !== null ? num(o.harvestDepth) : num(o.hitDepth), md: num(o.mainDepth), ot: num(o.oppThinkMs), lm: num(o.leadMs), rk: num(o.rank),
        lat: num(o.latencyMs), k: null, at: o.at ? Date.parse(o.at) : null };
      if (o.kills) { rec.k = {}; for (const kv of o.kills.split(';')) { const i = kv.lastIndexOf('='); if (i > 0) rec.k[kv.slice(0, i)] = Number(kv.slice(i + 1)); } }
      cur.records.push(rec);
    }
    return out;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CV;
})(typeof window !== 'undefined' ? window : globalThis);
// PONDER_STATS (temporary) end
