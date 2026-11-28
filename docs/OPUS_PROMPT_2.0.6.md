# Task: ChessVision 2.0.6: more main-search threads, a main-search hash setting, a relaxed-SIMD threaded Stockfish, and a temporary ponder-stats recorder

You are working on **ChessVision**, the Firefox (Manifest V2) extension in this repository (version 2.0.5). It runs two local WebAssembly engines, Stockfish 19 lite and AggroChess 4.6.1, plus a pool of ponder workers that prepare replies while the opponent thinks.

**Goal:**
1. A stronger main Stockfish search on our own move: more threads (§4 A), a larger hash (§4 B) and a faster threaded build (§4 C).
2. A **temporary** recorder (§4 D) that collects ponder results per ponder-worker count over hundreds of games and exports them as **one text file**. The owner will use it to choose the worker count.

Finish with version **2.0.6**.

How to work:
- Read every function before you change it.
- Measure before and after where a task names something to measure. A measured "no gain" is a valid result: revert that task and record the numbers and the reason.

---

## 1. Context: what the owner measured on the target device

- **Device:** phone, MediaTek Dimensity 9500, 8 cores (1 × 4.21 GHz C1-Ultra, 3 × 3.5 GHz C1-Premium, 4 × 2.7 GHz C1-Pro, no efficiency cores). Firefox Nightly 163 for Android.
- **Multi-threading works:**
  - The owner set `dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled = true` in `about:config`.
  - Copy debug info then showed `stockfish.active = engine/stockfish-19-lite.js`, `threads 4`, `threadedFailed null`, `sab.ok true`. `crossOriginIsolated` stayed false.
  - `navigator.hardwareConcurrency` is 8, so `ponderCap` reached 5, 6 and 7 as set.
- **Settings used:**
  - engine Stockfish, `sfSearchMode 'clock'`, `sfMaxMs 2500`, depth 20;
  - `sfThreads 4`, `sfPonderMs 3000`, `sfPonderHashMb 64`, `ponderMaxMs 8000`;
  - `minDelay = maxDelay = 0`, `humanize` off;
  - 1-minute games.
- **Ponder results:** the counters were cumulative across runs; per run:

  | Workers | Attempts | Hits | Late | Misses |
  |---|---|---|---|---|
  | 5 | 27 | 20 | 5 | 0 |
  | 6 | 29 | 13 | 9 | 1 |
  | 7 | 13 | 9 | 3 | 1 |

  Misses are near zero. "Late" (a reply was planned but not finished) is the main loss and depends on how fast the opponent moves.
- **Depths:** hit depths 15-20; main search depth 17-22 in 1-2.5 s. `hitTopUp` never ran, because the delays are 0.
- **Worker kills in the 6-worker run:** `no readyok after stop` ×4 and `start failed` ×1, with `cancelMs` up to 64 ms. That is likely CPU oversubscription when the 4-thread main search starts on a late/miss while 6 ponder workers are still stopping.

## 2. Read first

- `README.md`, `chessvision-project-summary.md`, and the 2.0.2 / 2.0.4 / 2.0.5 changelog in `docs/REFERENCE.md`.
- `docs/OPUS_PROMPT_2.0.4.md` §2 (Rules). Those rules stay binding unless §3 below overrides them; this includes the `allowed-pages.txt` privacy rule.
- `background.js`, all of it, especially:
  - `sfSpawn`, `sfApplyThreads`, `sfAttach`, `sfModuleFor`, `sfCandidates`, `analyzeStockfishNow`;
  - the Stockfish ponder section (`runIdleSfJob`, `createReplyPasses`, the sf ponder worker), `ponderClaim`, `ponderTopUp`, `ponderCancel`;
  - the `aggroDebug` message;
  - the storage code for saved games (`saveGame` / `listGames`).
- `settings.js`:
  - DEFAULTS / LIMITS, `sanitize`, `fixRanges`, `exportSettings` / `importSettings`;
  - `CV.sabSupport`, `CV.sfThreadCount`, `CV.ponderWorkerCount`, `CV.createPonderState` (`decide`, `counters`);
  - the `CV.*` behaviour constants.
- `content.js`: where pondering is requested (`aggroIdle`), where the engine answer is played, game-start / game-end detection, and the debug-info builder.
- `overlay.js`: the panel, `slider`, the Stockfish options section, `copyOrShow`, `downloadText` / `downloadOrCopy`.
- `engine/sf-worker.js`, `engine/NOTICE.txt`.
- `tools/build-stockfish.sh`, `tools/package.sh`.
- `tests/*`, especially `background-sim.test.js`, `sf-wrapper.test.js`, `settings.test.js` and `notice.test.js`.

## 3. Rules for this version (overrides)

- Engine binaries **may** change, but only through `tools/build-stockfish.sh` (§4 C).
  - Every shipped engine file is rebuilt reproducibly from the pinned source and recorded with its sha256 in `engine/NOTICE.txt`.
  - The existing files stay in place as fallbacks.
- **2.0.5 behaviour stays reachable:**
  - `sfThreads` and the new `sfHashMb` default to the 2.0.5 values (1 and 32).
  - The relaxed-SIMD threaded build has a `CV.*` constant whose `false` restores the npm threaded build.
- The recorder (§4 D) is **temporary**:
  - It sits behind `CV.PONDER_STATS` (default `true` in 2.0.6).
  - Its code is in clearly marked blocks (`// PONDER_STATS (temporary) begin/end`) so it can be removed in one pass.
  - It must never change what the engines search or play.
- **No new dependencies at runtime.** The build may use the pinned toolchain the script already uses.
- **Checks:**
  - Tests stay green: `for t in tests/*.test.js; do node "$t" || exit 1; done`.
  - Run `node --check` on every root script and both engine wrappers.
  - Add tests for every new pure function.
  - Mark anything that needs real Firefox or the phone as **unverified**. Chromium/Playwright is available; Firefox is not.

## 4. Tasks

### A. Main search: up to 7 threads

1. Raise `CV.LIMITS.sfThreads` to `[1, 7, 1]`.
   - `CV.sfThreadCount` already caps at `max(1, hardwareConcurrency - 1)` and returns 1 without SharedArrayBuffer. Keep both rules.
   - A 4-core device stays at 3 at most.
2. **Why this is safe:** the main search runs on our turn, when the ponder workers are idle. A ponder job only starts once our move is decided (`earlyPonder`).
3. **The overlap case:** on a `late` / `miss`, the main search starts while the ponder workers are still answering `stop` (`stop` + `isready`, usually < 30 ms).
   - Measure in Chromium, with a fake slow stop, whether the main `go` should wait until the ponder workers report stopped, for at most `CV.SF_MAIN_WAIT_STOP_MS` (new constant, e.g. 40 ms; 0 = 2.0.5).
   - Keep it only if it measurably reduces `no readyok after stop` kills without delaying the move by more than that cap.
   - Otherwise leave it at 0 and record why.
4. Update the panel note under Stockfish options, the REFERENCE settings table, and the README engine table.

### B. Main search: a hash setting

1. Add the setting `sfHashMb`: default **32** (= 2.0.5), LIMITS `[16, 256, 16]`. Wire it through:
   - `sanitize` and export / import;
   - the panel (a slider in Stockfish options);
   - the REFERENCE settings table.
2. Apply it to the main worker only (single-thread and threaded builds alike). Ponder workers keep `sfPonderHashMb`.
   - At start-up: `sfSpawn(..., { hashMb })`.
   - On a change: `setoption name Hash value N`, sent only when the main worker is idle (never during a search) and only when the value changed.
   - A changed Hash clears the table, which is acceptable.
3. **Memory limits:**
   - Read the engine's reported `option name Hash ... max`, and the build's `MAXIMUM_MEMORY` (threaded builds use a fixed-size shared memory).
   - If 256 MB does not fit a build, cap the LIMITS at what fits and say so in the docs.
   - Record measured resident memory for 32 / 64 / 128 / 256 MB with 4 threads in Chromium.
4. **Measure:** depth reached and nodes in a 1 s and a 2.5 s search, 4 threads, 32 vs 128 MB, on the 10 middlegame positions of `tests/bench-delay-mode.js` (in Chromium if the threaded build cannot run in Node).

### C. A relaxed-SIMD threaded Stockfish build

1. Extend `tools/build-stockfish.sh`:
   - Build the threaded lite build: stockfish.js `build.js --lite --no-split`, without `--single-threaded`.
   - The plain threaded build must reproduce `engine/stockfish-19-lite.{js,wasm}` byte for byte (the shipped npm 19.0.1 files), as the plain single build already does. If it does not, stop and report the difference; do not ship an unverified rebuild.
   - Then build the same with `RELAXED_SIMD=yes`. Output: `engine/stockfish-19-lite-rsimd.{js,wasm}`.
   - Byte-scan the output for the relaxed dot instruction, as for the single build.
   - The toolchain needs network access (github.com, storage.googleapis.com, registry.npmjs.org, and the net host). If it cannot be fetched here, do not fake the build: finish everything else, and leave the build step documented and ready for the owner to run.
2. In `background.js`, turn the threaded engine into a candidate list:
   - order: relaxed-SIMD threaded build (when the existing relaxed probe `sfRelaxedOk` passes and `CV.SF_THREADED_RSIMD` is true), then the npm threaded build, then the single-thread engine (as now);
   - any failure falls back one step and is remembered, as `sfDbg.threadedFailed` / `rsimdFailed` are now.
3. Check how the threaded loader's pthread workers find their script and `.wasm`:
   - Today the loader gets `#<wasm url>,worker` in its URL; the `.wasm` name is derived per file.
   - The rsimd threaded file must load its own `.wasm`, never the plain one.
   - Test this in Chromium with a COOP/COEP-served page.
4. **Correctness:** at `Threads 1` the rsimd threaded build must give the same depth-14 bench signature as the single builds (748 260 nodes). Add the signature check to `tests/engine-signature.test.js` if it can run in Node; otherwise as a Chromium check, documented.
5. **Measure:** nodes per second at Threads 1 / 2 / 4 / 7, npm threaded vs rsimd threaded, in headless Chromium. The expectation is about +30% per thread (the single-thread gain was 545 → 776 k/s in Chromium).
6. **Packaging and docs:**
   - Add the new files to `engine/NOTICE.txt` (sha256, source, flags).
   - `tools/package.sh --lean` now **keeps** both threaded builds: they do run on Firefox Nightly with the pref above. Lean drops only the asm.js fallback.
   - Update the lean test in `background-sim.test.js`, the comments in `package.sh`, the README packaging note, and every "extension pages have no SharedArrayBuffer" statement. It is now: true on release Firefox; on Nightly with `dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled` the threaded build runs (owner-verified on Android, 2.0.5).

### D. Temporary: ponder-stats recorder and export (one text file)

**Purpose.** The owner will play a few hundred games with different `sfPonderWorkers` (and maybe `aggroPonderWorkers`) values within one or more sessions, then export **one text file** and hand it over to decide the best worker count. The file must hold every run, divided by the worker count, with enough per-move detail to separate the effect of the worker count from how fast the opponent moved.

1. **Where the data comes from.** Record in `background.js`, where `ponder.decide()` runs and `ponderCap` is known.
   - One record per decision: `hit`, `late`, `miss`, `none`, and `skipped` from `ponder.skip()`.
   - The page sends the move-latency and game-boundary fields it alone knows (step 2) in its next message, or in a small new message.
2. **Per-move record**, compact: an array or a short-keyed object.
   - **Run key:**
     - engine, effective ponder workers (`ponderCap`), the worker setting, effective main threads;
     - `sfPonderMs` / `aggroPonderMs`, `ponderMaxMs`, ponder hash MB, main hash MB;
     - search mode, threaded build in use (file name).
   - **Game:** a game number within the recorder (it increases on each new game) and the initial clock in seconds, if readable.
   - **Decision:** the decision; whether a late reply was harvested, and its depth; the reply depth on a hit; the main-search depth on a late / miss.
   - **Opponent think time:** ms from our move landing on the board to the opponent's move being observed. This is essential: "late" depends on it.
   - **Lead time:** ms from the ponder job start to the opponent's move (`leadMs`).
   - **Rank:** the rank of the opponent's actual move in the ranked list (0 = first; null if unranked).
   - **Our move latency:** ms from observing the opponent's move to our move landing. This is the number "faster" should improve.
   - **Kills:** worker kills since the previous record, by reason (from `sfDbg.kills`), as deltas.
3. **Storage.**
   - Keep the records in `browser.storage.local` under one key (e.g. `ponderStats`), with a format version.
   - Follow the 2.0.4 storage discipline: buffer in memory, write at a game end and at most every 10 s, never per move. On load, merge with what is stored.
   - Cap the total, e.g. 60 000 records or about 5 MB. Drop the oldest whole games first, and count what was dropped.
   - The data survives an extension reload and a browser restart until the owner resets it.
4. **Panel**, only when `CV.PONDER_STATS` is true: a small "Ponder stats (temporary)" block in the debug area, next to Copy debug info, with three buttons.
   - **Download stats:** one file, `chessvision-ponder-stats-<date>.txt`, through the existing `downloadText`, falling back to copy (`downloadOrCopy`). Make the MIME type `text/plain`; `downloadText` currently hard-codes the PGN type, so add a parameter.
   - **Copy summary:** copies only the summary table (5 b).
   - **Reset stats:** asks for confirmation, then clears the stored records.
   - A status line under the buttons shows: records, games, and the current worker count.
5. **File format**, plain text, readable by a person and parseable by a script:
   - a) **Header:** ChessVision version, export time, user agent, `hardwareConcurrency`, record and game counts, dropped count.
   - b) **Summary table**, one row per distinct run key; the first column is the worker count, and rows are sorted by engine, then worker count:
     - games, attempts, hits, late, misses, none, skipped;
     - hit / late / miss %;
     - late harvested;
     - median and p90 opponent think time;
     - median and p90 our move latency;
     - median hit depth;
     - kills by reason.
   - c) **Hit rate by opponent think time**, per worker count, in buckets `<0.5 s, 0.5-1 s, 1-2 s, 2-4 s, >4 s`. This is the fair comparison between worker counts.
   - d) **Section per worker count:** `=== workers: N (engine, threads T, ponderMs P, ...) ===`, then one CSV block with a header line and one line per record.
   - Keep everything in **one file**, divided by worker count, not one file per count.
6. **Pure functions in a new `ponderstats.js`**, loaded by the background page (add it to the manifest's background scripts and to `package.sh`):
   - `CV.ponderStatsAdd`, `CV.ponderStatsTrim`, `CV.ponderStatsSummary`, `CV.ponderStatsFormat`;
   - tests in `tests/ponder-stats.test.js` for grouping by run key, the buckets, medians / p90, the cap / trim, and that the format round-trips: parse the CSV blocks back and get the same records.
7. **It must not change behaviour.** A test in `background-sim.test.js` runs the same simulated game with `CV.PONDER_STATS` on and off and checks the same moves and timings, apart from the storage writes.
8. **Removal.** Document in REFERENCE ("Temporary: ponder stats") how to remove the recorder: delete `ponderstats.js`, the marked blocks, the manifest entry and the test.

## 5. Done when

- [ ] `sfThreads` 1-7 (capped at cores − 1); the `SF_MAIN_WAIT_STOP_MS` decision is made with numbers.
- [ ] `sfHashMb` 16-256 (or the measured cap), default 32, applied to the main worker only; depth / memory numbers recorded.
- [ ] `tools/build-stockfish.sh` builds the threaded plain build (byte-identical to npm) and `engine/stockfish-19-lite-rsimd.{js,wasm}`; the fallback chain is tested; the Threads 1 signature matches; nps at 1 / 2 / 4 / 7 threads recorded. If the toolchain could not be fetched, this is marked not done, with the exact command for the owner.
- [ ] Ponder-stats recorder, panel block, a one-file export with summary / buckets / per-worker CSV sections, reset; all behind `CV.PONDER_STATS` and in marked blocks.
- [ ] Version 2.0.6 in `manifest.json`, the README and REFERENCE; a changelog entry listing every measured number and everything **unverified** (real Firefox Nightly on the phone: threads above 4, the rsimd threaded build, hash memory, the recorder's download on Android).
- [ ] All tests green; `node --check` clean; `tools/package.sh` and `tools/package.sh --lean` pass their zip checks.

## 6. Report back

- Measured numbers: threads, hash and the rsimd threaded build.
- What was not done, and why.
- Exact owner steps on the phone:
  1. Settings to use for a worker-count test run, one variable at a time: workers 4 / 5 / 6 / 7, with the same `sfThreads`, `sfPonderMs` and time control.
  2. Reset the stats before the first run.
  3. Export once at the end.
