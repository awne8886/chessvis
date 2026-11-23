// Settings (settings.js): the 2.0.0 keys are sanitized, exported and imported like every other key.
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load();
const { test, run } = runner('settings');

const NEW = { earlyPonder: true, boardDebounceMs: 40, sfSearchMode: 'delay', ponderHitFast: true, ponderUntilMove: true, ponderMaxMs: 8000,
  ponderHitTopUp: true, aggroPonder: true, sfPonder: true };      // 2.0.2: debounce 40 (was 80), top-up, pondering on

test('2.0.2: ponderHitTopUp is a boolean setting that survives export / import; the 2.0.0 values stay reachable', () => {
  assert.deepStrictEqual(CV.sanitize({ ponderHitTopUp: 0, aggroPonder: '', sfPonder: 1, boardDebounceMs: 80 }), { ponderHitTopUp: false, aggroPonder: false, sfPonder: true, boardDebounceMs: 80 });
  const r = CV.importSettings(CV.exportSettings({ ...CV.DEFAULTS, ponderHitTopUp: false, aggroPonder: false, sfPonder: false, boardDebounceMs: 80 }));
  assert.ok(r.ok && r.values.ponderHitTopUp === false && r.values.aggroPonder === false && r.values.sfPonder === false && r.values.boardDebounceMs === 80);
  for (const k of ['AGGRO_PONDER_RECYCLE', 'WATCHDOG_STABLE_READ']) assert.strictEqual(CV[k], true, k);
  assert.strictEqual(CV.AGGRO_SCAN_FLOOR_MS, 3);
});

test('new keys and their defaults', () => {
  for (const [k, v] of Object.entries(NEW)) assert.strictEqual(CV.DEFAULTS[k], v, k);
  assert.deepStrictEqual(CV.LIMITS.boardDebounceMs, [0, 300, 10]);
  assert.deepStrictEqual(CV.LIMITS.ponderMaxMs, [1000, 30000, 500]);
  assert.deepStrictEqual(CV.ENUMS.sfSearchMode, ['depth', 'delay', 'clock']);
});

test('sanitize clamps, rounds and checks the new keys', () => {
  assert.deepStrictEqual(CV.sanitize({ boardDebounceMs: 999 }), { boardDebounceMs: 300 });
  assert.deepStrictEqual(CV.sanitize({ boardDebounceMs: -5 }), { boardDebounceMs: 0 });
  assert.deepStrictEqual(CV.sanitize({ boardDebounceMs: 84 }), { boardDebounceMs: 80 });
  assert.deepStrictEqual(CV.sanitize({ ponderMaxMs: 100 }), { ponderMaxMs: 1000 });
  assert.deepStrictEqual(CV.sanitize({ ponderMaxMs: 99999 }), { ponderMaxMs: 30000 });
  assert.deepStrictEqual(CV.sanitize({ ponderMaxMs: 'x' }), {});
  assert.deepStrictEqual(CV.sanitize({ sfSearchMode: 'clock' }), { sfSearchMode: 'clock' });
  assert.deepStrictEqual(CV.sanitize({ sfSearchMode: 'turbo' }), {});
  assert.deepStrictEqual(CV.sanitize({ earlyPonder: 0, ponderHitFast: 'yes', ponderUntilMove: null }), { earlyPonder: false, ponderHitFast: true, ponderUntilMove: false });
});

test('export / import round trip keeps the new keys (non-default values)', () => {
  const cfg = { ...CV.DEFAULTS, earlyPonder: false, boardDebounceMs: 250, sfSearchMode: 'depth', ponderHitFast: false, ponderUntilMove: false, ponderMaxMs: 12500, enabled: true };
  const text = CV.exportSettings(cfg);
  const exported = JSON.parse(text).settings;
  for (const k of Object.keys(NEW)) assert.ok(k in exported, 'exported: ' + k);
  assert.ok(!('enabled' in exported), 'Auto-play never exported');
  const r = CV.importSettings(text);
  assert.strictEqual(r.ok, true);
  for (const k of Object.keys(NEW)) assert.strictEqual(r.values[k], cfg[k], k);
  assert.deepStrictEqual({ ...CV.DEFAULTS, ...r.values, enabled: true }, cfg);
});

test('the 1.8.0 behaviour is reachable through settings', () => {
  const old = CV.sanitize({ earlyPonder: false, boardDebounceMs: 250, sfSearchMode: 'depth', ponderHitFast: false, ponderUntilMove: false });
  assert.deepStrictEqual(old, { earlyPonder: false, boardDebounceMs: 250, sfSearchMode: 'depth', ponderHitFast: false, ponderUntilMove: false });
  assert.strictEqual(typeof CV.AGGRO_DELAY_MATCH, 'boolean', 'AggroChess pause budget is a constant');
});

run();
