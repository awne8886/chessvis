// 2.0.2: engine/aggro-worker.js with the real engine in a worker-like vm context (Node has no JSPI, so this is the
// non-interruptible path; the JSPI path is measured in Chromium by tests/bench-jspi.js). Requests are queued and
// answered in order; a 'stop' without JSPI changes nothing.
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runner, ROOT } = require('./_load');
const { test, run } = runner('aggro-worker');

function worker(file) {
  const msgs = [];
  let waiters = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder, URL, WebAssembly, Math, MessageChannel,
    location: { href: 'file://' + path.join(ROOT, 'engine', 'aggro-worker.js') },
    fetch: async (u) => ({ arrayBuffer: async () => fs.readFileSync(new URL(String(u)).pathname) }),
    postMessage: (m) => { msgs.push(m); waiters = waiters.filter((w) => { if (w.test(m)) { clearTimeout(w.timer); w.resolve(m); return false; } return true; }); },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'engine', 'aggro-worker.js'), 'utf8'), ctx, { filename: 'aggro-worker.js' });
  const send = (m) => ctx.onmessage({ data: m });
  const until = (test, ms = 15000) => new Promise((resolve, reject) => {
    const hit = msgs.find(test);
    if (hit) { resolve(hit); return; }
    const w = { test, resolve };
    w.timer = setTimeout(() => reject(new Error('timeout; last: ' + JSON.stringify(msgs.slice(-2)))), ms);
    waiters.push(w);
  });
  send({ type: 'init', module: new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'engine', file))), file, ttMb: 16 });
  return { send, until, msgs, ctx };
}

test('starts (module, warm-up), not interruptible without JSPI', async () => {
  const w = worker('aggrochess-simd.wasm');
  const r = await w.until((m) => m.type === 'ready');
  assert.strictEqual(r.how, 'module');
  assert.strictEqual(r.interruptible, false);
  assert.ok(r.warmMs >= 0 && r.steps === true);
  w.ctx.setTimeout = null;     // nothing else to do
});

test('queued requests are answered in order; analyze honours a floor; think answers as before', async () => {
  const w = worker('aggrochess.wasm');
  await w.until((m) => m.type === 'ready');
  const t0 = performance.now();
  w.send({ type: 'position', id: 1, moves: ['e2e4', 'e7e5'] });
  w.send({ type: 'analyze', id: 2, moves: ['e2e4', 'e7e5', 'g1f3'], ms: 5, floor: 3, next: 'b8c6' });
  w.send({ type: 'think', id: 3, fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', moves: [], ms: 60 });
  w.send({ type: 'stop' });                                     // before the think started: not for it
  w.send({ type: 'ponderMove', id: 4, moves: ['e2e4', 'e7e5'] });
  const think = await w.until((m) => m.id === 3);
  const order = w.msgs.filter((m) => m.id).map((m) => m.id);
  await w.until((m) => m.id === 4);
  assert.deepStrictEqual(order.slice(0, 3), [1, 2, 3]);
  const pos = w.msgs.find((m) => m.id === 1), an = w.msgs.find((m) => m.id === 2);
  assert.ok(pos.ok && pos.legal.length === 29 && pos.stm === 'w');
  assert.ok(an.type === 'analysis' && an.bestUci && an.book === true && an.stopped === false, JSON.stringify(an));
  assert.ok(think.type === 'bestmove' && think.uci && think.depth > 0 && think.stopped === false, JSON.stringify(think));
  assert.ok(performance.now() - t0 >= 60, 'the think ran its time');
});

test('a stop for a request that is still queued ends that search at its first poll (also without JSPI)', async () => {
  const w = worker('aggrochess-simd.wasm');
  await w.until((m) => m.type === 'ready');
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  w.send({ type: 'think', id: 1, fen, moves: [], ms: 100 });
  w.send({ type: 'think', id: 2, fen, moves: [], ms: 3000 });
  w.send({ type: 'stop', id: 2 });
  const t0 = performance.now();
  const a = await w.until((m) => m.id === 1), b = await w.until((m) => m.id === 2);
  assert.strictEqual(a.stopped, false);
  assert.ok(b.stopped === true && b.uci, JSON.stringify(b));
  assert.ok(performance.now() - t0 < 1500, 'not the 3 s think: ' + Math.round(performance.now() - t0));
});

run();
