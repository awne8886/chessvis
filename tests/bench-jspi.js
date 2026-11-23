// Benchmark (not a test, 2.0.2 A7): the interruptible AggroChess search in headless Chromium (JSPI is on there), through
// the preinstalled Playwright. Serves the repository on 127.0.0.1 and measures:
//   1. polling overhead: nodes per second of think(1000) with js_poll as a WebAssembly.Suspending import (one
//      MessageChannel round trip every 8 ms) and the search exports wrapped by WebAssembly.promising, against a plain
//      synchronous js_poll, same binary, interleaved (gate: at most 2% fewer nodes per second);
//   2. stop latency through the real engine/aggro-worker.js in a Worker: time from posting { type: 'stop', id } to the
//      bestmove reply of a running think(5000) (gate: median at most 15 ms);
//   3. smoke: the Stockfish builds start through engine/sf-worker.js with a shared Module in a browser Worker.
//
//   node tests/bench-jspi.js [--rounds 3] [--stops 20] [--wasm engine/aggrochess-simd.wasm] [--json]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const { BENCH_FENS } = require('./_aggro-wasm');

const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>jspi</title>'); return; }
    const file = path.join(ROOT, url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { console.error('needs the preinstalled Playwright (require("playwright"))'); process.exit(2); }
  const server = await serve();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (m) => { if (process.env.SHOW) console.log('[page]', m.text()); });
  await page.goto(base + '/');
  const wasm = opt('--wasm', 'engine/aggrochess-simd.wasm');
  const res = await page.evaluate(async ({ wasm, fens, rounds, stops }) => {
    const out = { jspi: typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function', version: navigator.userAgent };
    const bytes = await (await fetch('/' + wasm)).arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    const enc = new TextEncoder(), dec = new TextDecoder();
    // ---- 1. overhead: the same engine, sync js_poll vs the JSPI import ----
    const ch = new MessageChannel(); let tickR = null; ch.port1.onmessage = () => { const r = tickR; tickR = null; r && r(); };
    const tick = () => new Promise((r) => { tickR = r; ch.port2.postMessage(0); });
    let polls = 0;
    const make = (jspi) => {
      const env = { js_now: () => performance.now(), js_random: () => Math.random(),
        js_poll: jspi ? new WebAssembly.Suspending(async () => { polls++; await tick(); return 0; }) : () => { polls++; return 0; } };
      const ex = new WebAssembly.Instance(module, { env }).exports;
      const w = (s) => { const b = enc.encode(s); new Uint8Array(ex.memory.buffer, ex.io_ptr(), b.length).set(b); return b.length; };
      const r = (n) => dec.decode(new Uint8Array(ex.memory.buffer, ex.io_ptr(), n).slice());
      const think = jspi ? WebAssembly.promising(ex.think) : ex.think;
      return { ex, w, r, think };
    };
    const knps = { sync: [], jspi: [] }, pollsPerSec = { sync: [], jspi: [] };
    for (let round = 0; round < rounds; round++) {
      for (const mode of ['sync', 'jspi']) {
        const e = make(mode === 'jspi');
        e.ex.set_tt_mb(32); e.ex.set_position(e.w(fens[0] + '|')); await e.think(30);
        let nodes = 0, ms = 0; polls = 0;
        for (const f of fens) {
          e.ex.clear_hash(); e.ex.set_position(e.w('')); e.ex.set_position(e.w(f + '|'));
          const t0 = performance.now();
          const o = e.r(await e.think(1000)).split(' ');
          const dt = performance.now() - t0;
          if (o[2] === 'book') continue;
          nodes += +((/ nodes (\d+)/.exec(e.r(e.ex.last_info())) || [0, 0])[1]); ms += dt;
        }
        knps[mode].push(nodes / ms); pollsPerSec[mode].push(1000 * polls / ms);
      }
    }
    out.knps = knps; out.pollsPerSec = pollsPerSec;
    // ---- 2. stop latency through the real worker ----
    const worker = new Worker('/engine/aggro-worker.js');
    const msgs = []; let waiter = null;
    worker.onmessage = (e) => { msgs.push(e.data); if (waiter && waiter.test(e.data)) { const w = waiter; waiter = null; w.resolve(e.data); } };
    const until = (test) => new Promise((resolve) => { const hit = msgs.find(test); if (hit) resolve(hit); else waiter = { test, resolve }; });
    worker.postMessage({ type: 'init', module, file: wasm.split('/').pop(), ttMb: 32 });
    out.ready = await until((m) => m.type === 'ready');
    const lat = [], depths = [];
    for (let i = 1; i <= stops; i++) {
      const fen = fens[i % fens.length];
      worker.postMessage({ type: 'think', id: i, fen, moves: [], ms: 5000 });
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 450));
      const t0 = performance.now();
      worker.postMessage({ type: 'stop', id: i });
      const reply = await until((m) => m.id === i);
      lat.push(performance.now() - t0); depths.push(reply.depth + (reply.stopped ? '' : '!'));
    }
    worker.terminate();
    out.stopLatency = lat; out.stopDepths = depths;
    // ---- 3. Stockfish through sf-worker.js with a shared module ----
    out.stockfish = [];
    for (const loader of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single-rsimd.js']) {
      const wasmUrl = location.origin + '/engine/' + loader.replace(/\.js$/, '.wasm');
      const sfModule = await WebAssembly.compileStreaming(fetch(wasmUrl));
      const sw = new Worker('/engine/sf-worker.js#' + encodeURIComponent(wasmUrl) + ',worker');
      const lines = []; let w2 = null;
      sw.onmessage = (e) => { if (typeof e.data !== 'string') return; lines.push(e.data); if (w2 && w2.re.test(e.data)) { const w = w2; w2 = null; w.resolve(e.data); } };
      const wait = (re) => new Promise((resolve) => { const hit = lines.find((l) => re.test(l)); if (hit) resolve(hit); else w2 = { re, resolve }; });
      sw.postMessage({ type: 'sfinit', module: sfModule, loader });
      sw.postMessage('uci'); await wait(/^uciok/);
      sw.postMessage('isready'); await wait(/^readyok/);
      sw.postMessage('position fen ' + fens[0]);
      const t0 = performance.now(); sw.postMessage('go movetime 1000'); const best = await wait(/^bestmove/); const ms = performance.now() - t0;
      const info = lines.filter((l) => l.startsWith('info depth') && / pv /.test(l)).pop() || '';
      out.stockfish.push({ loader, shared: lines.some((l) => /via shared module/.test(l)), best, knps: Math.round(+((/ nodes (\d+)/.exec(info) || [0, 0])[1]) / ms), depth: +((/ depth (\d+)/.exec(info) || [0, 0])[1]) });
      sw.terminate();
    }
    return out;
  }, { wasm, fens: BENCH_FENS, rounds: Number(opt('--rounds', 3)), stops: Number(opt('--stops', 20)) });
  await browser.close(); server.close();
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const sync = median(res.knps.sync), jspi = median(res.knps.jspi);
  const summary = {
    chromium: res.version.replace(/^.*(HeadlessChrome|Chrome)\/(\S+).*$/, '$1 $2'), jspi: res.jspi, workerReady: res.ready,
    knpsSync: Math.round(sync), knpsJspi: Math.round(jspi), overheadPct: +(100 * (1 - jspi / sync)).toFixed(1),
    knpsRounds: { sync: res.knps.sync.map(Math.round), jspi: res.knps.jspi.map(Math.round) }, pollsPerSecJspi: Math.round(median(res.pollsPerSec.jspi)),
    stopLatencyMedianMs: +median(res.stopLatency).toFixed(1), stopLatencyMaxMs: +Math.max(...res.stopLatency).toFixed(1), stopDepths: res.stopDepths.join(' '),
    stockfish: res.stockfish,
  };
  console.log(args.includes('--json') ? JSON.stringify(summary, null, 2) : summary);
}
main().catch((e) => { console.error(e); process.exit(1); });
