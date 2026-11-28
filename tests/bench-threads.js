// Benchmark (not a test), 2.0.6: the threaded Stockfish builds in headless Chromium (Playwright), on a page served with
// COOP/COEP (crossOriginIsolated, so SharedArrayBuffer and pthreads work as they do on Firefox Nightly with
// dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled). Each engine runs in a Worker started exactly as
// background.js starts it: `<loader>#<encoded .wasm url>,worker`.
//
//   node tests/bench-threads.js [--only nps|load|hash|mem|stopwait] [--json] [--reps N]
//
//   nps       nodes per second, `go movetime 1000`, Threads 1 / 2 / 4 / 7, npm threaded vs relaxed-SIMD threaded
//             (10 bench positions, empty hash before each, median; builds interleaved)
//   load      which .wasm each loader (and its pthread workers) fetched: the rsimd loader must never fetch the plain one
//   hash      depth and nodes of a 1 s and a 2.5 s search, Threads 4, Hash 32 vs 128 (10 middlegame positions of
//             tests/bench-delay-mode.js, empty hash before each)
//   mem       resident memory (sum of the Chromium processes' RSS) of one fresh engine with Threads 4 and Hash 32 / 64 /
//             128 / 256 after a 1 s search, and the engine's own Hash / Threads limits
//   stopwait  2.0.6 (A3): N single-thread ponder workers search; then, as on a `late` / `miss`, every ponder worker gets
//             `stop` + `isready` and the threaded main worker (Threads T) gets `go`, either at once (CV.SF_MAIN_WAIT_STOP_MS
//             0 = 2.0.5) or once every ponder worker answered readyok, at most W ms later. Reports the ponder workers'
//             cancel times (stop -> readyok), how many exceeded the kill limit, and how much later the main `go` was sent.
//
// The container has 4 cores (a phone has 8); Threads 7 there is oversubscribed. Nothing here runs in Firefox.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const reps = args.includes('--reps') ? +args[args.indexOf('--reps') + 1] : 1;
const { BENCH_FENS } = require('./_aggro-wasm');
const MIDDLE = [   // tests/bench-delay-mode.js
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7',
  'rnbqkb1r/pp3ppp/4pn2/2pp4/3P4/2P1PN2/PP3PPP/RNBQKB1R w KQkq - 0 5',
  'r2q1rk1/pp1nbppp/2p1pn2/3p4/2PP4/2N1PN2/PPQ1BPPP/R1B2RK1 w - - 0 9',
  'r1b2rk1/2q1bppp/p2p1n2/np2p3/3PP3/2P2N1P/PPB2PP1/RNBQR1K1 w - - 0 12',
  '2rq1rk1/pp1bppbp/3p1np1/4n3/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 13',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
  'r1bqr1k1/pp1n1ppp/2pb1n2/3p4/3P4/2NBPN2/PPQ2PPP/R1B2RK1 w - - 0 10',
  '3r1rk1/p1q2ppp/1pn1pn2/2p5/2P5/1PNBPN2/P4PPP/2RQ1RK1 w - - 0 15',
];
const NPM = 'engine/stockfish-19-lite.js', RSIMD = 'engine/stockfish-19-lite-rsimd.js', SINGLE = 'engine/stockfish-19-lite-single.js';

// a static server with COOP/COEP; logs every request (the `load` check)
const requests = [];
function serve() {
  const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    requests.push(u);
    const f = u === '/' ? null : path.join(ROOT, path.normalize(u).replace(/^(\.\.[/\\])+/, ''));
    const head = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (!f) { res.writeHead(200, { ...head, 'Content-Type': 'text/html' }); res.end('<!doctype html><title>bench</title>'); return; }
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || u.includes('allowed-pages')) { res.writeHead(404, head); res.end(); return; }
    res.writeHead(200, { ...head, 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// runs in the page: a tiny UCI driver per Worker
const PAGE_LIB = () => {
  window.engines = [];
  window.startEngine = async (loader, opts) => {
    opts = opts || {};
    const wasm = new URL(loader.replace(/\.js$/, '.wasm'), location.href).href;
    const t0 = performance.now();
    const w = new Worker(new URL(loader, location.href).href + '#' + encodeURIComponent(wasm) + ',worker');
    const e = { w, waiters: [], last: null, lines: [], spin: {} };
    w.onmessage = (m) => {
      const l = typeof m.data === 'string' ? m.data : '';
      if (l.startsWith('info depth') && / pv /.test(l) && !/bound/.test(l)) e.last = l;
      const sp = /^option name (\w+) type spin default \S+ min (-?\d+) max (-?\d+)/.exec(l);
      if (sp) e.spin[sp[1]] = [+sp[2], +sp[3]];
      e.waiters = e.waiters.filter((x) => { if (x.re.test(l)) { x.r(l); return false; } return true; });
    };
    w.onerror = (x) => { e.error = String(x.message || x); };
    e.send = (s) => w.postMessage(s);
    e.until = (re) => new Promise((r) => e.waiters.push({ re: new RegExp(re), r }));
    e.ready = async () => { e.send('isready'); await e.until('^readyok'); };
    e.send('uci'); await e.until('^uciok');
    if (opts.threads) e.send('setoption name Threads value ' + opts.threads);
    e.send('setoption name Hash value ' + (opts.hash || 32));
    await e.ready();
    e.startMs = performance.now() - t0;
    window.engines.push(e);
    return window.engines.length - 1;
  };
  window.go = async (i, fen, go, stopMs, fresh) => {
    const e = window.engines[i];
    if (fresh !== false) { e.send('ucinewgame'); await e.ready(); }
    e.last = null;
    e.send('position fen ' + fen);
    const t0 = performance.now();
    const done = e.until('^bestmove');
    e.send(go);
    const timer = stopMs ? setTimeout(() => e.send('stop'), stopMs) : null;
    const line = await done; clearTimeout(timer);
    const ms = performance.now() - t0, l = e.last || '';
    const num = (re) => +((re.exec(l) || [0, 0])[1]);
    return { ms, best: line.split(' ')[1], depth: num(/ depth (\d+)/), nodes: num(/ nodes (\d+)/), nps: num(/ nps (\d+)/) };
  };
  window.quitAll = () => { for (const e of window.engines) { try { e.w.terminate(); } catch (x) { /* ignore */ } } window.engines = []; };
  // A3: ponder workers searching, then stop + isready for all of them and `go` for the main worker
  window.stopOverlap = async (main, ponder, fen, waitMs, killMs) => {
    for (const i of ponder) { const e = window.engines[i]; e.send('position fen ' + fen); e.send('go movetime 20000'); }
    await new Promise((r) => setTimeout(r, 400));
    const m = window.engines[main];
    m.send('ucinewgame'); await m.ready();
    m.send('position fen ' + fen);
    const t0 = performance.now();
    const cancel = ponder.map((i) => {
      const e = window.engines[i];
      const b = e.until('^bestmove');
      e.send('stop');
      return b.then(() => { e.send('isready'); return e.until('^readyok'); }).then(() => performance.now() - t0);
    });
    let goAt;
    if (waitMs > 0) await Promise.race([Promise.all(cancel), new Promise((r) => setTimeout(r, waitMs))]);
    goAt = performance.now() - t0;
    const done = m.until('^bestmove');
    m.send('go movetime 1000');
    const ms = await Promise.all(cancel.map((p) => Promise.race([p, new Promise((r) => setTimeout(() => r(Infinity), killMs))])));
    await done;
    return { cancelMs: ms, goDelayMs: goAt };
  };
};

const median = (a) => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

async function rssMb() {
  const { execSync } = require('child_process');
  const out = execSync('ps -eo rss,comm').toString().split('\n').filter((l) => /chrom|headless_shell/i.test(l));
  return Math.round(out.reduce((n, l) => n + (+l.trim().split(/\s+/)[0] || 0), 0) / 1024);
}

(async () => {
  const { chromium } = require('playwright');
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(base);
  await page.evaluate(PAGE_LIB);
  const env = await page.evaluate(() => ({ coi: crossOriginIsolated, sab: typeof SharedArrayBuffer, cores: navigator.hardwareConcurrency, ua: navigator.userAgent }));
  const res = { env };
  const log = (k, v) => { res[k] = v; if (!args.includes('--json')) console.log(k, JSON.stringify(v, null, 1)); };
  if (!env.coi) throw new Error('page is not crossOriginIsolated');

  if (!only || only === 'load') {
    requests.length = 0;
    const out = {};
    for (const f of [NPM, RSIMD]) {
      requests.length = 0;
      const i = await page.evaluate(([f]) => window.startEngine(f, { threads: 4 }), [f]);
      await page.evaluate(([i, fen]) => window.go(i, fen, 'go movetime 300'), [i, MIDDLE[0]]);
      out[f] = [...new Set(requests.filter((u) => /\.(js|wasm)$/.test(u)))];
      await page.evaluate(() => window.quitAll());
    }
    log('load', out);
  }

  if (!only || only === 'nps') {
    const out = {};
    for (let rep = 0; rep < reps; rep++) {
      for (const t of [1, 2, 4, 7]) {
        for (const f of [NPM, RSIMD]) {           // interleaved
          const i = await page.evaluate(([f, t]) => window.startEngine(f, { threads: t }), [f, t]);
          const k = [];
          for (const fen of BENCH_FENS) { const r = await page.evaluate(([i, fen]) => window.go(i, fen, 'go movetime 1000'), [i, fen]); k.push(r.nodes / r.ms); }
          await page.evaluate(() => window.quitAll());
          (out[t + ' ' + path.basename(f)] = out[t + ' ' + path.basename(f)] || []).push(Math.round(median(k)));
        }
      }
    }
    const table = {};
    for (const t of [1, 2, 4, 7]) {
      const a = median(out[t + ' stockfish-19-lite.js']), b = median(out[t + ' stockfish-19-lite-rsimd.js']);
      table['Threads ' + t] = { npmKnps: a, rsimdKnps: b, gain: Math.round((b / a - 1) * 100) + '%', runs: [out[t + ' stockfish-19-lite.js'], out[t + ' stockfish-19-lite-rsimd.js']] };
    }
    log('nps', table);
  }

  if (!only || only === 'hash') {
    const out = {};
    for (const f of [RSIMD]) {
      for (const hash of [32, 128]) {
        const i = await page.evaluate(([f, h]) => window.startEngine(f, { threads: 4, hash: h }), [f, hash]);
        for (const ms of [1000, 2500]) {
          const d = [], n = [];
          for (const fen of MIDDLE) { const r = await page.evaluate(([i, fen, ms]) => window.go(i, fen, 'go movetime ' + ms), [i, fen, ms]); d.push(r.depth); n.push(r.nodes); }
          out[path.basename(f) + ' Hash ' + hash + ' ' + ms + ' ms'] = { avgDepth: +avg(d).toFixed(2), minDepth: Math.min(...d), medianKnodes: Math.round(median(n) / 1000) };
        }
        await page.evaluate(() => window.quitAll());
      }
    }
    log('hash', out);
  }

  if (!only || only === 'mem') {
    const out = { idleMb: await rssMb() };
    for (const f of [RSIMD]) {
      for (const hash of [32, 64, 128, 256, 512]) {
        const before = await rssMb();
        const i = await page.evaluate(([f, h]) => window.startEngine(f, { threads: 4, hash: h }), [f, hash]);
        await page.evaluate(([i, fen]) => window.go(i, fen, 'go movetime 1000'), [i, MIDDLE[0]]);
        const spin = await page.evaluate(([i]) => ({ spin: window.engines[i].spin, err: window.engines[i].error || null }), [i]);
        const r = await page.evaluate(([i, fen]) => window.go(i, fen, 'go depth 8'), [i, MIDDLE[1]]);
        out['Hash ' + hash] = { rssMb: await rssMb(), deltaMb: (await rssMb()) - before, worked: !!r.best, hashLimit: spin.spin.Hash, threadsLimit: spin.spin.Threads, error: spin.err };
        await page.evaluate(() => window.quitAll());
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    log('mem', out);
  }

  if (!only || only === 'stopwait') {
    const out = {};
    const KILL = 1500;   // SF_STOP_TIMEOUT_MS
    for (const [threads, nPonder] of [[3, 3], [4, 6], [7, 6]]) {
      for (const wait of [0, 40]) {
        const all = [], delays = [];
        for (let rep = 0; rep < Math.max(3, reps); rep++) {
          const main = await page.evaluate(([f, t]) => window.startEngine(f, { threads: t, hash: 32 }), [RSIMD, threads]);
          const ponder = [];
          for (let k = 0; k < nPonder; k++) ponder.push(await page.evaluate(([f]) => window.startEngine(f, { hash: 16 }), [SINGLE]));
          for (const fen of MIDDLE.slice(0, 4)) {
            const r = await page.evaluate(([m, p, fen, w, kill]) => window.stopOverlap(m, p, fen, w, kill), [main, ponder, fen, wait, KILL]);
            all.push(...r.cancelMs); delays.push(r.goDelayMs);
          }
          await page.evaluate(() => window.quitAll());
        }
        const fin = all.filter(Number.isFinite);
        out['main Threads ' + threads + ' + ' + nPonder + ' ponder, wait ' + wait] = { cancels: all.length, overKill: all.length - fin.length,
          cancelMedianMs: Math.round(median(fin)), cancelMaxMs: Math.round(Math.max(...fin)), goDelayMedianMs: Math.round(median(delays)), goDelayMaxMs: Math.round(Math.max(...delays)) };
      }
    }
    log('stopwait', out);
  }

  if (args.includes('--json')) console.log(JSON.stringify(res, null, 1));
  await browser.close();
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
