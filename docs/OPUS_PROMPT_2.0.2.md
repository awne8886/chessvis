# Task: ChessVision 2.0.2: faster engines, workers and pondering

> **Status (2026-11-23): implemented as ChessVision 2.0.2**, one commit per task (A0-A7, B1, C1-C4, D). `AggroChess-4.6.1-wasm.zip` was not available: with the owner's approval the web wrapper was reconstructed on top of AggroChess v4.6.1 from GitHub and accepted because it reproduces the 2.0.0 binaries call for call and the §3 signatures exactly (`engine-src/aggrochess/README.md`). Gates passed: A1, A2, A4, A5, A6, A7 (Chromium), B1. Not adopted (measured): A3 eval cache (below the +5% gate). Not done (optional): the C4 peek (it cannot save 15 ms). No search change was made, so no strength match was needed. Results and the unverified points: `docs/REFERENCE.md` (2.0.2 changelog) and `chessvision-project-summary.md`.

You are working on **ChessVision**, the Firefox (Manifest V2) extension in this repository (version 2.0.0). It plays chess.com **bots** with two local WebAssembly engines: **Stockfish 19 lite** (UCI, `engine/stockfish-19-lite-single.{js,wasm}`) and **AggroChess 4.6.1** (Rust → wasm, `engine/aggrochess{,-simd}.wasm`).

**Goal:** the reply should be ready almost at once and be **at least as deep as today**. To get there:
1. raise engine speed (nodes per second) with search-identical optimizations;
2. stop wasting engine time;
3. make the workers and pondering cheaper and more often useful.

Finish with version **2.0.2**.

How to work:
- Read every function before you change it.
- Measure before and after every task. If a task misses its gate, revert it and record the numbers and the reason. A measured "no" is a valid result.

---

## 0. Inputs

- This repository.
- **`AggroChess-4.6.1-wasm.zip`**: the wasm crate that the shipped binaries come from.
  - Contents: `source/Cargo.toml`, `build.rs`, `src/{lib,search,eval,nnue,book,matesearch}.rs` and the two embedded nets.
  - `engine/aggrochess-4.6.1-chessvision.patch` applies to it with `patch -p0`, run from inside `source/`.
- **`AggroChess-main.zip`**: the native UCI engine.
  - `search/eval/nnue.rs` are the same as the crate's, apart from the clock and seed shims.
  - It also has `uci.rs`, `tests/*.epd` and the trainer.
  - Use it for native profiling and for strength matches.

If the zips are not attached, stop and ask for them.

## 1. Read first

- `README.md` and `chessvision-project-summary.md` (its rules stay binding unless §2 overrides them).
- The 2.0.0 changelog in `docs/REFERENCE.md`.
- `background.js`: all of it.
- `content.js`: `play`, `askEngine`, `idleWork`/`startIdle`, `scheduleStable`, `check`, the watchdog.
- `settings.js`: DEFAULTS/LIMITS, `createPonderState`, the ponder/`sf*`/`aggroBudget` helpers.
- `engine/aggro-worker.js`, `engine/sf-worker.js`, `tests/*`.
- In the crate: `lib.rs`, `nnue.rs`, and these parts of `search.rs`: the TT, `Searcher::new`, `static_eval`, `check_time`, `search_position_inner`.

## 2. Rules

**Scope: speed only.**
- Leave these unchanged: `allowed-pages.txt`; the manifest's matches, permissions and CSP; and the humanization behaviour and its defaults (delays, hesitations, cursor, input mode).
- The only manifest change is `"version": "2.0.2"`.

**Engine binaries may change now.** This lifts the 2.0.0 "byte-identical" rule, under these conditions:
- **Reproducible builds.**
  - Add `tools/build-aggrochess.sh` (and `tools/build-stockfish.sh` if B1 ships). Pin the toolchain versions in them.
  - Keep the complete ChessVision change set to the 4.6.1 crate in the repo: either the updated patch file, or the patched crate under `engine-src/aggrochess/` (not loaded at runtime).
  - Record the sha256 of every shipped binary in `engine/NOTICE.txt` and in the summary.
  - Updating `NOTICE.txt` is required for this task. It overrides the old "don't read NOTICE.txt" rule for that one file.
- **Pure speedups must keep the bench signature (§3) bit-identical:** same total nodes, same best moves.
  - Anything that changes the signature is a search change.
  - Keep a search change only after a strength check: at least 200 games at fixed time against the old binary, with no Elo loss within the error bars. State the result.
- **Fallbacks stay:**
  - the plain (non-SIMD) AggroChess build;
  - the current Stockfish lite-single build;
  - the asm.js file.
  - New variants are picked by `WebAssembly.validate` probes. Any failure falls back to the old file.

**Other rules:**
- **Dependencies:** new or newer *build tooling* is welcome (Rust, binaryen/wasm-opt, emsdk). The extension itself stays plain JS: no bundler, no runtime npm packages.
- **No threads or SharedArrayBuffer work.** Firefox extension pages have no SAB and ignore the COOP/COEP manifest keys (bugzilla 1673477, 1750654). Leave `sfThreads` as it is.
- **Pondering never delays a real search.** The exceptions are the bounded waits that already exist (`late`, harvest) and any new wait that a task below defines with an explicit cap.
- **2.0.0 behaviour stays reachable.** Each behaviour change gets a setting or constant that restores it. New settings go into DEFAULTS/LIMITS/ENUMS, the panel and the REFERENCE settings table.
- **Checks:**
  - Tests stay green: `for t in tests/*.test.js; do node "$t" || exit 1; done` (5 files today).
  - Run `node --check` on every root script and both engine wrappers.
  - Mark anything that needs real Firefox or chess.com as **unverified**.
- **One commit per task.**

## 3. Measured baseline

Conditions: Node 22 (V8), x86-64, 4 shared cores, about ±15% noise from run to run. Interleave builds and report the median of at least 3 runs.

```
BENCH_FENS =
r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1
r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4
r2q1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 9
rnbqkb1r/pp3ppp/4pn2/2pp4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq - 0 5
2r3k1/pp3ppp/2n1b3/3pP3/3P4/P1N2N2/1P3PPP/2R3K1 w - - 0 20
r1b2rk1/2q1bppp/p2ppn2/1p6/3BPP2/2NB1Q2/PPP3PP/R4RK1 w - - 0 14
4rrk1/pp1n3p/3q2pQ/2p1pb2/2PP4/2P3N1/P2B2PP/4RRK1 b - - 7 19
r3r1k1/2p2ppp/p1p1bn2/8/1q2P3/2NPQN2/PPP3PP/R4RK1 b - - 2 15
8/8/3k4/3p4/2pP1K2/2P5/8/8 w - - 0 1
6k1/5pp1/7p/8/3R4/6P1/r4P1P/6K1 w - - 0 40
```

### AggroChess bench signature

Use the 4.6.1 crate + the patch, rebuilt, with one bench-only export added: `last_info()`, which returns the last `info depth` line.

Procedure:
1. Instantiate with `js_random` = LCG, seed 12345: `s = (s*1103515245+12345) & 0x7fffffff; return s/2**31`.
2. Call `set_tt_mb(32)`.
3. Run one `think(30)` on FEN 1.
4. For each FEN: `clear_hash(); set_position(''); set_position(fen+'|'); think_depth(D, 3500)`, then add the `nodes` from `last_info()`.

Expected results (plain and SIMD builds agree):

| D | Nodes | Best moves |
|---|---|---|
| **12** | **1 422 083** | `e5g6 f3g5(book) e1g1 c1g5 c3e2 e4e5 f5d3 f6g4 f4f5 d4d8` (the shipped binaries play the same moves) |
| **8** | **118 270** | (about 0.15 s, usable as a unit test) |

Keep `hard < 4000` ms. From 4000 ms on, the search switches on deep mode (`DEEP_MIN_MS`), Tal's look and the forcing lines, and then time decides how far it gets, not depth: `think_depth(9, 600000)` took about 4 s whatever the depth.

### Stockfish bench signature

Procedure: `setoption name Hash value 32`; then for each FEN, `ucinewgame` and `go depth 14`; add the nodes from the last `info depth` line.

Expected: **748 260 nodes**, moves `d5e6 d2d3 e1g1 c4d5 c3b5 e4e5 f5d3 b4b2 f4f5 d4d8`.

### Numbers

| What | Value |
|---|---|
| AggroChess SIMD, think(100 / 300 / 1000) | avg depth 11.4 / 13.6 / 16.4; 500-680 knps |
| AggroChess profile (`node --cpu-prof`, think(1000); the wasm name section is kept) | `Searcher::search` incl. inlined movegen 30%, **NNUE `evaluate_with` (SCReLU output) 20%**, **`eval::compute` (personality layer) 10%**, TT `probe` 8%, `push_acc` 7%, `qsearch` 6%, `quiet_score` 5%, `play_unchecked` 3%, `__multi3` 0.5%, `js_now` 0.1% |
| Prototype: explicit `core::arch::wasm32` SIMD for `screlu_dot` + accumulator `update` | **signature identical**, 790-850 vs 530-680 knps (+20-45%); think(300) depth 13.6 → 14.1 |
| Prototype: TT bucket without the `u128` multiply (`__multi3` on wasm32) | signature identical, gain within noise |
| wasm-opt -O3 (binaryen 132) | 2.07 → 1.84 MB, speed within noise |
| AggroChess time floors | `think`/`think_clock` floor at 30 ms (`think(1)` = 28.6 ms); `analyze` floors at 20 ms |
| AggroChess start-up | first search of a fresh instance 30-57 ms; TT ≈ 0.5 ms per MB; `clear_hash` (32 MB) 3-5 ms; `Searcher::new` + depth-1 search 0.2 ms (not worth touching) |
| Stockfish shipped lite-single | 510-575 knps; `uci` → `readyok` about 165 ms; **identical signature to lichess `@lichess-org/stockfish-web` `sf_19_smallnet`** (SF 19 + net `nn-61e7af4bb97d`) |
| Same engine with **relaxed SIMD** (lichess `sf_19_smallnet_relaxed-simd`, Threads 1, Node) | **signature identical, 690-715 knps (+24-34%)**. Binary scan: the shipped file uses `i32x4.dot_i16x8_s` (24×) and no relaxed ops; the relaxed build has 48× `i32x4.relaxed_dot_i8x16_i7x16_add_s` |
| Versions | npm `stockfish` 19.0.1 is still the latest; `cozy-chess` 0.3.4 is the newest |
| Firefox | relaxed SIMD on by default since ~146 (caniuse; bug 1930192); JSPI intent to ship in Fx153 (feature-detect `WebAssembly.Suspending` / `WebAssembly.promising`) |

---

## 4. Tasks

### A: AggroChess engine (crate → `engine/aggrochess{,-simd}.wasm`)

**A0. Tooling and baseline.**
1. Write `tools/build-aggrochess.sh`. It applies the patch(es), adds the `last_info` export, and builds both variants:
   - plain;
   - SIMD: `RUSTFLAGS="-C target-feature=+simd128"`;
   - both with `cargo build --release --target wasm32-unknown-unknown`.
2. Add `tests/bench-engines.js` (a benchmark, not a test). It prints, per build: the signature, knps, the average depth at think(100/300/1000), and the first-search ms.
3. Add `tests/engine-signature.test.js`. It checks the depth-8 AggroChess signature of both shipped builds; record the expected numbers from the **unchanged** rebuild first.
4. Confirm that the unchanged rebuild plays the shipped binaries' moves.

**A1. Explicit wasm SIMD for the NNUE.**
- Where: `nnue.rs`, a `#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]` module.
- `screlu_dot`:
  - `v = i16x8_min(i16x8_max(acc, 0), QA)`;
  - `vw = i16x8_mul(v, w)`;
  - `sum = i32x4_add(sum, i32x4_dot_i16x8(v, vw))`, with two accumulators;
  - widen to i64 only at the end.
  - This is exact: `|v·vw| ≤ 255·32385`, and with 32 steps per lane nothing overflows i32.
- `update()` (all four add/sub shapes) and `refresh_with`: `i16x8_add` / `i16x8_sub`.
- **Gate:** identical signature and at least +15% knps.

**A2. wasm32 micro-fixes.**
- TT bucket: replace the u128 multiply with `hi = (h>>32)*b + (((h & 0xffffffff)*b) >> 32); (hi>>32)*2`. This is exact for `b < 2^32`.
- Look in the profile for other `compiler_builtins` helpers or f64 math in hot paths, and replace them exactly.
- **Gate:** identical signature.

**A3. Eval cache (experiment).**
- Design: a direct-mapped cache inside each `Searcher`, 2^14-2^16 entries, keyed by the full hash. It stores the final `static_eval` value and is cleared at the start of every search, because the engine colour and deep mode can change between searches.
- First measure how often the TT `eval` field already saves a `static_eval` call.
- **Gate:** identical signature and at least +5% knps; otherwise drop it.

**A4. Honour small budgets.**
- The problem:
  - AggroChess ranking scans request `PONDER_SCAN_MS` (5-12 ms per opponent move) through `analyze`, which floors at 20 ms. A 30-move ranking pass therefore costs at least 600 ms of worker time instead of at most 360 ms.
  - Quick looks can never go below the 30 ms `think` floor.
- The fix:
  - Add variants with a floor of about 3 ms (new exports or an extra argument; the old exports behave as before).
  - Use them from `aggro-worker.js` for the scans.
- **Check:** the ranking quality at the real scan budget. Compare the hit rate against the 20 ms floor with a small hit-rate simulation. The 1.8.0 `bench-stockfish-sims.js` is not in the repo, so write one: an engine opponent, and count how often its move is among the top k ranked moves.

**A5. Build.**
- Use the newest stable Rust and wasm-opt `-O3` with explicit feature flags. Confirm the feature set (bulk-memory, nontrapping-fptoint, sign-ext) with `wasm-tools` or `wasm-dis`.
- Keep wasm-opt for size and compile time if the signature holds.
- Do **not** try relaxed SIMD here: the net is i16 × i16 (QA 255), and the relaxed i8 × i7 dot does not apply.

**A6. Faster start-up (optional; every replacement ponder worker pays this cost).**
- Use the nets zero-copy: read the `include_bytes!` data as aligned `&[i16]` (wasm is little-endian) instead of collecting it into `Vec<i16>`.
- Allocate the TT zeroed (`alloc_zeroed` / `vec![0u64; n]`; fresh wasm pages are already zero) instead of pushing 2M `AtomicU64`s one by one.
- **Gate:** identical signature; report the first-search ms and the worker warm-up ms.

**A7. Interruptible AggroChess via JSPI (gated, feature-detected).**
- Rust:
  - in `check_time`, call a new import `js_poll() -> i32` at most every ~8 ms (use the existing clock reads);
  - a non-zero return sets `stop`;
  - the search then returns the best move of the last completed iteration.
- `aggro-worker.js`:
  - If `WebAssembly.Suspending` and `WebAssembly.promising` exist:
    - `js_poll` = `new WebAssembly.Suspending(async () => { await tick(); return stop ? 1 : 0; })`, where `tick()` is a `MessageChannel` round trip;
    - wrap `think`, `think_clock`, `think_depth` and `analyze` with `WebAssembly.promising`;
    - queue requests so that nothing re-enters wasm while it is suspended (only `{type:'stop'}` acts at once, and it only sets the flag);
    - report `interruptible: true` in `ready`.
  - Otherwise, `js_poll` returns 0 (today's behaviour).
- Background, for interruptible workers:
  - cancel = `stop` + wait for the reply (cap 150 ms, then terminate);
  - recycle the worker like a Stockfish ponder worker;
  - `late` may stop the search and use its move so far.
- **Gate:**
  - polling overhead at most 2% knps;
  - median stop latency at most 15 ms. Measure in headless Chromium through the preinstalled Playwright (JSPI is on there), or in a Node build with JSPI.
  - On Firefox this is unverified. Debug info must show `interruptible`.

### B: Stockfish

**B1. Single-thread relaxed-SIMD build.** Timebox it; ship only if the gate passes.

The evidence is in §3: +24-34% knps with the search unchanged. The lichess binaries cannot be shipped, though:
- they are pthread (SAB) builds;
- they need an external net;
- they are AGPL.

Steps:
1. Build the lite-single target of `nmrugg/stockfish.js` v19.0.1 with the same emsdk and flags as the release. Reproduce the shipped signature and roughly the shipped size first.
2. Add relaxed SIMD to the NNUE int8 dot/affine path. Licensing:
   - Check upstream Stockfish's wasm SIMD code first.
   - The lichess `patches/sf_19.patch` is AGPL. Prefer your own few-line intrinsic helper (`wasm_i32x4_relaxed_dot_i8x16_i7x16_add`; it is deterministic because the activations are clipped to 0..127).
   - Otherwise record the AGPL terms in `NOTICE.txt`.
3. Keep the loader API identical, so `sf-worker.js` and the shared-Module path keep working.
4. Ship it as `engine/stockfish-19-lite-single-rsimd.{js,wasm}`.
5. Select it when `WebAssembly.validate(RELAXED_PROBE)` accepts a tiny module with one relaxed op (test the probe in Node). Otherwise use the current file.
6. Show the active file in Copy debug info.

**Gate:** identical depth-14 signature; at least +15% knps; it starts through the wrapper + shared Module.

### C: Workers and pondering (JS)

**C1. Recycle AggroChess ponder workers.**
- The problem: `ponderStop`/`ponderCancel` and the end of every job (`ponderDrop`) terminate **every** AggroChess ponder worker, even the ones whose `think` already returned.
  - Each replacement is re-instantiated and re-warmed: about 30-60 ms of CPU and 32 MB of TT.
  - The next move's early-ponder job (`ponderClaim`) can get a cold, still-starting worker. Measure how often.
- The fix:
  - Track the in-flight request per worker. Terminate only the busy ones; idle ones go back to `ponderSpares` with their hash.
  - A `ponderGen` change sends `clear` before the worker is reused (Stockfish workers do this with `ucinewgame`).
  - Prefer giving the next job's first reply to the worker that searched the line that was played.
- **Tests (`_fakebg`):**
  - idle workers survive a cancel;
  - busy workers are killed;
  - a new game clears them.
- **Debug:** respawns per move.

**C2. Ponder hits never lose depth.**
- Today a hit returns the stored reply at once:
  - Stockfish pass-1 replies are `go depth N movetime slice`, so depth ≤ 10 by default;
  - PV seeds are at depth − 2;
  - with `ponderHitFast` the page then waits the quick pause (80-300 ms).
  - A miss in Delay mode reaches about depth 15.8-18.1 in Node (soft 300-800 ms). So a hit currently plays a **shallower** move.
- The new flow:
  1. The page draws the hit pause up front and sends it as `hitSoftMs`.
  2. On a hit whose stored depth is below what the main worker reaches in `hitSoftMs`, the background searches the position on the main worker within that time:
     - Stockfish: a delay-mode search;
     - AggroChess: `think(hitSoftMs)`, when `hitSoftMs` is at least the stored slice.
  3. The background returns the deeper result.
- The engine time stays inside a pause that is waited anyway, so no latency is added.
- The cursor needs the move early. Return the stored move as *provisional* for `aimMove`, and the final move before the click. Re-aim only if it changed, and count `hitChanged`.
- Put the decision in a pure helper (`CV.hitTopUp`) with unit tests.
- **Setting:** `ponderHitTopUp`, default on.
- **Debug:** hit depth before and after.

**C3. Pondering on by default.**
- Set `sfPonder: true` and `aggroPonder: true`, with 1 worker. 2.0.0 measured an 88% hit rate, and the owner wants instant replies.
- Document the CPU/battery cost and how to switch it off in README and REFERENCE.

**C4. Board → engine path.**
- Give the **watchdog** the stable read too. This is an open 2.0.0 point: half-updated watchdog reads cause tracker gaps, which become ponder misses.
- Measure `boardDebounceMs` at 80, 40 and 20 in a jsdom smoke harness with one-step and two-step board updates. The 2.0.0 harness was scratch-only, so put one in `tests/`. Lower the default only if gaps and misses do not rise.
- Optional: when the first read shows the opponent's move, send a non-binding `peek`, so the background resolves `decide()` (and the Stockfish harvest/stop) while the stable check runs. Keep it only if it saves at least 15 ms (median).

### D: Release 2.0.2

**Version:**
- `manifest.json` version;
- `content.js` `FALLBACK_VERSION`.

**Docs:**
- `README.md`: version mentions, the engine sections, "Measured numbers", "Where the time goes".
- `docs/REFERENCE.md`: a 2.0.2 changelog with before/after tables, and the new settings.
- `chessvision-project-summary.md`: what was done, measured, unverified and still open.
- `engine/NOTICE.txt`: sources, build commands, sha256.
- Save this prompt as `docs/OPUS_PROMPT_2.0.2.md` with a status line.

**Final report**, as one table:
- AggroChess: signature, knps, depth at think(100/300/1000);
- Stockfish: signature, knps, start ms, depth at soft 300/800;
- pondering: hit rate, hit depth, AggroChess respawns per move, early-ponder lead;
- plus every gate that failed, and every point still unverified in real Firefox or on chess.com.

## 5. Don't redo (already measured, no gain or not possible)

- Threads / SAB.
- Stockfish hash 64/128.
- UCI `go ponder` with one guessed move (52% vs 88%).
- Swapping the main and ponder roles after a hit (+0.25 ply).
- Relaxed SIMD for AggroChess.
- The lichess binaries as a drop-in replacement.
- wasm-opt for speed (it only helps size).
- A cozy-chess upgrade.
- Speeding up `Searcher::new`.

## 6. Order if time runs short

A1 → C1 → A4 → C2 → B1 → C3 → A2/A3/A5/A6 → C4 → A7
