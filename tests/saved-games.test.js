// 2.0.4 (C2): saved games under one key per game + an index, written by the background page (real background.js with
// the in-memory storage of tests/_fakebg.js). CV.mergeSavedIndex must keep exactly CV.pgn.mergeSaved's rules; the 2.0.3
// list ('savedGames') is migrated once, idempotently, also after an interrupted migration.
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load('boardstate.js', 'pgn.js');
const { makeBackground, makeStorage, sleep } = require('./_fakebg');
const { test, run } = runner('saved-games');

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 2 ** 31; };
const rec = (id, len) => ({ id, date: 1700000000000, result: '*', sacrifices: null, brilliants: null, engine: 'aggro', plies: 10, pgn: 'x'.repeat(len) });

test('mergeSavedIndex keeps exactly mergeSaved\'s ids and order (count cap, byte cap, re-save in place)', () => {
  let cases = 0;
  for (let t = 0; t < 3000; t++) {
    const n = Math.floor(rnd() * 14);
    const list = [];
    for (let i = 0; i < n; i++) list.push(rec('g' + Math.floor(rnd() * 1e9), Math.floor(rnd() * 400)));
    const r = rnd() < 0.3 && n ? { ...list[Math.floor(rnd() * n)], pgn: 'y'.repeat(Math.floor(rnd() * 600)) } : rec('new' + t, Math.floor(rnd() * 600));
    const max = 1 + Math.floor(rnd() * 12), maxBytes = rnd() < 0.5 ? 400 + Math.floor(rnd() * 4000) : undefined;
    const want = CV.pgn.mergeSaved(list, r, { max, maxBytes }).map((g) => g.id);
    const got = CV.mergeSavedIndex(list.map((g) => ({ id: g.id, bytes: CV.savedGameBytes(g) })), { id: r.id, bytes: CV.savedGameBytes(r) }, { max, maxBytes });
    assert.deepStrictEqual(got.list.map((g) => g.id), want, JSON.stringify({ n, max, maxBytes }));
    const before = new Set(list.map((g) => g.id).concat(r.id));
    assert.deepStrictEqual(got.dropped.sort(), [...before].filter((id) => !want.includes(id)).sort());
    cases++;
  }
  assert.strictEqual(cases, 3000);
  assert.strictEqual(CV.SAVED_GAMES_MAX_BYTES, CV.pgn.SAVED_MAX_BYTES);
});

const keysOf = (st) => Object.keys(st.data).filter((k) => k.startsWith('game:')).sort();

test('a save writes one game key plus the index (one set); pruning deletes keys; a re-save replaces in place', async () => {
  const st = makeStorage();
  const bg = makeBackground({ storage: st });
  for (let i = 1; i <= 5; i++) assert.ok((await bg.send({ type: 'saveGame', record: rec('g' + i, 100), max: 50 })).ok);
  assert.deepStrictEqual(st.data.savedGameIds, ['g5', 'g4', 'g3', 'g2', 'g1']);
  const c0 = { ...st.counts };
  await bg.send({ type: 'saveGame', record: rec('g6', 100), max: 50 });
  assert.strictEqual(st.counts.set - c0.set, 1, 'one set()');
  assert.strictEqual(st.counts.setKeys - c0.setKeys, 2, 'the game and the index');
  assert.strictEqual(st.counts.remove - c0.remove, 0);
  await bg.send({ type: 'saveGame', record: { ...rec('g3', 50), result: '1-0' }, max: 50 });   // "Save now", then the automatic save
  assert.deepStrictEqual(st.data.savedGameIds, ['g6', 'g5', 'g4', 'g3', 'g2', 'g1'], 'in place');
  assert.strictEqual(st.data['game:g3'].result, '1-0');
  await bg.send({ type: 'saveGame', record: rec('g7', 100), max: 5 });           // the cap was lowered
  assert.deepStrictEqual(st.data.savedGameIds, ['g7', 'g6', 'g5', 'g4', 'g3']);
  assert.deepStrictEqual(keysOf(st), ['game:g3', 'game:g4', 'game:g5', 'game:g6', 'game:g7']);
  const list = await bg.send({ type: 'listGames' });
  assert.deepStrictEqual(list.map((g) => g.id), ['g7', 'g6', 'g5', 'g4', 'g3']);
  assert.ok((await bg.send({ type: 'clearGames' })).ok);
  assert.deepStrictEqual(keysOf(st), []);
  assert.deepStrictEqual(st.data.savedGameIds, []);
  assert.deepStrictEqual(await bg.send({ type: 'listGames' }), []);
});

test('saves from two tabs at once are serialised (nothing lost)', async () => {
  const st = makeStorage();
  const bg = makeBackground({ storage: st });
  await Promise.all([1, 2, 3, 4, 5, 6].map((i) => bg.send({ type: 'saveGame', record: rec('t' + i, 80), max: 50 }, { tab: { id: i % 2 } })));
  assert.strictEqual(st.data.savedGameIds.length, 6);
  assert.deepStrictEqual(keysOf(st).length, 6);
});

test('gate: one save with 50 games stored writes 1 game (2.0.3: the whole list)', async () => {
  const st = makeStorage();
  const bg = makeBackground({ storage: st });
  for (let i = 0; i < 50; i++) await bg.send({ type: 'saveGame', record: rec('h' + i, 1500), max: 50 });
  const c0 = { ...st.counts };
  await bg.send({ type: 'saveGame', record: rec('h50', 1500), max: 50 });
  const bytes = st.counts.setBytes - c0.setBytes;
  const old = JSON.stringify({ savedGames: CV.pgn.mergeSaved(Array.from({ length: 50 }, (_, i) => rec('h' + (49 - i), 1500)), rec('h50', 1500), { max: 50 }) }).length;
  if (process.env.SHOW) console.log({ bytes, old, removes: st.counts.remove - c0.remove });
  assert.ok(bytes < 2600 && old > 70000, bytes + ' vs ' + old);
  assert.strictEqual(st.counts.remove - c0.remove, 1, 'the oldest game key fell out');
});

test('migration: the 2.0.3 list becomes keys + index, then the list is removed; idempotent', async () => {
  const st = makeStorage();
  st.data.savedGames = [rec('m3', 10), rec('m2', 10), rec('m1', 10)];
  st.data.maxSavedGames = 50;
  const bg = makeBackground({ storage: st });
  await sleep(30);
  assert.ok(!('savedGames' in st.data));
  assert.deepStrictEqual(st.data.savedGameIds, ['m3', 'm2', 'm1']);
  assert.deepStrictEqual(keysOf(st), ['game:m1', 'game:m2', 'game:m3']);
  assert.deepStrictEqual((await bg.send({ type: 'listGames' })).map((g) => g.id), ['m3', 'm2', 'm1']);
  const snap = JSON.stringify(st.data), sets = st.counts.set;
  const bg2 = makeBackground({ storage: st });                    // the next start: nothing to do
  await sleep(30);
  assert.strictEqual(JSON.stringify(st.data), snap);
  assert.strictEqual(st.counts.set, sets);
  assert.deepStrictEqual((await bg2.send({ type: 'listGames' })).map((g) => g.id), ['m3', 'm2', 'm1']);
});

test('migration interrupted: the old list stays until the copy is complete; a new game saved meanwhile stays first', async () => {
  const st = makeStorage();
  st.data.savedGames = [rec('a3', 10), rec('a2', 10), rec('a1', 10)];
  // the background stops after its set() and before the old list is removed: remove() fails this time
  const realRemove = st.local.remove;
  st.local.remove = async () => { throw new Error('interrupted'); };
  const bg = makeBackground({ storage: st });
  await sleep(30);
  assert.ok(Array.isArray(st.data.savedGames), 'the old list is kept');
  assert.ok((await bg.send({ type: 'aggroDebug' })).savedGames.migrateError);
  // a game saved now (the next save retries the migration, which fails again) still lands under its key, in front
  st.data.savedGames = [rec('a3', 10), rec('a2', 10), rec('a1', 10)];
  await bg.send({ type: 'saveGame', record: rec('a4', 10), max: 50 });
  assert.strictEqual(st.data.savedGameIds[0], 'a4');
  assert.deepStrictEqual((await bg.send({ type: 'listGames' })).map((g) => g.id), ['a4', 'a3', 'a2', 'a1'], 'old and new, no duplicates');
  st.local.remove = realRemove;
  // half-way state of another kind: some keys written, the index short, the old list still there
  delete st.data['game:a1'];
  st.data.savedGameIds = ['a4', 'a3'];
  makeBackground({ storage: st });                                 // the next start completes it
  await sleep(30);
  assert.ok(!('savedGames' in st.data));
  assert.deepStrictEqual(st.data.savedGameIds, ['a4', 'a3', 'a2', 'a1']);
  assert.deepStrictEqual(keysOf(st), ['game:a1', 'game:a2', 'game:a3', 'game:a4']);
  // a copy that does not read back keeps the old list
  const st2 = makeStorage();
  st2.data.savedGames = [rec('b1', 10)];
  const realSet = st2.local.set;
  st2.local.set = async (o) => { const c = { ...o }; delete c['game:b1']; return realSet(c); };   // the game key is lost
  makeBackground({ storage: st2 });
  await sleep(30);
  assert.ok(Array.isArray(st2.data.savedGames) && st2.data.savedGames.length === 1, 'kept: the copy was incomplete');
});

test('an empty or broken 2.0.3 list is removed; a page without storage changes nothing', async () => {
  const st = makeStorage();
  st.data.savedGames = 'garbage';
  makeBackground({ storage: st });
  await sleep(30);
  assert.ok(!('savedGames' in st.data));
  assert.deepStrictEqual(st.data.savedGameIds, []);
});

run();
