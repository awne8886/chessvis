'use strict';
const api = typeof browser !== 'undefined' ? browser : chrome;

// ======================= Stockfish (UCI, asm.js) =======================
const SF_FILE = 'engine/stockfish-19-asm.js';
let sf = null, sfReady = null, sfCurrent = null, sfNext = null;

function initStockfish() {
  sf = new Worker(api.runtime.getURL(SF_FILE));
  sfReady = new Promise((resolve) => {
    sf.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (line === 'readyok') resolve();
      else if (line.startsWith('bestmove')) sfBestMove(line.split(' ')[1]);
    };
    sf.onerror = (e) => console.error('[ChessVision] Stockfish error', e.message);
  });
  sf.postMessage('uci');
  sf.postMessage('isready');
}

function sfStart(job) {
  sfCurrent = job;
  sf.postMessage('ucinewgame');
  sf.postMessage('position fen ' + job.fen);
  sf.postMessage('go depth ' + job.depth);
}

function sfBestMove(move) {
  const job = sfCurrent;
  sfCurrent = null;
  if (sfNext) {
    const n = sfNext;
    sfNext = null;
    if (job) job.resolve(null); // superseded
    sfStart(n);
  } else if (job) {
    job.resolve({ uci: move });
  }
}

async function analyzeStockfish(fen, depth) {
  await sfReady;
  return new Promise((resolve) => {
    const job = { fen, resolve, depth: Math.max(1, Math.min(20, depth || 10)) };
    if (sfCurrent) {
      if (sfNext) sfNext.resolve(null);
      sfNext = job;
      sf.postMessage('stop');
    } else {
      sfStart(job);
    }
  });
}

// ======================= AggroChess (WebAssembly, Tal-style) =======================
const AGGRO_WORKER = 'engine/aggro-worker.js';
let aggro = null, aggroReady = null, aggroSeq = 0;
const aggroPending = new Map(); // id -> resolve

function initAggro() {
  aggro = new Worker(api.runtime.getURL(AGGRO_WORKER));
  aggroReady = new Promise((resolve) => {
    aggro.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') return resolve();
      if (m.type === 'error') console.error('[ChessVision] AggroChess error', m.message);
      const done = aggroPending.get(m.id);
      if (!done) return;
      aggroPending.delete(m.id);
      if (m.type === 'bestmove' && m.uci) done({ uci: m.uci, san: m.san, sacrifice: m.sacrifice });
      else done(null);
    };
    aggro.onerror = (e) => console.error('[ChessVision] AggroChess worker error', e.message);
  });
}

async function analyzeAggro(fen, ms) {
  await aggroReady;
  // Drop older requests: their results would be stale anyway
  for (const [id, done] of aggroPending) { aggroPending.delete(id); done(null); }
  const id = ++aggroSeq;
  return new Promise((resolve) => {
    aggroPending.set(id, resolve);
    // "<fen>|" = set-up position with no move list
    aggro.postMessage({ type: 'think', id, fen, moves: [], ms: Math.max(100, ms || 1000) });
  });
}

// ======================= Messaging =======================
api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'analyze') return;
  return msg.engine === 'stockfish'
    ? analyzeStockfish(msg.fen, msg.depth)
    : analyzeAggro(msg.fen, msg.ms);
});

initStockfish();
initAggro();
