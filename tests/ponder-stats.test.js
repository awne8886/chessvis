// PONDER_STATS (temporary) begin: tests of ponderstats.js (2.0.6, D; delete with the recorder)
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load('ponderstats.js');
const { test, run } = runner('ponder-stats');

const RUN5 = { e: 'sf', w: 5, ws: 5, t: 4, pm: 3000, px: 8000, ph: 64, mh: 32, sm: 'clock', b: 'stockfish-19-lite-rsimd.js' };
const RUN6 = { ...RUN5, w: 6, ws: 6 };
const AGG = { e: 'aggro', w: 2, ws: 2, t: 1, pm: 1500, px: 8000, ph: 32, mh: null, sm: 'think', b: 'aggrochess-simd.wasm' };

// a store with known contents: game 1 (5 workers), game 2 (6 workers), game 3 (AggroChess)
function sample() {
  const st = CV.ponderStatsNew();
  const T = Date.UTC(2026, 10, 28, 12, 0, 0);
  let g = CV.ponderStatsNewGame(st);
  const add = (run, d, x) => CV.ponderStatsAdd(st, { g, c: 60, run, d, at: T + 1000 * CV.ponderStatsCount(st), ...x });
  add(RUN5, 'hit', { p: 2, hd: 17, ot: 300, lm: 900, rk: 0, lat: 210 });
  add(RUN5, 'late', { p: 4, lh: 1, hd: 12, ot: 700, lm: 1200, rk: 1, lat: 260, k: { 'no readyok after stop': 2 } });
  add(RUN5, 'late', { p: 6, md: 19, ot: 1500, lm: 1800, rk: 3, lat: 1400 });
  add(RUN5, 'miss', { p: 8, md: 20, ot: 2500, lm: 2700, rk: null, lat: 1500 });
  add(RUN5, 'none', { p: 0, md: 18 });
  g = CV.ponderStatsNewGame(st);
  add(RUN6, 'hit', { p: 3, hd: 15, ot: 5000, lm: 5200, rk: 0, lat: 190 });
  add(RUN6, 'hit', { p: 5, hd: 16, ot: 450, lm: 600, rk: 2, lat: 200, k: { 'start failed': 1 } });
  add(RUN6, 'skipped', { p: 7, ot: 800 });
  g = CV.ponderStatsNewGame(st);
  add(AGG, 'hit', { p: 2, hd: 9, ot: 1100, lm: 1300, rk: 0, lat: 350 });
  return st;
}

test('records are grouped by run key; rows sorted by engine, then workers; counts and percentages', () => {
  const rows = CV.ponderStatsSummary(sample());
  assert.deepStrictEqual(rows.map((r) => [r.run.e, r.workers]), [['aggro', 2], ['sf', 5], ['sf', 6]]);
  const r5 = rows[1];
  assert.deepStrictEqual([r5.games, r5.attempts, r5.hits, r5.late, r5.misses, r5.none, r5.skipped], [1, 4, 1, 2, 1, 1, 0]);
  assert.deepStrictEqual([r5.hitPct, r5.latePct, r5.missPct, r5.lateHarvested], [25, 50, 25, 1]);
  assert.deepStrictEqual(r5.kills, { 'no readyok after stop': 2 });
  assert.strictEqual(r5.hitDepthMed, 17);
  const r6 = rows[2];
  assert.deepStrictEqual([r6.attempts, r6.hits, r6.skipped, r6.hitPct, r6.hitDepthMed], [2, 2, 1, 100, 15.5]);
  assert.deepStrictEqual(r6.run, RUN6);
  assert.deepStrictEqual(rows[0].run, AGG);
  // a different value in any run field is a different run
  const st = sample();
  CV.ponderStatsAdd(st, { g: 3, run: { ...RUN5, t: 2 }, d: 'hit', hd: 10 });
  assert.strictEqual(CV.ponderStatsSummary(st).length, 4);
});

test('medians and p90 (nearest rank); unknown values ignored', () => {
  assert.strictEqual(CV.ponderStatsMedian([3, 1, 2]), 2);
  assert.strictEqual(CV.ponderStatsMedian([4, 1, 2, 3]), 2.5);
  assert.strictEqual(CV.ponderStatsMedian([null, undefined, 5]), 5);
  assert.strictEqual(CV.ponderStatsMedian([]), null);
  assert.strictEqual(CV.ponderStatsP90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.strictEqual(CV.ponderStatsP90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 10);
  assert.strictEqual(CV.ponderStatsP90([7]), 7);
  assert.strictEqual(CV.ponderStatsP90([]), null);
  const r5 = CV.ponderStatsSummary(sample())[1];
  assert.deepStrictEqual([r5.oppMed, r5.oppP90, r5.latMed, r5.latP90], [1100, 2500, 830, 1500]);
});

test('think-time buckets: <0.5 s, 0.5-1 s, 1-2 s, 2-4 s, >4 s (attempts only)', () => {
  assert.deepStrictEqual([0, 499, 500, 999, 1000, 1999, 2000, 3999, 4000, 99999].map(CV.ponderStatsBucket),
    ['<0.5 s', '<0.5 s', '0.5-1 s', '0.5-1 s', '1-2 s', '1-2 s', '2-4 s', '2-4 s', '>4 s', '>4 s']);
  assert.strictEqual(CV.ponderStatsBucket(null), null);
  const rows = CV.ponderStatsSummary(sample());
  const b5 = Object.fromEntries(rows[1].buckets.map((b) => [b.label, [b.n, b.hits, b.late, b.misses]]));
  assert.deepStrictEqual(b5, { '<0.5 s': [1, 1, 0, 0], '0.5-1 s': [1, 0, 1, 0], '1-2 s': [1, 0, 1, 0], '2-4 s': [1, 0, 0, 1], '>4 s': [0, 0, 0, 0] });
  const b6 = Object.fromEntries(rows[2].buckets.map((b) => [b.label, b.n]));
  assert.deepStrictEqual(b6, { '<0.5 s': 1, '0.5-1 s': 0, '1-2 s': 0, '2-4 s': 0, '>4 s': 1 }, 'the skipped move is not an attempt');
});

test('trim: the oldest whole games go first, counted; the newest game is always kept', () => {
  const st = sample();
  assert.deepStrictEqual(CV.ponderStatsTrim(st, { maxRecords: 100 }), []);
  assert.deepStrictEqual(CV.ponderStatsTrim(st, { maxRecords: 4 }), [1]);
  assert.deepStrictEqual([st.games.map((g) => g.g), st.dropped, st.droppedGames, CV.ponderStatsCount(st)], [[2, 3], 5, 1, 4]);
  assert.deepStrictEqual(CV.ponderStatsTrim(st, { maxRecords: 1 }), [2]);
  assert.deepStrictEqual(CV.ponderStatsTrim(st, { maxRecords: 0.5 }), [], 'one game left: kept');
  assert.deepStrictEqual([st.dropped, st.droppedGames], [8, 2]);
  // by bytes, with games that are only index entries (n, bytes) as in the background's memory
  const idx = { ...CV.ponderStatsNew(), games: [{ g: 1, n: 10, bytes: 3000 }, { g: 2, n: 10, bytes: 3000 }, { g: 3, recs: [{ r: 0, d: 'hit' }] }] };
  assert.deepStrictEqual(CV.ponderStatsTrim(idx, { maxBytes: 2000 }), [1, 2]);
  assert.deepStrictEqual([idx.dropped, idx.droppedGames], [20, 2]);
  // the default caps
  assert.strictEqual(CV.PONDER_STATS_MAX_RECORDS, 60000);
  assert.strictEqual(CV.PONDER_STATS_MAX_BYTES, 5 * 1024 * 1024);
});

test('merge: stored first, live games renumbered after them, the same record objects; runs remapped', () => {
  const stored = sample();
  stored.dropped = 3; stored.droppedGames = 1;
  const live = CV.ponderStatsNew();
  const g = CV.ponderStatsNewGame(live);
  const rec = CV.ponderStatsAdd(live, { g, run: RUN6, d: 'miss', md: 18 });
  CV.ponderStatsAdd(live, { g, run: { ...RUN6, w: 7, ws: 7 }, d: 'hit', hd: 14 });
  const { store, map } = CV.ponderStatsMerge(JSON.parse(JSON.stringify(stored)), live);
  assert.deepStrictEqual(map, { 1: 4 });
  assert.deepStrictEqual(store.games.map((x) => x.g), [1, 2, 3, 4]);
  assert.strictEqual(store.nextGame, 5);
  assert.strictEqual(store.games[3].recs[0], rec, 'the live record object itself');
  assert.strictEqual(store.runs[rec.r], CV.ponderStatsRunKey(RUN6));
  assert.strictEqual(store.runs.length, 4);
  assert.deepStrictEqual([store.dropped, store.droppedGames], [3, 1]);
  // nothing stored yet / a stored value of another format
  assert.deepStrictEqual(CV.ponderStatsMerge(null, null).store, CV.ponderStatsNew());
  assert.deepStrictEqual(CV.ponderStatsMerge({ v: 99, games: [{ g: 5 }] }, null).store, CV.ponderStatsNew());
});

test('the file: header, summary, buckets, one section per run; the CSV blocks parse back to the same records', () => {
  const st = sample();
  const text = CV.ponderStatsFormat(st, { version: '2.0.6', exportedAt: '2026-11-28T12:00:00.000Z', userAgent: 'UA, test', hardwareConcurrency: 8 });
  for (const s of ['version: 2.0.6', 'hardwareConcurrency: 8', 'records: 9', 'games: 3', 'dropped: 0 records in 0 games', '== Summary', '== Hit rate by opponent think time']) assert.ok(text.includes(s), s);
  const heads = text.split('\n').filter((l) => l.startsWith('=== workers: '));
  assert.deepStrictEqual(heads.map((l) => l.slice(0, 17)), ['=== workers: 2 (r', '=== workers: 5 (r', '=== workers: 6 (r']);
  assert.ok(heads[1].includes('engine sf, setting 5, threads 4, ponderMs 3000, ponderMaxMs 8000, ponderHash 64, mainHash 32, mode clock, build stockfish-19-lite-rsimd.js'), heads[1]);
  const summary = text.slice(text.indexOf('== Summary'), text.indexOf('== Hit rate'));
  const firstCols = summary.split('\n').slice(3).filter(Boolean).map((l) => l.split('|')[0].trim());
  assert.deepStrictEqual(firstCols, ['2', '5', '6'], 'the first column is the worker count');
  // round trip
  const parsed = CV.ponderStatsParse(text);
  assert.strictEqual(parsed.length, 3);
  const flat = [];
  for (const game of st.games) for (const r of game.recs) flat.push({ run: CV.ponderStatsRunOf(st.runs[r.r]), rec: { g: game.g, c: game.c, p: r.p, d: r.d, lh: r.lh || null, hd: r.hd === undefined ? null : r.hd, md: r.md === undefined ? null : r.md,
    ot: r.ot === undefined ? null : r.ot, lm: r.lm === undefined ? null : r.lm, rk: r.rk === undefined ? null : r.rk, lat: r.lat === undefined ? null : r.lat, k: r.k || null, at: r.at } });
  const back = [];
  for (const sec of parsed) for (const rec of sec.records) back.push({ run: sec.run, rec });
  const key = (x) => x.rec.g + ':' + x.rec.p;
  assert.deepStrictEqual(back.sort((a, b) => key(a).localeCompare(key(b))), flat.sort((a, b) => key(a).localeCompare(key(b))));
  // the summary alone (Copy summary) is the same table
  assert.ok(text.includes(CV.ponderStatsSummaryText(st)));
});

test('ponderStatsAdd leaves out unknown fields and empty kills; a known clock is kept', () => {
  const st = CV.ponderStatsNew();
  const r = CV.ponderStatsAdd(st, { g: 1, c: null, run: RUN5, d: 'none', p: 0, hd: null, md: undefined, k: {}, at: 5 });
  assert.deepStrictEqual(r, { r: 0, p: 0, d: 'none', at: 5 });
  CV.ponderStatsAdd(st, { g: 1, c: 180, run: RUN5, d: 'hit' });
  CV.ponderStatsAdd(st, { g: 1, c: 60, run: RUN5, d: 'hit' });
  assert.strictEqual(st.games[0].c, 180);
  assert.strictEqual(st.nextGame, 2);
  assert.deepStrictEqual(CV.ponderStatsRunOf(CV.ponderStatsRunKey({ ...RUN5, b: 'a|b,c' })).b, 'a b c');
});

run();
// PONDER_STATS (temporary) end
