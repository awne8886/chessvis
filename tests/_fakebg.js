// Test helper: runs the REAL background.js (with settings.js + chessmini.js) in a vm context with a fake browser API and
// fake engine workers, so the ponder / search logic can be simulated without a browser or an engine.
// Fake Stockfish: a UCI speaker whose search completes one depth every `stepMs` ms; its best move in any position is the
// first legal move in sorted order, its PV continues that way, MultiPV lines rank the sorted legal moves.
// Fake AggroChess: answers think after the requested ms with the same "best" move and depth = ms / 10; 'ready' comes
// opts.aggroStartMs after init (instantiate + warm-up of a real worker: ~30-60 ms in Node).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load, ROOT } = require('./_load');
const CV = load();

const best = (pos) => { const l = CV.chess.legalMoves(pos).map((m) => m.uci).sort(); return l[0] || null; };
const sortedLegal = (pos) => CV.chess.legalMoves(pos).map((m) => m.uci).sort();
function pvFrom(pos, n) {
  const pv = [];
  for (let i = 0; i < n; i++) { const b = best(pos); if (!b) break; pv.push(b); pos = CV.applyUci(pos, b).pos; }
  return pv;
}

function makeBackground(opts = {}) {
  const stepMs = opts.stepMs || 10;          // fake Stockfish: ms per depth
  const workers = [];
  const log = [];                            // every UCI command sent to a Stockfish worker: { w, cmd }
  class FakeWorker {
    constructor(url) {
      this.url = String(url); this.kind = /aggro/.test(this.url) ? 'aggro' : 'sf'; this.dead = false; this.id = workers.length;
      this.pos = null; this.search = null; this.multipv = 1; this.msgs = [];
      workers.push(this);
    }
    emit(data) { if (!this.dead && this.onmessage) this.onmessage({ data }); }
    postMessage(m) { if (this.dead) return; setTimeout(() => { if (!this.dead) this.handle(m); }, 0); }
    terminate() { this.dead = true; if (this.search) { clearTimeout(this.search.timer); clearTimeout(this.search.mt); } }
    handle(m) { if (this.kind === 'sf') this.sf(m); else this.aggro(m); }
    sf(m) {
      if (m && m.type === 'sfinit') {                       // 2.0.2: only with opts.wasm (a fake WebAssembly); which loader it was given
        this.init = m;
        if (opts.wasm && opts.wasm.failRsimd && /rsimd/.test(m.loader)) setTimeout(() => this.onerror && this.onerror({ message: 'fake: relaxed SIMD build failed' }), 1);
        return;
      }
      if (typeof m !== 'string') return;
      log.push({ w: this.id, cmd: m });
      if (m === 'uci') { ['option name Threads type spin default 1 min 1 max 1', 'option name Hash type spin default 16 min 1 max 1024', 'option name MultiPV type spin default 1 min 1 max 256', 'uciok'].forEach((l) => this.emit(l)); }
      else if (m === 'isready') this.emit('readyok');
      else if (m.startsWith('setoption name MultiPV value ')) this.multipv = +m.split(' ').pop();
      else if (m.startsWith('position fen ')) {
        const [fenPart, movesPart] = m.slice('position fen '.length).split(' moves ');
        this.pos = CV.replayUci(fenPart, movesPart ? movesPart.split(' ') : []).pos;
      } else if (m.startsWith('go')) this.go(m);
      else if (m === 'stop') { if (this.search) setTimeout(() => this.finish(), 1); }
    }
    go(cmd) {
      const dMax = +((/depth (\d+)/.exec(cmd) || [])[1] || 64);
      let mt = +((/movetime (\d+)/.exec(cmd) || [])[1] || 0);
      const wt = /wtime (\d+)/.exec(cmd);
      if (wt) mt = Math.round(+wt[1] / 30);
      const pos = this.pos, pv = pvFrom(pos, 4), legal = sortedLegal(pos);
      const s = { d: 0, pv, legal, timer: null, mt: null };
      this.search = s;
      const tick = () => {
        if (this.search !== s) return;
        s.d++;
        const lines = Math.min(this.multipv, Math.max(1, legal.length));
        for (let k = 1; k <= lines; k++) {
          const line = k === 1 ? pv : [legal[k - 1]];
          if (line.length) this.emit('info depth ' + s.d + ' seldepth ' + s.d + ' multipv ' + k + ' score cp ' + (50 - 10 * k) + ' nodes ' + (s.d * 1000) + ' pv ' + line.join(' '));
        }
        if (s.d >= dMax) { this.finish(); return; }
        s.timer = setTimeout(tick, stepMs);
      };
      s.timer = setTimeout(tick, stepMs);
      if (mt > 0) s.mt = setTimeout(() => this.finish(), mt);
    }
    finish() {
      const s = this.search; if (!s) return;
      this.search = null; clearTimeout(s.timer); clearTimeout(s.mt);
      this.emit('bestmove ' + (s.pv[0] || '(none)') + (s.pv[1] ? ' ponder ' + s.pv[1] : ''));
    }
    aggro(m) {
      const posOf = (x) => CV.replayUci(x.fen || CV.STANDARD_START_FEN, x.moves || []).pos;
      this.msgs.push(m.type);                                // 2.0.2: what this AggroChess worker was asked, in order
      if (m.type === 'init') { setTimeout(() => this.emit({ type: 'ready', how: 'module', warmMs: 1, steps: true, interruptible: !!opts.aggroInterruptible }), opts.aggroStartMs || 0); return; }
      if (m.type === 'stop') {                              // 2.0.2: an interruptible worker answers a running think at once
        const t = this.running && this.running.get(m.id);
        if (opts.aggroInterruptible && !opts.aggroIgnoreStop && t) { clearTimeout(t.timer); this.running.delete(m.id); setTimeout(() => t.answer(true), 3); }
        return;
      }
      if (m.type === 'ponderMove') { this.emit({ type: 'ponderMove', id: m.id, uci: best(posOf(m)) || 'none' }); return; }
      if (m.type === 'clear') { this.emit({ type: 'cleared', id: m.id }); return; }
      if (m.type === 'analyze') {
        const b = best(posOf(m));
        setTimeout(() => this.emit(b ? { type: 'analysis', id: m.id, kind: 'cp', value: 0, bestUci: b, bestSan: b, depth: 3 } : { type: 'analysis', id: m.id, none: true }), Math.min(m.ms, 20));
        return;
      }
      if (m.type === 'think') {
        const ms = m.soft || m.ms;
        const b = best(posOf(m));
        this.thinks = (this.thinks || 0) + 1;
        const t0 = Date.now();
        const answer = (stopped) => this.emit({ type: 'bestmove', id: m.id, uci: b, san: b, score: '0', depth: Math.max(1, Math.floor((stopped ? Date.now() - t0 : ms) / 10)), sacrifice: false, stopped });
        this.running = this.running || new Map();
        const t = { answer, timer: setTimeout(() => { this.running.delete(m.id); answer(false); }, ms) };
        this.running.set(m.id, t);
      }
    }
  }
  let handler = null;
  // opts.wasm (2.0.2): a fake WebAssembly + fetch, so the Stockfish build choice (relaxed SIMD probe, shared module) runs;
  // { relaxed: validate() answer for the relaxed probe, failRsimd: the relaxed build's worker fails to start }
  const fakeWasm = opts.wasm ? {
    WebAssembly: { validate: (b) => (b.length === 37 ? !!opts.wasm.relaxed : true), compileStreaming: async () => ({ fake: 'module' }), compile: async () => ({ fake: 'module' }), Module: function Module() {} },
    fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
  } : {};
  const ctx = vm.createContext({
    ...fakeWasm,
    console: opts.quiet === false ? console : { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { hardwareConcurrency: opts.cores || 4 },
    Worker: FakeWorker,
    browser: { runtime: { getURL: (p) => p, onMessage: { addListener(fn) { handler = fn; } } } },
  });
  for (const f of ['settings.js', 'chessmini.js', 'background.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return {
    send: (msg) => Promise.resolve(handler(msg)),
    get: (expr) => vm.runInContext(expr, ctx),
    workers, log, CV, best, pvFrom,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { makeBackground, sleep, CV, best, pvFrom };
