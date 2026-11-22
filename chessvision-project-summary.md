# ChessVision: project context

**What it is.** A Firefox (Manifest V2) extension, now version 1.8.0, that plays against chess.com bots automatically. It reads the board from the page, asks a local engine for a move, and plays it with synthetic pointer events. Two engines are available: Stockfish (wasm lite NNUE, with an asm fallback; optional pondering pool and threaded build since 1.8.0) and AggroChess (a small Tal-style wasm engine). Maia-3 was removed in 1.7.8 (file size). There is an on-page panel with the settings. It only runs on pages listed in `allowed-pages.txt`. The author runs it on Firefox for Android.

**Architecture (keep this separation).**
- **Page scripts (`content.js`, `overlay.js`):** DOM reading and the panel only.
- **Pure modules:** `boardstate.js`, `clock.js`, `pgn.js`, `recorder.js`, `brilliant.js`, `humanize.js`, `chessmini.js` and the helpers in `settings.js`. They have no DOM or storage access and run under Node, so they are unit-tested. New logic goes here.
- **Background page (`background.js`):** engine workers, timeouts, the ponder job, image downloads.
- **Constraints:** no new dependencies and no build step. The only manifest changes allowed are the version, new content scripts and, when explicitly approved, a permission. Tests run with plain `node tests/*.test.js`, and CI also syntax-checks the root `*.js`.

## What was done in the 1.8.0 work (Stockfish speed)
1. **Stockfish ponder pool** (`background.js`, section "Stockfish pondering"; settings `sfPonder`, `sfPonderMs`, `sfPonderWorkers`, `sfPonderHashMb`, default off). It reuses the AggroChess pool (`ponderClaim`, `ponderTopUp`, shared `ponder` state, idle token, `decide()` accounting); workers have `kind` 'aggro' or 'sf' and spares of the other kind are killed. Stockfish workers are cancelled with `stop` + `isready` (`sfRelease`, counted in `ponderCancelling` against the cap), `terminate()` only after `SF_STOP_TIMEOUT_MS`. Ranking: one MultiPV search (`SF_RANK_MODE = 'multipv'`; `'scan'` = per-move searches as for AggroChess). One legal opponent move = no ranking, whole time on it. A reply search running on exactly the move the opponent plays is stopped and used from depth 8 (`harvest`). Pondering is off while imperfection > 0. A new game bumps `ponderGen`; workers send `ucinewgame` when claimed.
2. **Shared module** (`engine/sf-worker.js`, wrapper for the unmodified loader): background compiles the wasm once (`sfModuleFor`) and posts `{type:'sfinit', module, loader}`; the wrapper makes the loader's `fetch` + `instantiateStreaming` use it. Start order: wrapper + module, direct loader, asm (main only). Verified in Node by running the real loader inside a browser-like vm; the old tests rely on the direct path when `WebAssembly` / `fetch` are absent from the sandbox.
3. **Threads**: `sfThreads` (default 1), threaded build `engine/stockfish-19-lite.js/.wasm` copied unmodified from npm `stockfish@19.0.1`; `CV.sabSupport` runtime test, result in Copy debug info (`background.stockfish.sab`); failure = keep single thread, no retry. `setoption MultiPV` only when it changes. `sfUseClock` (default off) caps the search with the `clock.js` soft budget (`CV.sfSearchCap`).
4. **Pure helpers** in `settings.js`: `sabSupport`, `sfThreadCount`, `sfSearchCap`, `sfScoreValue`, `sfParseInfo`, `sfRankFromLines`, `sfRankFromScan`, `ponderWanted`; `ponderCfgChange` knows Stockfish.
5. **Benchmark** `tests/bench-stockfish.js` (+ `bench-stockfish-sims.js`): start-up, depth, concurrency, warm/cold determinism, ponder hit-rate simulation, move-quality guard, hash, reuse, threads. Results are in the README (Node, 1 core).
6. **Measured and not adopted:** hash 64/128 (no gain), role swap after a ponder hit (+0.25 ply), UCI `go ponder` (52% vs 88% hit rate), Move Overhead (irrelevant for depth/movetime).
- **Findings:** MultiPV ranking beats the per-move scan with 1 worker (AggroChess opponent, 1500 ms: 77-81% vs 75%, a third of the CPU); with 3 workers the scan is a bit better against very weak opponents. Warm-up only helped the first 150 ms search (+1.2 ply, within noise later); warm and cold are identical with `go nodes` (14/14). Ponder replies equal the normal search's move 30/30. `stop` works mid-search on the single-thread build (about 20 ms).
- **Not verified:** real Firefox / Android (wrapper + `importScripts`, `compileStreaming` on `moz-extension://`, module `postMessage`, memory of 3 workers, `stop` latency), SharedArrayBuffer in the background page (threaded build never ran in a browser), hit rate against real chess.com bots, SIMD in the shipped lite wasm (not scanned), the new panel section, `sfUseClock` on the real clock. The uploaded zip had no `.github/` folder although the README mentions it. `engine/NOTICE.txt` was not read or edited (see the NOTICE lines in the hand-over).

## What was done in the 1.7.9 work (AggroChess speed)
1. **Ponder worker pool** (`background.js`): 1-3 ponder workers (`aggroPonderWorkers`, capped at `max(1, hardwareConcurrency - 1)`) pull opponent moves from shared queues (ranking pass, then reply searches); all share the token/deadline/overrun logic; `ponderStop`/`ponderCancel` kill every job worker; a real think never waits. `createPonderState` (settings.js) keeps a set of running moves (`addRunning`/`removeRunning`/`runningMoves`, old `setRunning` kept); `decide()` adds `running`.
2. **Shared compiled module + warm spares**: wasm compiled once in the background and posted to workers (`{type:'init', module, file, ttMb}`); the worker falls back to fetching; it warms up (non-book FEN, `think(5)`, `clear_hash`, `set_position('')`) before `ready`. Killed ponder workers are replaced by warm spares, only while pondering is wanted, never above the cap, never during a real search.
3. **Engine binaries**: AggroChess 4.6.1 (replaces the older shipped build), plain + simd128, chosen by `WebAssembly.validate`; source patch in `engine/aggrochess-4.6.1-chessvision.patch` (clock polled every 256 nodes; exports `set_tt_mb`, `think_depth`). Built with rustc 1.100 / conda-forge. Plain vs SIMD: identical searches, SIMD about 15% faster in Node.
4. **`aggroPonderHashMb`** (ponder workers only), **stepped ponder replies behind `PONDER_STEPPED = false`** (unproven for strength), **`tests/bench-aggro.js`** (not a test; includes the warm-up equivalence check, 16/16).
5. Tests: `stockfish.test.js` (pool, hand-off, SIMD choice, worker file, stepped path) and `ponder.test.js` extended; all green.
- **Not verified:** real Firefox / Android (module postMessage, compileStreaming on moz-extension URLs, SIMD validate, memory of 3 workers), the hit rate with several workers, strength of the 4.6.1 build vs the old one and of stepped replies, the browser-side 50 ms overrun (not reproduced in Node). `engine/NOTICE.txt` still describes the old AggroChess build.

## What was done in the 1.7.8 work
1. **PGN recorder rewritten (`recorder.js`, `pgn.js`).** The recorder no longer follows the tracker's events. It keeps its own list of distinct board positions seen ("anchors": placement, side to move and whether that was certain, last-move square) from every board read on an allowed page, so the bot's, the opponent's and manual moves made while paused are all captured. The move list is built only when the game is built (end of game or "Save current game now"): between two anchors it searches legal move sequences (iterative deepening, up to 6 plies, pruned by squares changed / piece count, 400k node budget) for one that reaches the later placement, respecting the side-to-move parity, then picks the best by last-move square and the bot's announced moves. An unexplainable anchor is skipped if one of the next two can be explained; otherwise the PGN stops there and `ChessVisionIncomplete` says so. Takebacks cut the anchors; an untouched start or a rising piece count starts a new game.
2. **Why the old one failed:** on a gap the tracker restarted its baseline and guessed a two-ply explanation by placement alone (turn-blind), so wrong guesses poisoned every later move and the PGN contained illegal moves. The tracker now rejects a two-ply explanation when the observed side to move contradicts it (it only feeds the engines now).
3. **PGN output** is plain: seven-tag roster, move numbers, SAN, result, 80 columns, no comments. Reconstructed plies are counted in a header. SAN covers check / mate, promotion, castling, en passant, disambiguation (tested).
4. **Sacrifices** are matched from bot notes (position + move + colour) against the final move list, so they also count inside reconstructed gaps.
5. **Maia-3 removed:** engine option, settings, `maia.js`, `tools/`, ONNX model, onnxruntime files, its test. `engine/NOTICE.txt` was NOT edited (the rules forbid reading it) and still lists Maia-3 / onnxruntime-web.
6. Test added: `tests/recorder.test.js` (the reported game in several gap patterns). Run all with `for t in tests/*.test.js; do node $t; done`.

## What was done in the 1.7.2 work
1. **AggroChess fails cleanly.** Start timeout, `onerror` handling, an error cooldown, a think timeout that re-creates the stuck worker, and errors that reach the panel instead of hanging.
2. **History tracker.** It rebuilds the moves from observed positions and handles one missed ply, takebacks, new games and gaps without guessing. Stockfish and AggroChess now get the start position and moves (repetition, 50-move rule). The FEN has correct move counters.
3. **Clock-based search.** AggroChess `think_clock` is sized from the player's clock, with a low-time mode and a cap on the human-like pause.
4. **Smaller changes.** AggroChess's hash is cleared on a new game, there is a "Clear engine memory" button, and synthetic events ignore the panel so it can't block moves.
5. **AggroChess options.** Pondering, an evaluation line, and position verification (warn only).
6. **Game recording.** Every ply is recorded to PGN with a sacrifice counter, auto-save rules, a saved-games list with download and copy, and a best-effort brilliant-move count with three layers (text, icon names, icon colour).
7. **Panel header.** The "ChessVision" title is gone and the status reads "WFO", with pondering progress, so it fits when collapsed.
8. **Pondering redesign.** It prepares replies for many opponent moves inside the ponder time and uses whatever was found when the opponent moves.

## What it does best
- **Move reconstruction uses the rules, not highlights.** The live tracker (for the engines) tries legal moves and reports a gap rather than guessing. The recorder fills gaps at the end of the game with a legal-move search and all later positions as context; the only residual ambiguity is move order when two orders reach the same board (the bot's announced moves break such ties for its own moves).
- **Failure handling.** Engine problems show up as a message and are retried later; they don't freeze the bot.
- **Time safety.** `hard` never exceeds a quarter of the remaining clock, `soft` never exceeds `hard`, and the pause before moving shrinks when time is short.
- **Testability.** Almost all logic is covered by fast Node tests with fake workers; no browser or engine is needed.

## Why the unusual approaches
- **Recorder separate from the tracker:** a gap is explained after the game, when every later position is known, instead of guessing on the spot.
- **Tracker instead of FEN-only:** a bare FEN hides repetition and the 50-move rule from the engines and can't tell a takeback from a new game.
- **Two workers for pondering:** the wasm `think()` blocks its worker and can't be interrupted. The only way to cancel is to terminate the worker, and a separate worker keeps the real search from ever waiting.
- **Replies for many moves, found short searches at a time:** AggroChess can't report partial results or rank several moves, so each reply comes from its own bounded search and counts only when finished.
- **Polling instead of pushing from background to page:** it avoids needing the `tabs` permission.
- **Background downloads for icon colours:** icons on another domain taint a page canvas, so the background fetches them and the page reads the pixels.
- **A flag-based sacrifice count:** only AggroChess reports a sacrifice flag, so other engines produce "unknown", never 0.
- **All site guesses in one block:** the clock selectors, name selectors and brilliant candidates are marked as unverified so they are easy to fix.

## Not verified yet
Real chess.com behaviour: clock and name selectors, the result dialog, the brilliant popup and icon domain (`*://*.chesscomfiles.com/*` is an assumption). Also the Blob download, whether board reads happen often enough while paused (a missed move is reconstructed, but only if the position before and after were read), takebacks on the real site, the AggroChess sacrifice flag in real games, how often a ponder reply is used, and real Firefox behaviour.

## Things that could be improved
- **Pondering:** Stockfish ponder replies for 3 workers and `SF_RANK_MODE` should be re-measured on real bots and a phone. A ponder reply is thrown away if its search hadn't finished when the opponent moved (the stepped path, `PONDER_STEPPED`, would keep partial replies once its strength is checked). Ranking AggroChess candidates with a Stockfish MultiPV search could improve its hit rate (not tried).
- **Sacrifice detail:** AggroChess's flag has no piece type, so the type is the piece that moved. A short SEE-based check could give the real material swing.
- **Result detection:** results from the end-of-game dialog are recorded as `*`; reading the dialog text would give 1-0 / 0-1 for resignations and timeouts.
- **Recovery:** a game in progress when the tab closes isn't saved. A periodic draft save of the anchors would fix that.
- **Transpositions in long gaps:** when several board reads are missed in a row, the order of independent moves can differ from the real game (positions are always right). A faster board read (shorter debounce) lowers this.
- **Search around draws:** whether AggroChess's search avoids repetition draws was not shown; only its rules honour them.
- **Selector fragility:** all page selectors need a self-test mode that reports what matched.
- **Settings UI:** the panel is getting long; the AggroChess and saving groups could be separate screens.

- **Stockfish:** swapping ponder and main worker after a hit, SIMD check of the lite wasm, a `sfHashMb` setting (only if a phone shows a gain), enabling `sfThreads` after SharedArrayBuffer is verified in Firefox (needs approval if headers / CSP are required).

## Rules for the next model
- Read `README.md` first and keep it, the changelog and the tests in sync with any change.
- **Keep this file in the zip and update it with every change** (version, what was done, open points).
- Don't read `allowed-pages.txt` or `engine/NOTICE.txt`.
- Keep DOM code in the page scripts and logic in the pure modules.
- Mark anything that depends on the real site as untested.
