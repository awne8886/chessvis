// Runs the AggroChess WebAssembly engine off the main thread so the page never freezes.
'use strict';

const WASM_URL = new URL('aggrochess.wasm', self.location.href);
const enc = new TextEncoder();
const dec = new TextDecoder();
let ex = null;

const imports = {
    env: {
        js_now: () => performance.now(),
        js_random: () => Math.random(),
    },
};

async function init() {
    let result;
    try {
        result = await WebAssembly.instantiateStreaming(fetch(WASM_URL), imports);
    } catch (e) {
        // Fallback for hosts that don't serve .wasm with the right MIME type.
        const buf = await (await fetch(WASM_URL)).arrayBuffer();
        result = await WebAssembly.instantiate(buf, imports);
    }
    ex = result.instance.exports;
    postMessage({ type: 'ready' });
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
        if (m.type === 'position') {
            const ok = ex.set_position(write(posText(m)));
            postMessage({ type: 'position', id: m.id, ok: ok === 1, ...positionInfo() });
        } else if (m.type === 'analyze') {
            // neutral analysis of the position after m.moves, plus facts about the move played next
            ex.set_position(write(posText(m)));
            const out = read(ex.analyze(m.ms)).split(' ');
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
            const out = read(m.soft ? ex.think_clock(m.soft, m.hard) : ex.think(m.ms)).split(' ');
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

init().catch((err) => postMessage({ type: 'error', message: 'Failed to load engine: ' + err }));
