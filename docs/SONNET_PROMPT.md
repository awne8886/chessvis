# Task: ChessVision 1.9.0 — speed and engine-strength improvements

> **Status:** implemented and released as **2.0.0** (the owner chose 2.0.0 instead of 1.9.0). What was done, measured and left open is in `chessvision-project-summary.md` and the 2.0.0 changelog in `docs/REFERENCE.md`.

You are working on **ChessVision**, a Firefox (Manifest V2) extension in this repository that plays chess against chess.com **bots** with local WebAssembly engines (Stockfish 19 lite and AggroChess 4.6.1). Your job is to implement the improvements below, in the order given, with tests, documentation and a version bump to **1.9.0**.

Work carefully and verify as you go. Do not guess about code you have not read: read each function before you change it.

---

## 0. Read first (mandatory, in this order)

1. `README.md` — architecture and the "life of one move".
2. `chessvision-project-summary.md` — hand-over notes and **the rules for the next model** (keep them; they are binding).
3. `background.js` in full, `content.js` in full, `settings.js` in full, `humanize.js`, `clock.js`, `overlay.js` (how settings controls are built: `toggle`, `seg`, `slider`, `section`).
4. `engine/aggro-worker.js`, `engine/sf-worker.js`.

Do **not** read or edit `allowed-pages.txt` or `engine/NOTICE.txt` (project rule).

## 1. Hard constraints

* **Architecture**: DOM code only in `content.js` / `overlay.js`. All new decision logic goes into **pure functions** in `settings.js` (or another pure module) so it runs under Node and can be unit-tested. `background.js` may call them.
* **No new dependencies, no build step, no bundler.** Plain JS, same style as the existing code (IIFE modules on `CV`, `'use strict'`, 2-space indentation, explanatory comments in the existing tone).
* **Manifest**: change only `"version"` (to `1.9.0`). No new permissions, no CSP / COOP / COEP changes.
* **Engine binaries and loaders in `engine/` stay byte-identical.** Do not modify `stockfish-*.js`, `*.wasm`.
* **Never let pondering delay a real search.** The main worker must never wait for a ponder worker except in the one bounded case defined in task T8.
* **Every new setting** must be added to: `CV.DEFAULTS`, `CV.LIMITS` or `CV.ENUMS` (so `CV.sanitize` handles it), the panel in `overlay.js`, the settings table in `docs/REFERENCE.md`. Exported/imported automatically via `CV.exportSettings` (check it).
* **Old behaviour must stay reachable**: every behaviour change has a setting or constant that restores the 1.8.0 behaviour.
* Anything that depends on the real chess.com DOM or on real Firefox is **unverified**: say so in comments, in `docs/REFERENCE.md` and in the summary file.

## 2. Facts you can rely on (measured)

* Stockfish lite single-thread in Node (x86-64): depth 10 on a middlegame = **25 ms** cold, **2 ms** with a warm hash; depth 14 ≈ **410 ms**. A phone is several times slower.
* The shipped `stockfish-19-lite-single.wasm` **already contains SIMD** (~7 300 SIMD instructions). Do not try to add SIMD.
* The Stockfish loader runs in Node as a UCI CLI: `printf 'uci\nisready\nposition startpos\ngo depth 12\n' | node engine/stockfish-19-lite-single.js` (copy the `.js` + `.wasm` pair into a temp dir first if you want to keep the repo clean). Use this for the benchmark in T3.
* `bestmove` lines look like `bestmove e2a6 ponder b4c3`; `info` lines carry `depth`, `multipv`, `score cp|mate`, optional `lowerbound|upperbound`, `pv m1 m2 m3 …`.
* Measured earlier in the project and **not** to be re-tried: bigger Stockfish hash (no gain), UCI `go ponder` single-move pondering (52 % vs 88 % hit rate), swapping ponder/main worker after a hit (+0.25 ply only).
* The `tests/` folder and `.github/` mentioned in the hand-over notes are **not in this repository**. You must create `tests/` (see §5).

## 3. Where the time goes today (why these tasks)

From "opponent moved" to "our piece lands" with defaults: 250 ms debounce → engine (2-25 ms for Stockfish depth 10, ~1000 ms AggroChess) → human-like delay 300-800 ms (engine time counts toward it) → cursor glide + clicks 0.5-1.5 s. Pondering starts only after all of that **plus** chess.com showing our move and another 250 ms debounce. With Stockfish the engine is almost never the bottleneck; the pipeline is.

---

## 4. Tasks (implement in this order; each one is a separate commit)

### T1 — Start pondering the moment our move is decided ("early ponder")

**Goal**: the ponder job for the position *after our move* starts as soon as `play()` knows which move it will play, instead of after delay + cursor + chess.com animation + debounce.

1. In `content.js`, change the idle key from a FEN to a history key: in `idleWork(pos)`, compute `const key = CV.ponderKey(h.startFen, h.moves)` and use `key` everywhere `pos.fen` is compared with / stored into `idleKey`. Behaviour must be otherwise identical.
2. Extract the message-building part of `idleWork` into `startIdle(startFen, moves, myColor)` that sends the `aggroIdle` message (both the Stockfish and the AggroChess variants exactly as today) and sets `idleKey = CV.ponderKey(startFen, moves)`, `idlePondering = false`, `idleFound = 0`, clears the eval line.
3. In `play(pos)`, after `uci` is final (after the quick-look / imperfection logic, after the `!uci` check) and **before** the human-like wait, if all of these hold: new setting `earlyPonder` is on; pondering or the eval line is enabled for the current engine (same condition as at the top of `idleWork`); `histFor(pos)` is non-null; `byUci(uci)` exists; `!document.hidden` — then call `startIdle(h.startFen, [...h.moves, uci], pos.myColor)`.
4. When the move is later discarded (`position changed, discarding`) or does not register, do nothing special: the next `check()` computes a different key and `idleWork` restarts, and `ponder.decide()` in the background returns `miss` for a position that does not extend the pondered base (verify this by reading `sameBase` in `CV.createPonderState`, and add a unit test for it).
5. Background: record when each ponder job began (`ponder.begin` time) and, in `decide()`, the lead time (`Date.now() - beganAt`). Expose `lastLeadMs` and an average in `aggroDebug` (`ponder` block) so the gain can be measured in "Copy debug info".
6. New setting `earlyPonder` (boolean, default `true`), shown in both the AggroChess and the Stockfish ponder areas of the panel (one key, two controls is fine; or one control in a shared spot — follow the panel's existing structure).

**Tests**: `ponderKey` equality for the early and the observed key of the same position; `decide()` returns `miss` when the actual moves do not extend `base` (retry / discarded-move cases) and `hit` when they do.

### T2 — Read the opponent's move sooner (stable-read debounce)

**Goal**: replace the flat 250 ms mutation debounce with a short, configurable debounce plus a stability check, without ever feeding the tracker a half-updated board.

Why the stability check is mandatory: the tracker treats "more pieces than before" as a **new game**. A read taken mid-update (piece removed, not yet re-added) followed by a full read would trigger a false new game (hash cleared, recorder restarted).

1. Add `boardSignature()` in `content.js`: a string built from `readPosition()` (placement of every piece + sorted highlight squares). Pure part (building the string from grid + highlights) goes into `boardstate.js` as `BS.signature(grid, highlights)`.
2. New scheduler path: a mutation calls `schedule(cfg.boardDebounceMs, 'mutation')`. When the timer fires, take signature A, wait one `requestAnimationFrame` **and** then `setTimeout(…, STABLE_GAP_MS = 20)`, take signature B. If A === B, run `check(reason)`. Otherwise count an "unstable read" and `schedule(cfg.boardDebounceMs, 'unstable')`. Cap consecutive unstable retries at 10, then fall back to running `check()` (the watchdog would anyway).
3. The watchdog keeps calling `check('watchdog')` directly (reads are 1 s apart).
4. Remove the double board read in `check()`: today `check()` calls `observeBoard()` and then `buildFen()` calls `observeBoard()` again. Make `buildFen(obs)` accept the observation already made in this `check()`; other callers (`play` re-check, retry timer, debug info) keep reading fresh.
5. New setting `boardDebounceMs`: limits `[0, 300, 10]`, default `80`. Panel: in the Watchdog section. Setting it to 250 restores the old timing (the stability check stays; document that).
6. Add `unstableReads` to the debug info `state`.

**Tests**: `BS.signature` is order-independent for highlights and changes when any piece changes.

### T3 — Use the human-like pause as free engine time ("delay-matched search")

**Goal**: the bot waits `max(delay, engine time)` anyway. Today Stockfish finishes depth 10 in ~25 ms and then idles for the rest of a 300-800 ms pause. Search **during** the pause instead: same move timing, much deeper search.

1. New setting `sfSearchMode`, enum `['depth', 'delay', 'clock']`, default **`'delay'`**. `'depth'` = exact 1.8.0 behaviour. (`'clock'` is T9.)
2. `content.js › play()`: for the **full** search (not the quick look), draw the human-like delay **before** calling the engine: `plannedDelay = CV.human.delayFor(cfg, { legalCount: legal.length, category: null })`, apply `CV.clock.delayCap` if a clock budget is known. Pass `softMs = max(0, plannedDelay - SF_DELAY_MARGIN_MS)` (margin constant **40 ms**, in `settings.js`) to the background in the `analyze` message. After the engine returns, the wait uses this same `plannedDelay` unless a quick category applies (then the quick delay as today). Keep the existing "engine time counts toward the delay" rule.
3. `background.js` (Stockfish main search) in `'delay'` mode: send `go depth 64` (or `go infinite`) and stop it from JavaScript with a pure rule `CV.sfShouldStop({ elapsedMs, softMs, depthDone, minDepth, hardMs })` that returns true when `(elapsedMs >= softMs && depthDone >= minDepth) || elapsedMs >= hardMs`. `minDepth` = `cfg.depth` (the slider keeps its meaning as a **minimum** depth); `hardMs` = `sfMaxMs` if > 0, else `max(3000, 3 × softMs)`; with `sfUseClock`, also ≤ the clock cap. `depthDone` = depth of the latest **exact** (no bound) `info … multipv 1 … pv` line. Check the rule on every info line and on a timer at `softMs` (a search can be silent for a while). Send `stop` once; the normal `bestmove` handling resolves the job. Make sure `sfInfo` now records depth for MultiPV 1 too (today it returns early when `multipv < 2`), without breaking the imperfection logic.
4. The `sfNext` / supersede logic and `chooseMove` (imperfection) must keep working; a superseded job's timers must be cleared.
5. AggroChess, same idea, smaller: when `aggroUseClock` is off or no clock is read, use `ms = max(thinkMs, softMs)`; with a clock budget use `soft = max(soft, min(softMs, hard))`. Never exceed `hard`.
6. Quick looks are unchanged (Stockfish depth ≤ 8, AggroChess `quickThinkMs`).
7. **Benchmark** (a script, not a test): `tests/bench-delay-mode.js` runs the real Stockfish loader in Node via `child_process` on ~10 fixed middlegame FENs and prints, for soft budgets 150/300/500/800 ms, the depth reached and the time used vs `go depth 10`. Put the results table into `docs/REFERENCE.md` and the summary file.

**Tests**: `sfShouldStop` truth table (soft not reached; soft reached but depth too low; both; hard cap); the AggroChess budget helper (pure function in `settings.js`) never exceeds `hard` and never goes below `thinkMs` without a clock.

### T4 — Move the cursor during the pause, not after it

**Goal**: today the order is *wait remaining delay → glide to from-square → click → glide → click*. Glide to the from-square **during** the wait (160-520 ms saved per move).

1. Split `executeMove` into `aimMove(uci)` (compute `from`/`to` points once, then `glideTo(from)`) and `finishMove(points, uci, color)` (press/click/drag/promotion from the current cursor position). `executeMove` = aim + finish, for the retry path.
2. In `play()`: when `hum() && cfg.mouseMove`, run `aimMove` concurrently with the remaining wait: `await Promise.all([aimMove(...), sleep(wait)])`. Then do the existing re-check (`buildFen()` and the position comparison) **after** the wait and **before** `finishMove`. Token / `cfg.enabled` checks after every await.
3. If the glide takes longer than the wait, no extra wait is added. If the position changed, the cursor just stays where it is (harmless).
4. Without `mouseMove` nothing changes.

### T5 — Fast reply on a ponder hit

1. New setting `ponderHitFast` (boolean, default `true`), panel: Quick replies section, label "Fast reply on ponder hit".
2. When the engine answer has `ponderHit` and the setting is on, use the quick delay range (`quickMinDelay`-`quickMaxDelay`) and the faster hand (`fast = true`), exactly like a quick-reply category, but do **not** set `category` (it feeds the status text and the recorder's `flagKnown`). Add a `fastReply` flag to `delayFor`'s info object instead.
3. Status text keeps `· ponder hit`.

### T6 — Seed the ponder table from the main search, predicted move first

**Stockfish**:
1. Keep the latest exact MultiPV-1 PV of the main job (`job.pv`, array of UCI moves, and its depth). In `sfBestMove`, also parse the `ponder` token.
2. When the main search resolves with `uci === pv[0]` and no imperfection substitution happened, store `lastMainPv = { startFen, moves, pv, depth }` in the background.
3. In `runIdleSfJob`, right after `ponder.begin(...)`: pure helper `CV.pvSeed(lastMainPv, msg.startFen, msg.moves)` returns `{ opp: pv[1], reply: pv[2], depth: depth - 2 }` when `msg.moves` equals `[...lastMainPv.moves, pv[0]]` with the same `startFen`, `pv.length >= 3`, and `depth - 2 >= SF_PARTIAL_MIN_DEPTH`; else null. If non-null, `ponder.addResult(opp, { uci: reply, depth, ms: 0 })` immediately — an instant hit candidate at zero cost.
4. Put `pv[1]` (or the `ponder` token if there is no PV) **first** in the reply order, ahead of the ranking result.
5. Change `addResult` so a result never replaces an existing **deeper** result for the same opponent move (add a unit test; check existing behaviour stays the same for equal/greater depth).

**AggroChess**: `predicted` (from `ponderMove`) already exists. With early ponder (T1) there is more time, so: the first ready worker runs the reply search for `predicted` **before** taking ranking work (when `predicted` is legal); the reply queue then skips it. With several workers, the others start ranking at the same time.

**Tests**: `pvSeed` positive and negative cases (different start, different played move, short PV, too shallow); `addResult` no-downgrade.

### T7 — Keep pondering until the opponent moves, deepening the likely replies

**Goal**: today a ponder job stops at a fixed budget (`*PonderMs`, default 1500 ms) even if the opponent thinks for 5 s, and every reply is a short slice. Use the whole opponent think time and spend it on the moves most likely to be played.

1. New settings: `ponderUntilMove` (boolean, default `true`) and `ponderMaxMs` (limits `[1000, 30000, 500]`, default `8000`), shared by both engines. With `ponderUntilMove` off, the old `*PonderMs` budget applies unchanged.
2. Pure planner in `settings.js`: `CV.ponderDeepenPlan({ ranked, results, pass, workers })` → list of `{ uci, ms }` for the next pass: pass 1 = today's behaviour; pass k ≥ 2 = the top `K = min(ranked.length, max(2, 2 × workers))` moves, slice `min(4000, firstSlice × 2^(k-1))`. Deterministic and unit-tested.
3. In both `runIdleJob` (AggroChess) and `runIdleSfJob` (Stockfish): after pass 1, keep running passes from the planner until `token !== idleToken` or the `ponderMaxMs` deadline. **Worker affinity**: a move is re-searched on the worker that searched it last when that worker is free (its hash already holds that tree); otherwise any free worker.
4. Stockfish ponder searches use no depth cap in `'delay'` / `'clock'` mode (`go movetime ms`); in `'depth'` mode keep `go depth N movetime ms` (deepening is then pointless and the planner stops after pass 1 when every result already has depth ≥ N).
5. Harvest upgrade (Stockfish): on a `hit` while a worker is **currently** searching that same move in a deepening pass and its current depth is greater than the stored result's depth, stop it and use its `bestmove` if it answers within `SF_HARVEST_MS`; otherwise use the stored result.
6. Pondering must still stop on a hidden tab, a new game, a takeback, an engine switch and any real search (`ponderCancel`).
7. Debug info: passes completed and the depth of the result used on each hit.

**Tests**: planner outputs for pass 1/2/3 with 1 and 3 workers; planner stops when the deadline cannot fit a minimum slice (`PONDER_MIN_SLICE_MS`).

### T8 — AggroChess: don't throw away an almost-finished reply (`late`)

Today `late` (the opponent's move is being searched by a ponder worker, not finished) kills all ponder workers and starts a full think from scratch.

1. Extend `CV.createPonderState`: `addRunning(uci, meta)` stores `{ startedAt, ms }`; `decide()` returns `runningMeta` for the move when it is running.
2. In `analyzeAggroNow`, on `late` with `running`: compute `remaining = startedAt + ms + PONDER_OVERRUN_MS - now`. If `remaining <= min(400, 0.5 × the main think budget)`, wait for that worker's result (bounded by `remaining + 100 ms`) and play it as a ponder hit; kill the other ponder workers at once. Otherwise behave as today.
3. Keep `PONDER_STEPPED = false` (strength not verified); do not enable it.

**Tests**: `decide()` returns `runningMeta`; the wait/no-wait rule as a pure function `CV.lateWaitMs(meta, now, mainBudgetMs)`.

### T9 — Stockfish `'clock'` search mode (optional; unverified site part)

1. `sfSearchMode = 'clock'`: read my clock and the opponent's clock (add `readOppClock` next to `readMyClock`, same candidate selectors, the other colour / the top clock). Send `go wtime W btime B winc I binc I` so Stockfish's own time manager decides. If the opponent clock cannot be read, use mine for both. If my clock cannot be read, fall back to `'delay'` for that move and log it.
2. Keep the safety caps: a JS timer stops the search at `CV.clock`'s `hard` (≤ remaining / 4); the delay-matched lower bound of T3 still applies (`softMs`).
3. Mark the clock selectors as unverified everywhere.

### T10 — Small fixes

1. **AggroChess quick look accounting**: when a quick look was not obvious and a full think follows, subtract the quick look's elapsed time from the full think budget (floor 100 ms) so the total stays within the configured think time.
2. **Warm the main Stockfish worker** after start-up exactly like the ponder workers (`SF_WARM_FEN`, `go movetime 10`, then `ucinewgame` + `isready`), before `sfReady` resolves. It must not delay the first move by more than ~50 ms; measure it.
3. **Debug info**: add `background.stockfish.searchMode`, last search's `depthDone`, `softMs`, `elapsedMs`.

---

## 5. Tests and verification

* Create `tests/` with plain Node test files (`node:assert`, no frameworks): at least `tests/ponder.test.js`, `tests/search-mode.test.js`, `tests/boardstate-signature.test.js`, `tests/settings.test.js` (new keys sanitize / export / import round-trip). Load modules the way they are written (they attach to `globalThis.CV` and some export via `module.exports`); load `chessmini.js` before modules that need `CV.chess`.
* Run: `for t in tests/*.test.js; do node "$t" || exit 1; done` — all green.
* Syntax check every root and engine wrapper script: `for f in *.js engine/sf-worker.js engine/aggro-worker.js; do node --check "$f"; done`.
* Run the T3 benchmark and record the numbers.
* If possible, run a Node simulation of the background with fake workers for T1/T7 (the hand-over mentions such tests existed; recreate a minimal fake `Worker` + fake `browser.runtime`), at least: early ponder → hit; discarded move → miss; deepening pass replaces a shallower result.
* You cannot run real Firefox or chess.com. List every behaviour that still needs a real-browser check.

## 6. Documentation and release

1. `manifest.json` version `1.9.0`; `FALLBACK_VERSION` in `content.js` too.
2. `docs/REFERENCE.md`: new settings rows (key, range, default, what it does), a **1.9.0** changelog entry listing T1-T10 with what is verified and what is not, the benchmark table.
3. `README.md`: update "When pondering starts today", "Where the time actually goes" and the settings it mentions so they describe 1.9.0.
4. `chessvision-project-summary.md`: add "What was done in the 1.9.0 work" in the same format as the existing sections (what, why, measured, not verified, open points). Keep the rules section.
5. Build `chessvision-1_9_0.zip` of the extension (everything except `.git/`, `tests/`, `docs/`) into the repository root only if the user asks; otherwise just report the command.

## 7. Out of scope — do not do

* Premoves of any kind; anything that acts during the opponent's turn.
* Changes to the human-like behaviour other than T4/T5 (no new "humanisation" features).
* New permissions, host patterns, manifest keys, CSP changes, COOP/COEP.
* Swapping engine builds, adding the full-size Stockfish net, rebuilding AggroChess.
* Enabling `PONDER_STEPPED` or changing `SF_RANK_MODE` defaults without a benchmark.
* Editing `allowed-pages.txt` or `engine/NOTICE.txt`.

## 8. Final report (your last message)

* One line per task T1-T10: done / partially done / skipped, with the reason.
* Test results (command and pass count) and the benchmark table.
* The list of things that need checking in real Firefox / on chess.com.
* Every default you changed and how to get the 1.8.0 behaviour back.
