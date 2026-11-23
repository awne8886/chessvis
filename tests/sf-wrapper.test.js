// 2.0.2 (B1): the Stockfish builds start through engine/sf-worker.js with a WebAssembly.Module compiled once (as
// background.js does), in a worker-like vm context (self, importScripts, fetch, postMessage). Real engines: a depth-8
// search must give the same bestmove and node count with the plain and the relaxed-SIMD build, and the relaxed build is
// only offered when the probe module validates.
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runner, ROOT } = require('./_load');
const { test, run } = runner('sf-wrapper');

// A worker-like context running engine/sf-worker.js; returns { send, lines, until }.
function sfWorker(loaderFile, module) {
  const wasmUrl = 'file://' + path.join(ROOT, 'engine', loaderFile.replace(/\.js$/, '.wasm'));
  const lines = [];
  let waiters = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, performance, TextDecoder, TextEncoder, URL, WebAssembly, Response, Headers, ReadableStream,
    location: { href: 'file://' + path.join(ROOT, 'engine', 'sf-worker.js') + '#' + encodeURIComponent(wasmUrl) + ',worker', hash: '#' + encodeURIComponent(wasmUrl) + ',worker' },
    fetch: async (u) => new Response(fs.readFileSync(new URL(String(u)).pathname), { status: 200, headers: { 'content-type': 'application/wasm' } }),
    postMessage: (m) => { if (typeof m !== 'string') return; lines.push(m); waiters = waiters.filter((w) => { if (w.re.test(m)) { clearTimeout(w.timer); w.resolve(m); return false; } return true; }); },
    importScripts: (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'engine', f), 'utf8'), ctx, { filename: f }),
  };
  ctx.self = ctx; ctx.globalThis = ctx; ctx.WorkerGlobalScope = function WorkerGlobalScope() {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'engine', 'sf-worker.js'), 'utf8'), ctx, { filename: 'sf-worker.js' });
  const send = (m) => ctx.onmessage({ data: m });
  const until = (re, ms = 20000) => new Promise((resolve, reject) => {
    const hit = lines.find((l) => re.test(l));
    if (hit) { resolve(hit); return; }
    const w = { re, resolve };
    waiters.push(w);
    w.timer = setTimeout(() => reject(new Error('timeout waiting for ' + re + '; last lines: ' + lines.slice(-3).join(' | '))), ms);
  });
  send({ type: 'sfinit', module, loader: loaderFile });
  return { send, lines, until };
}

async function depth8(loaderFile) {
  const module = new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'engine', loaderFile.replace(/\.js$/, '.wasm'))));
  const w = sfWorker(loaderFile, module);
  w.send('uci'); await w.until(/^uciok/);
  w.send('isready'); await w.until(/^readyok/);
  w.send('position fen r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  w.send('go depth 8');
  const best = await w.until(/^bestmove/);
  const info = w.lines.filter((l) => /^info depth 8 /.test(l) && / pv /.test(l)).pop() || '';
  return { best, nodes: +((/ nodes (\d+)/.exec(info) || [0, 0])[1]), shared: w.lines.some((l) => /sf-worker: wasm via shared module/.test(l)), id: w.lines.find((l) => l.startsWith('id name')) };
}

const RSIMD = 'stockfish-19-lite-single-rsimd.js';
const haveRsimd = fs.existsSync(path.join(ROOT, 'engine', RSIMD));

test('plain build starts through the wrapper with the shared Module', async () => {
  const r = await depth8('stockfish-19-lite-single.js');
  assert.ok(r.shared, 'the shared module was used');
  assert.ok(/^bestmove \S+/.test(r.best) && r.nodes > 0, r.best + ' ' + r.nodes);
});

test('relaxed-SIMD build: starts the same way and searches the same tree', async () => {
  if (!haveRsimd) return;
  const a = await depth8('stockfish-19-lite-single.js'), b = await depth8(RSIMD);
  assert.ok(b.shared, 'the shared module was used');
  assert.strictEqual(b.best, a.best);
  assert.strictEqual(b.nodes, a.nodes);
});

test('RELAXED_PROBE: background.js offers the relaxed build only where the probe validates', () => {
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const m = /const RELAXED_PROBE = new Uint8Array\(\[([^\]]+)\]\)/.exec(src);
  assert.ok(m, 'RELAXED_PROBE in background.js');
  const probe = new Uint8Array(m[1].split(',').map(Number));
  assert.strictEqual(WebAssembly.validate(probe), true, 'Node / V8 has relaxed SIMD');
  // the same module with the relaxed opcode replaced by a plain SIMD one (i32x4.add, 0xfd 0xae 0x01 + a drop of one operand)
  // is valid too, and an unknown opcode is not: the probe tests exactly the relaxed instruction
  const bad = probe.slice(); const i = bad.findIndex((x, k) => x === 0xfd && bad[k + 1] === 0x93 && bad[k + 2] === 0x02);
  assert.ok(i > 0, 'the probe uses i32x4.relaxed_dot_i8x16_i7x16_add_s');
  bad[i + 1] = 0xff; bad[i + 2] = 0x7f;
  assert.strictEqual(WebAssembly.validate(bad), false);
  if (haveRsimd) assert.strictEqual(WebAssembly.validate(fs.readFileSync(path.join(ROOT, 'engine', RSIMD.replace(/\.js$/, '.wasm')))), true);
});

run();
