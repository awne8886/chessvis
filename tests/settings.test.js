// Settings (settings.js): the 2.0.0 keys are sanitized, exported and imported like every other key.
'use strict';
const assert = require('node:assert');
const { load, runner } = require('./_load');
const CV = load('humanize.js');
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

test('2.0.5: up to 7 ponder workers, still capped at cores - 1; delays may be 0', () => {
  assert.deepStrictEqual(CV.LIMITS.aggroPonderWorkers, [1, 7, 1]);
  assert.deepStrictEqual(CV.LIMITS.sfPonderWorkers, [1, 7, 1]);
  assert.strictEqual(CV.ponderWorkerCount(7, 8), 7);       // 8 cores (e.g. Dimensity 9500)
  assert.strictEqual(CV.ponderWorkerCount(7, 4), 3);       // 4 cores: unchanged from 2.0.4
  assert.strictEqual(CV.ponderWorkerCount(9, 16), 7);
  assert.strictEqual(CV.ponderWorkerCount(7, undefined), 1);
  assert.deepStrictEqual(CV.sanitize({ minDelay: 0, maxDelay: 0, quickMinDelay: 0, quickMaxDelay: 0 }), { minDelay: 0, maxDelay: 0, quickMinDelay: 0, quickMaxDelay: 0 });
  const cfg = { ...CV.DEFAULTS, minDelay: 0, maxDelay: 0, quickMinDelay: 0, quickMaxDelay: 0 };
  for (let i = 0; i < 200; i++) {
    assert.strictEqual(CV.human.delayFor(cfg, {}), 0);
    assert.strictEqual(CV.human.delayFor(cfg, { fastReply: true }), 0);
  }
});

test('2.0.5: the Stockfish ranking covers the moves the deepening passes use', () => {
  assert.strictEqual(CV.sfRankLines(8, 1), 8);             // 1-4 workers: 8 lines, as before
  assert.strictEqual(CV.sfRankLines(8, 4), 8);
  assert.strictEqual(CV.sfRankLines(8, 6), 12);
  assert.strictEqual(CV.sfRankLines(8, 7), 14);
  assert.strictEqual(CV.sfRankLines(8, 20), 14);
  for (let w = 1; w <= 7; w++) assert.ok(CV.sfRankLines(8, w) >= Math.min(CV.SF_RANK_LINES_MAX, Math.max(2, 2 * w)));
});

test('2.0.6: sfThreads 1-7 (capped at cores - 1, 1 without SharedArrayBuffer), sfHashMb 16-256 default 32, export / import', () => {
  assert.deepStrictEqual(CV.LIMITS.sfThreads, [1, 7, 1]);
  assert.deepStrictEqual(CV.LIMITS.sfHashMb, [16, 256, 16]);
  assert.strictEqual(CV.DEFAULTS.sfThreads, 1, '2.0.5 default');
  assert.strictEqual(CV.DEFAULTS.sfHashMb, 32, '2.0.5 hash');
  assert.strictEqual(CV.sfThreadCount(7, 8, true), 7);
  assert.strictEqual(CV.sfThreadCount(7, 4, true), 3, 'a 4-core device: 3 at most');
  assert.strictEqual(CV.sfThreadCount(9, 16, true), 7);
  assert.strictEqual(CV.sfThreadCount(7, 8, false), 1, 'no SharedArrayBuffer');
  assert.strictEqual(CV.sfThreadCount(4, undefined, true), 1, 'unknown CPU count');
  assert.deepStrictEqual(CV.sanitize({ sfHashMb: 999, sfThreads: 9 }), { sfHashMb: 256, sfThreads: 7 });
  assert.deepStrictEqual(CV.sanitize({ sfHashMb: 1 }), { sfHashMb: 16 });
  assert.deepStrictEqual(CV.sanitize({ sfHashMb: 100 }), { sfHashMb: 96 });
  const r = CV.importSettings(CV.exportSettings({ ...CV.DEFAULTS, sfHashMb: 128, sfThreads: 6 }));
  assert.ok(r.ok && r.values.sfHashMb === 128 && r.values.sfThreads === 6);
});

test('2.0.6: the threaded builds to try: relaxed SIMD first, then npm; failures and CV.SF_THREADED_RSIMD = false', () => {
  assert.strictEqual(CV.SF_THREADED_RSIMD, true);
  assert.deepStrictEqual(CV.sfThreadedCandidates({ relaxedOk: true }), ['rsimd', 'npm']);
  assert.deepStrictEqual(CV.sfThreadedCandidates({ relaxedOk: false }), ['npm']);
  assert.deepStrictEqual(CV.sfThreadedCandidates({ relaxedOk: true, failed: { rsimd: true } }), ['npm']);
  assert.deepStrictEqual(CV.sfThreadedCandidates({ relaxedOk: true, failed: { npm: true } }), []);
  assert.deepStrictEqual(CV.sfThreadedCandidates(), ['npm']);
  CV.SF_THREADED_RSIMD = false;
  try { assert.deepStrictEqual(CV.sfThreadedCandidates({ relaxedOk: true }), ['npm'], '2.0.5'); } finally { CV.SF_THREADED_RSIMD = true; }
  assert.strictEqual(CV.SF_MAIN_WAIT_STOP_MS, 0);
});

// PONDER_STATS (temporary) begin
test('2.0.6: the ponder-stats keys (temporary) are not settings', () => {
  assert.strictEqual(CV.PONDER_STATS, true);
  assert.ok(CV.isPonderStatsKey('ponderStats') && CV.isPonderStatsKey('ponderStats:g12') && !CV.isPonderStatsKey('ponderStatsX') && !CV.isPonderStatsKey('sfHashMb'));
  assert.deepStrictEqual(CV.sanitize({ ponderStats: { v: 1 } }), {});
});
// PONDER_STATS (temporary) end

run();
