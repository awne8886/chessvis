// Runs the AggroChess WebAssembly engine off the main thread so the page never freezes.
'use strict';

let WASM_URL = new URL('aggrochess.wasm', self.location.href);   // init may name another file (the SIMD build)
let TT_MB = 0;                                                    // hash size asked for in init (0 = the engine's own)
const enc = new TextEncoder();
const dec = new TextDecoder();
let ex = null;

const imports = {
    env: {
        js_now: () => performance.now(),
        js_random: () => Math.random(),
    },
};

// Start-up (1.7.9). background.js compiles the .wasm once and posts { type: 'init', module } as the first message, so
// every worker only instantiates (no download, no compile). Falls back to fetching the file itself when no module
// arrives (module: null, no message within INIT_WAIT_MS) or when instantiating from the module throws.
const INIT_WAIT_MS = 3000;
// Warm-up before 'ready': the engine allocates its net, book and transposition table on the first real search
// (about 40-65 ms in Node). Pay that now, on a position that is not in the opening book, then put the engine back in
// its fresh state: empty hash, and set_position('') = start position, no moves (that resets the per-game state it keeps).
const WARM_FEN = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const WARM_MS = 5;      // the engine searches at least 30 ms whatever it is given

let started = false;

// One fresh instance: from the shared module when there is one, else by loading the file. { instance, how }
async function makeInstance(module) {
    if (module) {
        try {
            const r = await WebAssembly.instantiate(module, imports);
            return { instance: r instanceof WebAssembly.Instance ? r : r.instance, how: 'module' };
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
    return { instance: result.instance, how: 'fetch' };
}

async function startInit(module, file, ttMb) {
    if (started) return;
    started = true;
    if (file && !file.includes('..') && /^(?:[\w.-]+\/)?[\w.-]+\.wasm$/.test(file)) WASM_URL = new URL(file.replace(/^.*\//, ''), self.location.href);
    TT_MB = Number(ttMb) > 0 ? Number(ttMb) : 0;
    let made = await makeInstance(module);
    ex = made.instance.exports;
    let warmMs = null;
    try { warmMs = warmUp(); }
    catch (e) {
        // The engine trapped during the warm-up: do not trust that instance. Use a clean one, without warm-up.
        made = await makeInstance(module);
        ex = made.instance.exports;
        try { applyTt(); } catch (e2) { /* ignore */ }
    }
    postMessage({ type: 'ready', how: made.how, warmMs, steps: typeof ex.think_depth === 'function' });
}

// Throws if the engine traps.
// The hash size (builds that export set_tt_mb); before the first search, which is what allocates the table.
function applyTt() { if (TT_MB && typeof ex.set_tt_mb === 'function') ex.set_tt_mb(TT_MB); }

function warmUp() {
    const t0 = performance.now();
    applyTt();
    ex.set_position(write(WARM_FEN + '|'));
    read(ex.think(WARM_MS));
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

onmessage = (e) => {
    const m = e.data;
    try {
        if (m.type === 'init') {
            startInit(m.module || null, m.file, m.ttMb).catch((err) => postMessage({ type: 'error', message: 'Failed to load engine: ' + err }));
        } else if (m.type === 'position') {
            const ok = ex.set_position(write(posText(m)));
            postMessage({ type: 'position', id: m.id, ok: ok === 1, ...positionInfo() });
        } else if (m.type === 'analyze') {
            // neutral analysis of the position after m.moves, plus facts about the move played next
            ex.set_position(write(posText(m)));
            // 2.0.2: m.floor = the shortest search wanted (the ranking scans: 3 ms; plain analyze() never searches less than 20 ms)
            const out = read(typeof m.floor === 'number' && typeof ex.analyze_floor === 'function' ? ex.analyze_floor(m.ms, m.floor) : ex.analyze(m.ms)).split(' ');
            let see = 0;
            let book = false;
            if (m.next) {
                see = ex.move_see(write(m.next));
                book = ex.is_book_move(write(m.next)) === 1;
            }
            if (out[0] === 'none') {
                postMessage({ type: 'analysis', id: m.id, none: true, see, book });
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
            const out = read(m.depth && ex.think_depth ? ex.think_depth(m.depth, m.ms) : m.soft ? ex.think_clock(m.soft, m.hard) : ex.think(m.ms)).split(' ');
            if (out[0] === 'none') {
                postMessage({ type: 'bestmove', id: m.id, uci: null });
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
                });
            }
        }
    } catch (err) {
        postMessage({ type: 'error', id: m.id, message: String(err) });
    }
};

// No init message (an older background page, or the module could not be sent): load the file ourselves.
setTimeout(() => {
    startInit(null).catch((err) => postMessage({ type: 'error', message: 'Failed to load engine: ' + err }));
}, INIT_WAIT_MS);
