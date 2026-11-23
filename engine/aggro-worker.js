// Runs the AggroChess WebAssembly engine off the main thread so the page never freezes.
'use strict';

let WASM_URL = new URL('aggrochess.wasm', self.location.href);   // init may name another file (the SIMD build)
let TT_MB = 0;                                                    // hash size asked for in init (0 = the engine's own)
const enc = new TextEncoder();
const dec = new TextDecoder();
let ex = null;
let call = null;        // the search exports, as functions returning Promises (JSPI) or plain values

// 2.0.2 (A7): an interruptible search with JSPI (JavaScript Promise Integration). The engine calls env.js_poll() from
// its time check, at most every 8 ms. With WebAssembly.Suspending / WebAssembly.promising (feature-detected), js_poll
// suspends the search for one MessageChannel round trip, so this worker's event loop runs meanwhile: a { type: 'stop' }
// message sets stopFlag and the next poll ends the search with the best move of its last completed iteration. Every
// other message waits in `queue`, so nothing re-enters the engine while a search is suspended. Without JSPI js_poll
// answers 0 at once and a search runs to its time limit as before (the worker reports interruptible: false).
let stopFlag = false;
let currentId = null;                                   // the request being searched now
const stopIds = new Set();                              // requests still waiting in the queue that were stopped already
let jspi = typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function' &&
    typeof MessageChannel === 'function';
let tickResolve = null, tickChannel = null;
const tick = () => new Promise((resolve) => {
    if (!tickChannel) { tickChannel = new MessageChannel(); tickChannel.port1.onmessage = () => { const r = tickResolve; tickResolve = null; if (r) r(); }; }
    tickResolve = resolve;
    tickChannel.port2.postMessage(0);
});
const SEARCH_EXPORTS = ['think', 'think_clock', 'think_depth', 'think_floor', 'analyze', 'analyze_floor'];

let imports = null;
function makeImports() {
    imports = {
        env: {
            js_now: () => performance.now(),
            js_random: () => Math.random(),
            js_poll: jspi ? new WebAssembly.Suspending(async () => { await tick(); return stopFlag ? 1 : 0; }) : () => (stopFlag ? 1 : 0),
        },
    };
}
function bindExports(instance) {
    ex = instance.exports;
    call = {};
    for (const n of SEARCH_EXPORTS) {
        if (typeof ex[n] !== 'function') continue;
        call[n] = jspi ? WebAssembly.promising(ex[n]) : ex[n];
    }
}

// Start-up (1.7.9). background.js compiles the .wasm once and posts { type: 'init', module } as the first message, so
// every worker only instantiates (no download, no compile). Falls back to fetching the file itself when no module
// arrives (module: null, no message within INIT_WAIT_MS) or when instantiating from the module throws.
const INIT_WAIT_MS = 3000;
// Warm-up before 'ready': the engine allocates its net, book and transposition table on the first real search
// (about 40-65 ms in Node). Pay that now, on a position that is not in the opening book, then put the engine back in
// its fresh state: empty hash, and set_position('') = start position, no moves (that resets the per-game state it keeps).
const WARM_FEN = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const WARM_MS = 5;      // the engine searches at least 30 ms whatever it is given (only builds without think_depth use it)
// 2.0.2: think_depth(1) does the same lazy set-up (net, book, hash table) without the 30 ms think floor: ~15 ms less
// per worker start in Node (45 -> 28 ms with the 2.0.2 engine). Checked: a worker warmed either way answers a battery of
// 145 timed calls exactly like a cold one (tests/bench-engines.js runBattery with a warm-up).
const WARM_DEPTH = 1, WARM_DEPTH_MS = 1000;

let started = false;

// One fresh instance: from the shared module when there is one, else by loading the file. { instance, how }
async function makeInstance(module) {
    if (module) {
        try {
            const r = await WebAssembly.instantiate(module, imports);
            return { instance: r instanceof WebAssembly.Instance ? r : r.instance, how: 'module', module };
        } catch (e) { /* fall back to the file */ }
    }
    const load = async (url) => {
        try {
            return await WebAssembly.instantiateStreaming(fetch(url), imports);
        } catch (e) {
            // Fallback for hosts that don't serve .wasm with the right MIME type.
            const buf = await (await fetch(url)).arrayBuffer();
            return await WebAssembly.instantiate(buf, imports);
        }
    };
    let result;
    try { result = await load(WASM_URL); }
    catch (e) {
        if (!/aggrochess\.wasm$/.test(String(WASM_URL))) result = await load(new URL('aggrochess.wasm', self.location.href));   // the SIMD build would not load: the plain one
        else throw e;
    }
    return { instance: result.instance, how: 'fetch', module: result.module };
}

async function startInit(module, file, ttMb, useJspi) {
    if (started) return;
    started = true;
    if (useJspi === false) jspi = false;                           // tests / measurements: the 2.0.0 way
    makeImports();
    if (file && !file.includes('..') && /^(?:[\w.-]+\/)?[\w.-]+\.wasm$/.test(file)) WASM_URL = new URL(file.replace(/^.*\//, ''), self.location.href);
    TT_MB = Number(ttMb) > 0 ? Number(ttMb) : 0;
    let made = await makeInstance(module);
    bindExports(made.instance);
    let warmMs = null;
    try { warmMs = await warmUp(); }
    catch (e) {
        // The engine trapped during the warm-up: do not trust that instance. Use a clean one, without warm-up.
        made = await makeInstance(module);
        bindExports(made.instance);
        try { applyTt(); } catch (e2) { /* ignore */ }
    }
    // interruptible: a stop ends a running search (needs JSPI and an engine that imports js_poll, 2.0.2)
    const polls = !!(made.module && WebAssembly.Module.imports(made.module).find((i) => i.name === 'js_poll'));
    postMessage({ type: 'ready', how: made.how, warmMs, steps: typeof ex.think_depth === 'function', interruptible: jspi && polls });
}

// Throws if the engine traps.
// The hash size (builds that export set_tt_mb); before the first search, which is what allocates the table.
function applyTt() { if (TT_MB && typeof ex.set_tt_mb === 'function') ex.set_tt_mb(TT_MB); }

async function warmUp() {
    const t0 = performance.now();
    applyTt();
    ex.set_position(write(WARM_FEN + '|'));
    read(await (call.think_depth ? call.think_depth(WARM_DEPTH, WARM_DEPTH_MS) : call.think(WARM_MS)));
    ex.clear_hash();
    ex.set_position(write(''));
    return Math.round(performance.now() - t0);
}

function write(s) {
    const b = enc.encode(s);
    new Uint8Array(ex.memory.buffer, ex.io_ptr(), b.length).set(b);
    return b.length;
}

function read(n) {
    return dec.decode(new Uint8Array(ex.memory.buffer, ex.io_ptr(), n).slice());
}

// "<fen>|<moves>" when the game started from a set-up position, else just the moves
const posText = (m) => (m.fen ? m.fen + '|' : '') + (m.moves || []).join(' ');

function positionInfo() {
    const legalText = read(ex.legal_moves());
    const legal = legalText
        ? legalText.split(' ').map((p) => {
            const i = p.indexOf(':');
            return { uci: p.slice(0, i), san: p.slice(i + 1) };
        })
        : [];
    return {
        legal,
        status: ex.game_status(),
        check: ex.in_check() === 1,
        stm: ex.side_to_move() === 0 ? 'w' : 'b',
        fen: read(ex.fen()),
    };
}

// One request at a time (2.0.2): a search may be suspended inside the engine (JSPI), so the next request waits for it.
let queue = Promise.resolve();
onmessage = (e) => {
    const m = e.data;
    if (m && m.type === 'stop') {                                   // acts at once: ends the running search at its next poll
        if (m.id === undefined || m.id === null || m.id === currentId) stopFlag = true;
        else stopIds.add(m.id);                                     // still queued: it stops at its first poll
        return;
    }
    if (m && m.type === 'init') {
        startInit(m.module || null, m.file, m.ttMb, m.jspi).catch((err) => postMessage({ type: 'error', message: 'Failed to load engine: ' + err }));
        return;
    }
    queue = queue.then(() => handle(m)).catch((err) => postMessage({ type: 'error', id: m && m.id, message: String(err) }));
};

function startSearch(id) {
    currentId = id;
    stopFlag = stopIds.delete(id);                                  // a stop for this request may have come while it was queued
}

async function handle(m) {
    if (m.type === 'position') {
        const ok = ex.set_position(write(posText(m)));
        postMessage({ type: 'position', id: m.id, ok: ok === 1, ...positionInfo() });
    } else if (m.type === 'analyze') {
        // neutral analysis of the position after m.moves, plus facts about the move played next
        ex.set_position(write(posText(m)));
        startSearch(m.id);
        // 2.0.2: m.floor = the shortest search wanted (the ranking scans: 3 ms; plain analyze() never searches less than 20 ms)
        const out = read(await (typeof m.floor === 'number' && call.analyze_floor ? call.analyze_floor(m.ms, m.floor) : call.analyze(m.ms))).split(' ');
        const stopped = stopFlag;
        let see = 0;
        let book = false;
        if (m.next) {
            see = ex.move_see(write(m.next));
            book = ex.is_book_move(write(m.next)) === 1;
        }
        if (out[0] === 'none') {
            postMessage({ type: 'analysis', id: m.id, none: true, see, book, stopped });
        } else {
            postMessage({
                type: 'analysis',
                id: m.id,
                kind: out[0], // 'cp' or 'mate'
                value: parseInt(out[1], 10), // White's point of view
                bestUci: out[2],
                bestSan: out[3],
                depth: parseInt(out[4], 10) || 0,
                see,
                book,
                stopped,
            });
        }
    } else if (m.type === 'ponderMove') {
        // AggroChess's expected reply in this position (from its own last search)
        ex.set_position(write(posText(m)));
        postMessage({ type: 'ponderMove', id: m.id, uci: read(ex.ponder_move()).trim() });
    } else if (m.type === 'clear') {
        ex.clear_hash();
        postMessage({ type: 'cleared', id: m.id });
    } else if (m.type === 'think') {
        ex.set_position(write(posText(m)));
        startSearch(m.id);
        const out = read(await (m.depth && call.think_depth ? call.think_depth(m.depth, m.ms) : m.soft ? call.think_clock(m.soft, m.hard) : call.think(m.ms))).split(' ');
        const stopped = stopFlag;                                  // 2.0.2: the search was ended by a stop (its move is the last completed depth's)
        if (out[0] === 'none') {
            postMessage({ type: 'bestmove', id: m.id, uci: null, stopped });
        } else {
            postMessage({
                type: 'bestmove',
                id: m.id,
                uci: out[0],
                san: out[1],
                score: out[2],
                depth: parseInt(out[3], 10) || 0,
                sacrifice: out[4] === '1',
                swindle: out[5] === '1',
                stopped,
            });
        }
    }
}

// No init message (an older background page, or the module could not be sent): load the file ourselves.
setTimeout(() => {
    startInit(null).catch((err) => postMessage({ type: 'error', message: 'Failed to load engine: ' + err }));
}, INIT_WAIT_MS);
