# ChessVision

ChessVision is a Firefox extension (Manifest V2, version 2.0.3) that plays chess against the **computer bots** on chess.com by itself. It reads the board from the page, asks a chess engine that runs locally inside the extension for a move, and plays that move with synthetic pointer events. No server is involved: both engines are WebAssembly binaries that ship in `engine/`.

> **Scope.** ChessVision only acts on pages listed in [`allowed-pages.txt`](allowed-pages.txt) and is meant for bot games. Do not use it against people, in rated play, or anywhere engine help is not allowed.

This README explains **how the extension is built and why**: every file, the path a move takes from the board to the engine and back, and the tricks that make it fast. The complete settings table, troubleshooting guide and changelog are in [`docs/REFERENCE.md`](docs/REFERENCE.md) (the README that shipped in the 1.8.0 zip, updated for 2.0.0 and 2.0.2).

---

## Contents

1. [Install](#install)
2. [Architecture at a glance](#architecture-at-a-glance)
3. [The life of one move](#the-life-of-one-move)
4. [The engines](#the-engines)
5. [Pondering](#pondering-thinking-on-the-opponents-time)
6. [Reading the board](#reading-the-board-and-tracking-the-game)
7. [Human-like play and quick replies](#human-like-play-and-quick-replies)
8. [Time management](#time-management)
9. [Failure handling](#failure-handling)
10. [Game recording](#game-recording)
11. [File-by-file guide](#file-by-file-guide)
12. [Measured numbers](#measured-numbers)
13. [Where the time actually goes, and what could be faster](#where-the-time-actually-goes-and-what-could-be-faster)
14. [Development rules](#development-rules)
15. [License](#license)

---

## Install

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and pick `manifest.json` from this folder.
3. Start a bot game at `https://www.chess.com/play/computer`. The ChessVision panel appears in the bottom-right corner; switch **Auto-play** on.

Temporary add-ons disappear when Firefox restarts. A permanent unsigned install needs Firefox Developer Edition or Nightly with `xpinstall.signatures.required = false`. The author runs it on Firefox for Android.

---

## Architecture at a glance

```
 chess.com tab (content scripts, isolated world)                 background page (one per browser)
 ┌──────────────────────────────────────────────┐   runtime     ┌──────────────────────────────────────────────┐
 │ content.js   reads the DOM, drives the loop, │   messages    │ background.js                                │
 │              sends pointer events            │ ───────────▶ │   Stockfish main worker  (UCI, wasm)         │
 │ overlay.js   the panel (Shadow DOM)          │ ◀─────────── │   AggroChess main worker (wasm exports)      │
 │                                              │               │   ponder pool: 1-3 extra workers + spares    │
 │ pure modules (no DOM, unit-testable):        │               │   compiles each .wasm ONCE, posts the Module │
 │   boardstate.js  chessmini.js  humanize.js   │               │   serves allowed-pages.txt, downloads icons  │
 │   clock.js  recorder.js  pgn.js  brilliant.js│               └──────────────────────────────────────────────┘
 │   settings.js (shared with the background)   │                        │ new Worker(...)
 └──────────────────────────────────────────────┘                        ▼
                                                    engine/sf-worker.js → stockfish-19-lite-single.js/.wasm
                                                    engine/aggro-worker.js → aggrochess(-simd).wasm
```

The split is deliberate and is the main rule of the project:

| Layer | Files | Why it is separate |
| --- | --- | --- |
| **Page scripts** | `content.js`, `overlay.js` | Only they touch the chess.com DOM. Everything that depends on chess.com's markup (selectors, events) lives here, so a site change breaks one place. |
| **Pure modules** | `boardstate.js`, `chessmini.js`, `humanize.js`, `clock.js`, `recorder.js`, `pgn.js`, `brilliant.js`, helpers in `settings.js` | No DOM, no storage. They run unchanged under Node, so the logic (FEN building, move tracking, delays, clock budgets, PGN, ponder state) can be unit-tested without a browser. |
| **Background page** | `background.js` | Engines live here, not in the tab: a page reload or SPA navigation on chess.com does not kill a warmed-up engine, its hash table, or the ponder pool, and only one copy of each engine exists however many tabs are open. |
| **Workers** | `engine/*.js` | WebAssembly search blocks the thread it runs on. Running it in a Worker keeps the background page and the tab responsive, and lets several searches run in parallel on different cores. |

Communication is **pull-based**: the tab asks (`runtime.sendMessage`), the background answers. The background never pushes to the tab, which is why the extension does not need the `tabs` permission. Ponder progress is polled by the watchdog tick.

---

## The life of one move

What happens between "the opponent moved" and "our piece lands", with the file and function responsible:

1. **Mutation seen** — `content.js › attach()` installs a `MutationObserver` on the board element (child list + `class` attributes). Every change calls `scheduleStable(boardDebounceMs)` (default 80 ms): after the debounce the board is read twice, one animation frame + 20 ms apart, and `check()` runs only when both reads agree (`boardstate.js › signature`), so a half-updated board never reaches the tracker. A **watchdog** (`startWatchdog`, default every 1000 ms) calls `check()` directly in case a mutation was missed.
2. **Board read** — `readPosition()` collects every `.piece` element (`wp`, `bk`, … classes and `square-XY`) into an 8×8 grid plus the highlighted last-move squares. `boardstate.js › buildPosition` turns that into a placement, side to move (from which colour moved onto the highlighted square), castling rights and en-passant square.
3. **Tracking** — `boardstate.js › createTracker().observe()` compares the new placement with the last known one and finds the legal move (or two) that explains it. It keeps the full **move history from the start position**, which is why the engines get `position fen <start> moves …` instead of a bare FEN: they then see threefold repetition and the 50-move counter. It also detects takebacks and new games.
4. **Our turn?** — `check()`: if it is the opponent's turn, `idleWork()` starts pondering (see below) and the status shows `WFO`. If it is our turn and this position was not handled yet, `play(pos)` runs.
5. **Quick-reply shortcut** — `humanize.js › likelyObvious()` asks whether any legal move could be an "obvious" one (only move, recapture, promotion, mate in one). If yes, the engine is first asked a **cheap** question (Stockfish depth ≤ 8, AggroChess `quickThinkMs`). If its answer really is one of those categories, it is played with the short "quick" delay. A forced move (one legal move) is played without asking any engine.
6. **Engine request** — for a normal move the human-like delay is drawn first (step 7), then `askEngine()` sends `{type:'analyze', startFen, moves, depth | ms | soft/hard, ponder, …}` to the background. `background.js › analyzeStockfish / analyzeAggro` first checks the **ponder table**: if a reply for exactly this position was prepared while the opponent was thinking, it is returned at once (`ponderHit`). Otherwise the main worker searches. In the default `sfSearchMode: 'delay'` the message carries `softMs` (the delay minus 40 ms minus the time already spent) and Stockfish searches until that is used and Search depth is complete (`CV.sfShouldStop`); AggroChess thinks `max(Think time, softMs)`. As soon as the move is known, the **ponder job for the opponent's turn starts** (early ponder).
7. **Human-like pause** — `humanize.js › delayFor()` draws a delay (log-normal between `minDelay` and `maxDelay`, with rare "hesitations"; the quick range for quick replies and, with `ponderHitFast`, for ponder hits). The engine time already spent counts toward it, so the real wait is `max(delay, engine time)`, never the sum. With the curved cursor, the glide to the from-square (`aimMove`) runs **during** the pause.
8. **Re-check** — just before moving, the board is read again; if the position changed (opponent took back, game ended) the move is dropped.
9. **Input** — `finishMove()` (or `executeMove()` = `aimMove` + `finishMove` without a pause) glides the cursor along a Bézier path (`humanize.js › buildPath`), clicks the from-square, then the to-square (or drags), and picks the promotion piece if needed. Events are dispatched on the element under the point **skipping the panel**, so a panel dragged over the board can never swallow a move.
10. **Confirmation** — 1.8 s later the board is read again. If our move did not register, the attempt is repeated (up to 3 times), switching from drag to click if a drag failed.

---

## The engines

### Stockfish 19 (lite NNUE, WebAssembly, single thread)

| Choice | Why |
| --- | --- |
| **Lite NNUE build** (`stockfish-19-lite-single.wasm`, ~1.8 MB with the net inside) | The full-size Stockfish net is tens of MB; the lite net keeps the add-on small enough for a phone while keeping NNUE evaluation. |
| **Single-thread build by default** | The multi-thread build needs `SharedArrayBuffer`, which needs cross-origin isolation. Whether a Firefox extension background page has it is not verified, so it is opt-in (`sfThreads > 1`) and guarded by a runtime test (`CV.sabSupport`); any failure silently keeps the single-thread engine. |
| **WebAssembly SIMD, and relaxed SIMD since 2.0.2** | The plain build's NNUE is vectorised (`i32x4.dot_i16x8_s`). Since 2.0.2 a second build, `stockfish-19-lite-single-rsimd.js/.wasm`, uses **relaxed SIMD** (`i32x4.relaxed_dot_i8x16_i7x16_add`, Stockfish's own code path, deterministic because the activations are 0..127): the same search (identical depth-14 signature), about 30% more nodes per second (Node 537 → 703 k/s; Chromium 545 → 776 k/s). It is used when `WebAssembly.validate` accepts a one-instruction probe (`RELAXED_PROBE`); any failure to compile or start it falls back to the plain build for good. Both are built from source by `tools/build-stockfish.sh` (the plain one byte for byte as shipped). |
| **asm.js fallback** (`stockfish-19-asm.js`) | Only for a browser where WebAssembly fails. Much slower, but the bot keeps playing. |
| **Compiled once, shared** (`sfModuleFor`) | The background compiles the `.wasm` a single time with `WebAssembly.compileStreaming` and posts the compiled `WebAssembly.Module` to each worker. Compiling ~1.8 MB of wasm is the slow part of starting a worker; instantiating an already compiled Module is cheap. This matters because the ponder pool starts several Stockfish workers. |
| **Unmodified loader + wrapper** (`engine/sf-worker.js`) | The npm loader is kept byte-identical (licence traceability, easy upgrades). The wrapper intercepts exactly **one** `fetch` + `instantiateStreaming` call of the loader and answers it with the shared Module, then removes the patch. If anything goes wrong it falls back to the real fetch, so the worst case is the old behaviour. |
| **Hash kept between moves** | `ucinewgame` is sent only when a new game starts (`CV.sfIsNewGame`: first search, start position, or more pieces than before). Within a game the transposition table carries over, so the next search starts with most of the tree already known. Measured: a repeated depth-10 search drops from 25 ms to 2 ms. |
| **`setoption` only on change** | `MultiPV` is resent only when it changes (it is 3 while "Imperfection" is on, else 1). |
| **Search limit** | `go depth N` (default 10), optionally with `movetime` (`sfMaxMs`) and an optional cap from the game clock (`sfUseClock`). |
| **Imperfection** | With `MultiPV 3`, a near-best alternative (within 60 cp, never when a mate is on the board) is sometimes played instead of the best move. Pondering is disabled while it is on, because a prepared reply is always the engine's best line. |

### AggroChess 4.6.1 (Tal-style, Rust → WebAssembly)

| Choice | Why |
| --- | --- |
| **An attacking personality** | Plays sacrificial, aggressive chess; reports a `sacrifice` flag per move, which the recorder counts. |
| **Plain + SIMD builds** | `aggrochess-simd.wasm` is chosen when `WebAssembly.validate` accepts a tiny SIMD probe module (`SIMD_PROBE`); otherwise `aggrochess.wasm`. Same search. Since 2.0.2 the SIMD build computes the NNUE with explicit wasm SIMD (`screlu_dot` with `i32x4.dot_i16x8_s`, the accumulator updates with `i16x8` adds; bit-exact): 686 → 873 k nodes/s in Node, about 1.6x the plain build. Both are optimised by `wasm-opt -O3` (11% smaller). |
| **Compiled once, shared** | Like Stockfish: `aggroModuleFor()` compiles once, each worker only instantiates (`{type:'init', module}`); a worker that receives no Module within 3 s loads the file itself. |
| **Warm-up before `ready`** | The first search of a fresh instance sets up the net, book and hash. A worker pays that on a non-book middlegame position (2.0.2: `think_depth(1)`, ~28 ms in Node instead of 45 for `think(5)`, which had to search the 30 ms floor), then clears the hash and resets the game; a warmed worker answers exactly like a cold one. Since 2.0.2 the hash tables are allocated zeroed and the nets read in place (54 MiB less resident memory per fresh worker). |
| **Source in the repository** (`engine-src/aggrochess/`, built by `tools/build-aggrochess.sh`) | AggroChess 4.6.1 (GitHub tag `v4.6.1`) plus the web wrapper, which 2.0.2 reconstructed from the shipped binaries and checked call for call against them, and ChessVision's changes (`upstream.diff`): the clock is polled every 256 nodes instead of 1024 (a search overran its budget by ~50 ms in wasm, where reading the clock is a call into JavaScript); the exports `set_tt_mb` (hash size per worker) and `think_depth` (one depth step at a time); since 2.0.2 `analyze_floor` / `think_floor` (short searches that stay short: the ranking scans), `last_info` (benchmarks), the `js_poll` import (interruption) and the speed changes. The build is pinned (Rust 1.100.0, `Cargo.lock`, binaryen 132) and byte-reproducible. |
| **Clock-sized search** | `think_clock(soft, hard)` is fed from your chess.com clock (`clock.js`), so the engine spends more time when it has it and never risks flagging. |
| **Interruptible where the browser has JSPI (2.0.2)** | A wasm `think()` call blocks its worker until it returns. Since 2.0.2 the engine asks the page every 8 ms (`js_poll`) whether to stop; with JavaScript Promise Integration (`WebAssembly.Suspending` / `promising`, feature-detected) that question lets the worker receive a `stop`, and the search ends with its last completed depth (Chromium: median 6 ms after the stop, no measurable cost). Without JSPI (Firefox before ~153, unverified) a search still runs to its time limit and the only way to cancel it is `Worker.terminate()`, which shapes the AggroChess pondering design below. |

### Why two engines

Stockfish is the strongest move-finder; AggroChess plays the sharper, more entertaining style the author likes (sacrifices are counted and can trigger an automatic save of the game). Both are behind the same message interface (`analyze`, `aggroIdle`, `aggroClear`), so the page does not care which one is active.

---

## Pondering (thinking on the opponent's time)

**On by default since 2.0.2** (`aggroPonder`, `sfPonder`; 1 ponder worker each). The extension uses the seconds while the opponent thinks to **prepare our reply in advance**. If the opponent then plays a move we prepared for, our answer is ready instantly ("ponder hit"; 88% of moves in the 1.8.0 simulation).

**What it costs, and how to switch it off.** While the opponent thinks, one ponder worker keeps one CPU core busy, for the whole opponent's think with **Keep pondering until the opponent moves** (up to **Ponder at most**, 8 s), and holds its memory (AggroChess about 50 MiB, Stockfish about 58 MiB with its 16 MB hash) for as long as pondering is on. On a phone that means more battery use and some warmth during long games. Pondering stops when the tab is hidden. To switch it off: in the panel, **AggroChess options → Ponder on opponent's time** and **Stockfish options → Ponder on opponent's time** (`aggroPonder`, `sfPonder` off = 2.0.0). A middle way: keep pondering on but switch **Keep pondering until the opponent moves** off; the job then ends after **Ponder time** (1.5 s).

### Why not classic UCI `go ponder`?

Classic pondering guesses **one** opponent move and searches it. Measured in this project: guessing one move hit **52%** of the time; preparing replies for many moves hit **88%**. So ChessVision prepares replies for **many** opponent moves:

1. **Ranking** — which opponent moves are likely? Stockfish: one `MultiPV 8` search of the position the opponent faces (120 ms) ranks their best moves (`SF_RANK_MODE = 'multipv'`; it beat per-move scanning with one worker at a third of the CPU). AggroChess: a 12 ms search after every legal opponent move, plus a bonus for AggroChess's own predicted reply (`ponder_move`).
2. **Replies** — most likely first, each gets its own search slice (`budget / 6`, clamped to 120-600 ms) on a ponder worker. Every finished reply goes into the ponder table (`CV.createPonderState`, pure, tested).
3. **Decision** when the opponent has moved — `ponder.decide(startFen, moves)`:
   - `hit`: that move has a finished reply → play it, no search at all.
   - `late`: it was planned but not finished → Stockfish only: if a worker is searching exactly that move and already reached depth 8, it is told to `stop` and its `bestmove` is used ("harvest", waits at most 150 ms). Otherwise a normal search.
   - `miss` / `none`: normal search.

### The worker pool

* **Separate workers, never the main one.** The main worker is reserved for the real search, so a real search **never waits** for pondering. A miss cancels the ponder workers and the main search starts immediately.
* **1-3 ponder workers** (`*PonderWorkers`), capped at `max(1, hardwareConcurrency − 1)` so the main search and the page keep a core.
* **Shared queues.** All ponder workers pull from one ranking queue and one reply queue: whichever worker is free takes the next opponent move.
* **Warm spares.** After a job, replacements are created and warmed up **in advance** (`ponderTopUp`), so the next job starts at once. Spares are only made while pondering is wanted and never while a real search runs (instantiating a worker would steal CPU from it).
* **Cancelling.** Stockfish workers are cancelled with `stop` + `isready` (~20 ms) and **recycled** with their hash; `terminate()` is only the escape hatch if they do not answer within 1.5 s. Since 2.0.3 a new job takes workers that are still stopping instead of starting new ones (the next job begins right after a hit, a few ms before the last job's workers are free; 2.0.2 started fresh workers and terminated the stopped ones: 0.87 starts per job on a phone, 0.25 now in the page harness). AggroChess workers (2.0.2): an idle one goes back to the spares with its hash; a busy one is stopped and recycled the same way when it is interruptible (JSPI, answer within 150 ms), else terminated and replaced by a warm spare. A new game sends `clear` to a recycled worker; the worker that searched the line that was played gets the next job first.
* **Nothing left to find (2.0.3).** A reply whose deepening search ends in under a quarter of its time without getting deeper (a forced mate, a single legal reply, a finished game) is *settled*: later passes skip it, the next likely moves take its place, and the job ends when every reply is settled instead of starting pass after pass (a phone showed 21 271 passes in one job before the opponent moved).
* **Ponder hits keep their depth (2.0.2).** A prepared reply is often shallower than what the main worker reaches in the pause a hit is played after anyway (a pass-1 Stockfish reply has depth ~10). The page draws that pause before asking; on a hit the main worker searches on through it when it should get deeper (`CV.hitTopUp`), and the deeper move is played (Stockfish in Node: 10 → 15.6-16.9 within 60-260 ms). The cursor starts towards the prepared move and turns if the move changed (`ponderHitTopUp`).
* **Tokens.** Every ponder job carries `idleToken`; every async step re-checks it, so results of an outdated job can never leak into the next position. A new game bumps `ponderGen`, and recycled Stockfish workers send `ucinewgame` before their next job.
* **Hidden tab** → pondering stops (`visibilitychange`), to save battery.

### When pondering starts (2.0.0)

With `earlyPonder` (default on) the ponder job for the position after our move starts **the moment `play()` knows the move**, before the human-like pause, the cursor, chess.com's animation and the next board read. The idle key is the move history (`CV.ponderKey`), so when the page later observes the opponent's turn it recognises the running job and only polls it. If the move is dropped or does not register, the next check computes another key and restarts the job, and `ponder.decide()` answers `miss` for any position that does not extend the pondered one. In the jsdom smoke run the job began on average ~1.15 s before the opponent's move instead of ~0.5 s (`ponder.avgLeadMs` in Copy debug info).

With `ponderUntilMove` (default on) the job no longer stops at the ponder time: after the first pass over the likely opponent moves it **deepens** the most likely ones (`CV.ponderDeepenPlan`, top `max(2, 2 x workers)` moves, slices doubling up to 4 s, on the worker that searched each move before) until the opponent moves or `ponderMaxMs` (8 s). The Stockfish main search's principal variation seeds the table (`CV.pvSeed`): if the opponent plays the expected reply, the answer is ready at zero cost.

---

## Reading the board and tracking the game

* **Board element**: `wc-chess-board`, `chess-board` or `.board`; re-attached every second in case chess.com swaps it (it is a single-page app).
* **Side to move** comes from the last-move highlight squares: whichever colour sits on a highlighted square moved last. The untouched start position (no highlights) is White to move.
* **Castling rights** are tracked over the whole game (`updateRights`): once a king or rook leaves its square, the right is gone, even if it comes back.
* **The tracker** (`boardstate.js`) is the **one** game-tracking mechanism: it explains each new board by one legal move (or two, if one board read was missed, and only if the observed side to move agrees), recognises takebacks (the board matches an earlier position) and new games (the untouched start position, or more pieces than before), and reports a gap instead of guessing.
* **Why a tracker and not just the FEN**: a bare FEN hides repetitions and the 50-move rule from the engine, and cannot tell a takeback from a new game.
* **Allowed pages** are re-checked on every read, because chess.com navigates without reloading.

---

## Human-like play and quick replies

All in `humanize.js` (pure, tested):

* **Delays**: log-normal around a typical value, longer when there are many legal moves; rare long "hesitations" (4%).
* **Cursor**: curved Bézier paths with ease-in/out, small jitter and occasional overshoot; off-centre clicks inside the square; click, drag or mixed input.
* **Quick replies** (only move, recapture, promotion / pawn run, mate in one) use a cheap engine look and a short delay, like a human who sees the obvious answer.
* With a short clock the pause is capped at 8% of the remaining time and the "hand" moves faster.

---

## Time management

`clock.js` reads your chess.com clock (selectors are marked as unverified candidates) and computes:

* `soft = min(thinkTime, remaining/40 + 0.8 × increment)`, `hard = min(remaining/8, 3 × thinkTime)`, floors of 100 ms.
* Under 10 s left: `soft = remaining/60`, `hard = remaining/15`.
* Whatever the formulas say, `hard ≤ remaining / 4` and `soft ≤ hard` (a soft budget above hard was seen to overrun 13×).

AggroChess uses this by default (`aggroUseClock`). For Stockfish it is an optional cap (`sfUseClock`).

---

## Failure handling

* An engine that does not start shows a message in the panel and is retried after a cooldown (15 s), instead of hanging the bot.
* A think request that takes more than `3 × budget + 4 s` declares the AggroChess worker stuck; it is terminated and re-created.
* Stockfish start order: wrapper + shared Module → loader directly → asm.js. Each step has its own timeout.
* A move that does not register is retried (drag → click fallback). A move attempt stuck for 45 s is abandoned.
* The watchdog re-reads the board every second whatever the DOM says, so a missed mutation can never stall the game.

---

## Game recording

`recorder.js` keeps every distinct board position it ever sees (from any source: the bot, the opponent, or your own manual moves while paused). Only at the end of the game does it rebuild the move list, filling gaps of up to 6 plies with a legal-move search that uses all later positions as context. This is more reliable than guessing on the spot. `pgn.js` writes a plain PGN with correct SAN; sacrifices are counted from AggroChess's flag; `brilliant.js` makes a best-effort count of chess.com's "brilliant" icons (unverified selectors, three detection layers). Saved games live in `storage.local`.

---

## File-by-file guide

| File | Role |
| --- | --- |
| `manifest.json` | MV2 manifest: permissions (`storage`, `clipboardWrite`, chess.com / chesscomfiles hosts; 2.0.4: lichess removed, no code ever read a lichess board), background scripts, content scripts, CSP allowing `wasm-unsafe-eval` for the engines. |
| `allowed-pages.txt` | The pages where auto-play is allowed (one entry per line, `*` wildcard). |
| `background.js` | Engines, the ponder pool, shared-Module compilation, timeouts and restarts, allowlist and icon downloads, the message router. |
| `content.js` | The main loop on chess.com: board observer, watchdog, board reading, engine requests, delays, pointer input, game-over handling, saving, debug info. |
| `overlay.js` | The on-page panel in a Shadow DOM (chess.com's CSS cannot touch it). Draggable, collapsible, every setting. |
| `settings.js` | Defaults, limits, validation (`sanitize`), import/export, and pure helpers shared with the background: UCI command builders, ponder state, ranking, thread-count and SAB checks, allowlist matching. |
| `chessmini.js` | A small legal-move generator: FEN parsing, legal moves, make-move, check/mate. Used for tracking, quick replies, verification and PGN, never to choose moves. |
| `boardstate.js` | Grid → FEN, highlight analysis, castling rights, the history tracker, and the board signature for the stable read. |
| `humanize.js` | Quick-reply classification, delays, cursor paths, input choice. |
| `clock.js` | Clock parsing and search budgets. |
| `recorder.js` / `pgn.js` | Game reconstruction and PGN / SAN output, sacrifice counting, saved-game list rules. |
| `brilliant.js` | Best-effort brilliant-move counter from chess.com's post-game popup. |
| `popup.html` / `popup.js` | The toolbar popup: only the Auto-play switch. |
| `engine/sf-worker.js` | Wrapper that feeds the shared compiled Module to the unmodified Stockfish loader. |
| `engine/stockfish-19-lite-single.js/.wasm` | Stockfish.js 19 lite, single thread (default engine build). |
| `engine/stockfish-19-lite.js/.wasm` | The multi-threaded build (only with `sfThreads > 1` and SharedArrayBuffer). |
| `engine/stockfish-19-asm.js` | asm.js fallback. |
| `engine/aggro-worker.js` | AggroChess worker: instantiation, warm-up, the message protocol (`position`, `think`, `analyze`, `ponderMove`, `clear`). |
| `engine/aggrochess.wasm` / `aggrochess-simd.wasm` | AggroChess 4.6.1, plain and SIMD builds. |
| `engine-src/aggrochess/` | The AggroChess source behind the two binaries (not loaded at runtime); `tools/build-aggrochess.sh` rebuilds them. |
| `engine/NOTICE.txt` | Third-party sources and licences. |
| `chessvision-project-summary.md` | Hand-over notes between development sessions: what was done, what was measured, what is unverified. |
| `docs/REFERENCE.md` | The full user manual: every setting with key / range / default, troubleshooting, changelog. |
| `docs/SONNET_PROMPT.md` | The speed / strength improvements, written as an implementation task (planned as 1.9.0, released as 2.0.0). |
| `docs/OPUS_PROMPT_2.0.2.md` | The 2.0.2 task (engine speed, workers, pondering), with its status. |
| `engine/stockfish-19-lite-single-rsimd.js/.wasm` | 2.0.2: Stockfish 19 lite single-thread with relaxed SIMD (used where the browser supports it). |
| `tools/build-aggrochess.sh`, `tools/build-stockfish.sh` | 2.0.2: pinned, reproducible engine builds (Rust 1.100.0 + binaryen 132; emsdk 6.0.9). Not needed to use the extension. |
| `tests/` | Plain Node tests (`*.test.js`), the fake-worker background harness (`_fakebg.js`), the engine helpers (`_aggro-wasm.js`), and benchmarks: `bench-engines.js` (signatures, speed, `--diff`), `bench-delay-mode.js`, `bench-ponder-rank.js`, `bench-jspi.js` (Chromium via Playwright), `smoke-board.js` (jsdom page harness; jsdom is installed on demand, not a dependency). |

---

## Measured numbers

From the project's own benchmarks (Node 22, x86-64 container with 4 cores; each about ±15% run to run; see `docs/REFERENCE.md` › Changelog for the method of each):

| What | 2.0.0 | 2.0.2 |
| --- | --- | --- |
| AggroChess SIMD build, nodes per second (`think(1000)`) | 686 k | **873 k** (explicit NNUE SIMD) |
| AggroChess SIMD, average depth at `think(100 / 300 / 1000)` | 12.2 / 14.7 / 17.8 | **12.7 / 15.3 / 18.7** |
| AggroChess bench signature (depth 8 / 12) | 118 270 / 1 422 083 nodes | identical |
| AggroChess binaries | 2.06 MB each | 1.84 MB (wasm-opt) |
| AggroChess fresh worker: warm-up / resident memory | 45 ms / ~60 MiB | 28 ms / ~5 MiB until the hash fills |
| AggroChess ranking scan (one opponent move) | 20 ms (analyze floor) | 12 ms as asked (3 ms floor) |
| AggroChess ranking: opponent's move in the top 1 / 3 / 5 / 8 (80 positions) | 44 / 68 / 73 / 75% | **55 / 74 / 85 / 88%** |
| Stockfish, nodes per second (`go movetime 1000`) | 537 k | **703 k** (relaxed SIMD) |
| Stockfish depth in a 300 / 800 ms delay search | 17.1 / 20.1 | 17.7 / 20.7 |
| Stockfish depth-14 signature | 748 260 nodes | identical |
| Depth played on a Stockfish ponder hit (pass-1 reply) | 10.0 | **15.6-16.9** (top-up in 60-260 ms) |
| AggroChess ponder workers started per move (2 workers, simulation) | 2 | 1 (job ended first); 0.25 with JSPI |
| AggroChess stop of a running search (Chromium, JSPI) | terminate + restart | median 6 ms, kept warm |
| Ponder hit rate, many-move pool vs single guess (`go ponder`, 1.8.0) | 88% vs 52% | not re-measured |
| Stockfish lite, depth 10, cold hash / warm hash | 25 ms / 2 ms | unchanged |

A phone is typically several times slower than these figures. None of this has been measured in real Firefox or on real chess.com bots yet (the JSPI and relaxed-SIMD numbers come from headless Chromium 157).

---

## Where the time actually goes, and what could be faster

With the default settings (Stockfish, Search depth 10 as a minimum, human-like play on; 2.0.2: pondering on), the time from "opponent moved" to "our piece lands" is roughly:

| Stage | 1.8.0 | 2.0.0 | 2.0.2 |
| --- | --- | --- | --- |
| Debounce before the board is read | 250 ms | 80 ms + one frame + 20 ms (stable read) | 40 ms + one frame + 20 ms; the watchdog reads stably too |
| Engine | 2-25 ms at depth 10, then idle | searches **through** the pause: depth ~14-18 in Node (0 on a ponder hit) | the same, ~30% more nodes per second (relaxed SIMD / NNUE SIMD); a ponder hit is deepened through its pause |
| Human-like delay | 300-800 ms (80-300 for quick replies) | the same; 80-300 ms on a ponder hit (`ponderHitFast`) | the same (drawn before the search) |
| Cursor glide + two clicks | ~0.5-1.5 s after the pause | the glide to the from-square runs during the pause (160-520 ms saved) | the same; re-aimed if a top-up changes the move |
| Pondering starts | ~1-2 s after the move was decided | when the move is decided, and runs until the opponent moves | the same (after a top-up ends); on by default |

Measured (`tests/bench-delay-mode.js`, real Stockfish loader in Node, 10 middlegame positions): `go depth 10` reaches depth 10 in 16 ms (median); a delay-matched search with a 300 ms pause reaches depth 15.8 on average, with 800 ms depth 18.1. The table is in [`docs/REFERENCE.md`](docs/REFERENCE.md#changelog).

What is left: everything above was measured in Node, in headless Chromium and in a jsdom mock of the page, not in Firefox or on chess.com (see `chessvision-project-summary.md` for the list of real-browser checks). [`docs/SONNET_PROMPT.md`](docs/SONNET_PROMPT.md) (2.0.0) and [`docs/OPUS_PROMPT_2.0.2.md`](docs/OPUS_PROMPT_2.0.2.md) (2.0.2) are the task descriptions these changes were implemented from.

---

## Development rules

(Summarised from `chessvision-project-summary.md`, which is the authoritative hand-over file.)

* Keep the separation: DOM code only in `content.js` / `overlay.js`, logic in the pure modules.
* No new runtime dependencies, no build step for the extension (plain JS). Engine binaries are built only by the pinned scripts in `tools/` (since 2.0.2), and a pure speed-up must keep the engine signatures bit-identical (`tests/engine-signature.test.js`, `node tests/bench-engines.js --diff`). Manifest changes only for the version, new content scripts, or an explicitly approved permission.
* Tests run with plain Node: `for t in tests/*.test.js; do node "$t" || exit 1; done`. The 1.8.0 zip did not contain the `tests/` folder or `.github/` its notes mention; `tests/` was recreated in 2.0.0 (see `docs/REFERENCE.md › Development`).
* Keep `docs/REFERENCE.md` (settings + changelog), the tests and `chessvision-project-summary.md` in sync with every change.
* Mark anything that depends on the real chess.com site as unverified until it has been checked.

---

## License

GPL-3.0 (see [`LICENSE`](LICENSE)). Third-party engines and their licences are listed in [`engine/NOTICE.txt`](engine/NOTICE.txt): Stockfish (GPL-3.0), Stockfish.js (GPL-3.0), AggroChess (GPL-3.0).
