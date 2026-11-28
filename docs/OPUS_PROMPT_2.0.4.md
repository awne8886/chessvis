# Task: ChessVision 2.0.4: less idle work, less memory, faster moves

You are working on **ChessVision**, the Firefox (Manifest V2) extension in this repository (version 2.0.3). It plays chess.com **bots** with two local WebAssembly engines, Stockfish 19 lite and AggroChess 4.6.1.

**Goal:** the same moves, found and played at least as fast as in 2.0.3, at a much lower cost:
- far less work while nothing happens on the board;
- less memory in the background page;
- fewer storage writes;
- no slow paths in a hidden tab.

Finish with version **2.0.4**.

How to work:
- Read every function before you change it.
- Measure before and after every task where the task names something to measure. A measured "no gain" is a valid result: revert the task and record the numbers and the reason.

---

## 1. Read first

- `README.md`, `chessvision-project-summary.md` and the 2.0.2 / 2.0.3 changelog in `docs/REFERENCE.md`. Their rules stay binding unless §2 overrides them.
- `content.js`: all of it.
- `background.js`: all of it.
- `overlay.js`: `slider`, `refreshGames`/`renderGames`, `render`, `place`/`applyPosition`.
- `boardstate.js`: all of it.
- `chessmini.js`: all of it.
- `settings.js`: DEFAULTS/LIMITS, `sanitize`, `fixRanges`, `exportSettings`/`importSettings`, `CV.replayUci`, the `CV.*` behaviour constants.
- `pgn.js`: `mergeSaved` and `shouldSave`.
- `recorder.js`.
- `humanize.js`: `buildPath`.
- `tests/*`.

## 2. Rules

**Privacy: `allowed-pages.txt` is off limits.**
- Do not open, print, `cat`, `grep`, diff, copy into a log, or otherwise read `allowed-pages.txt`.
- Do not change it, rename it, or move it.
- If a test needs an allowlist, write an inline fixture with made-up entries.
- The packaging script (task F1) must include the file in the zip by path only, without reading its contents.
- Do not touch git history.

**Out of scope (the owner excluded these):**
- Gating the content scripts behind a small loader, or injecting them only on allowed pages. Keep the manifest's `content_scripts` file list and the overlay creation as they are. The one exception is the lichess match in task A5.
- The `DEBUG` flag in `content.js` and every existing `log(...)` call, including the one that prints the allowlist. Do not change them.

**Scope: speed and efficiency only.**
- Engine binaries, search behaviour and ponder logic stay as they are.
- Humanization behaviour and its defaults stay as they are (delays, hesitations, cursor path, click offsets, input mode). The only exception is the hidden-tab change in D1.
- Manifest changes: `"version": "2.0.4"`, and lichess in A5 if the owner confirms it.
- **2.0.3 behaviour stays reachable.** Each behaviour change gets a constant in `settings.js` (`CV.*`, like `CV.WATCHDOG_STABLE_READ`) whose `false` value restores 2.0.3.
  - Exception: the one-way saved-games migration in C2.
  - A user-facing timing gets a setting in DEFAULTS/LIMITS, the panel and the REFERENCE settings table.
- **No new dependencies.** The extension stays plain JS: no bundler, no npm packages at runtime.

**Checks:**
- Tests stay green: `for t in tests/*.test.js; do node "$t" || exit 1; done`.
- Add tests for every new pure function and for every equivalence claim below.
- Run `node --check` on every root script and both engine wrappers.
- Mark anything that needs real Firefox or chess.com as **unverified**. Chromium/Playwright is available for DOM-level checks; Firefox is not.

**One commit per task.**

## 3. Measuring

Build a small harness before you start. Either extend `tests/smoke-board.js` if it fits, or write a Node test with a fake DOM in the style of `tests/_fakebg.js`. It must count:
- board reads (`readPosition` calls);
- document-wide `querySelector`/`querySelectorAll` calls;
- `getBoundingClientRect`, `elementsFromPoint` and `elementFromPoint` calls;
- `runtime.sendMessage` calls;
- `storage.local.set` calls.

Count these for three scenarios:
1. **60 s idle:** our turn already handled, nothing changes on the board.
2. **60 s idle during the opponent's turn:** pondering is on.
3. **One full move cycle:** opponent moves → our move is played.

Record the 2.0.3 numbers first. Put the before and after tables in the REFERENCE changelog.

---

## 4. Tasks

### A: Content script, idle work

**A1. The watchdog skips unchanged boards** (`content.js` `startWatchdog`, `check`, `gameOverFor`)

Today, every tick does all of the following:
- a stable read (two board reads);
- then `check()`, which reads the board a third time;
- a document-wide `[class*="game-over-modal"]` query plus `getClientRects` (a forced layout);
- on the opponent's turn, an `aggroIdleStatus` message.

Change the tick as follows:
- Take ONE board read and compare its signature (`BS.signature`) with the signature of the last completed `check()`.
- If they are equal, nothing is busy, no `recheckPending` is set and no retry is waiting, end the tick.
- Otherwise schedule the stable read as today.
- Every `CV.WATCHDOG_FORCE_MS` (new constant, 5000), run a full check even when nothing changed. This catches a game-over popup with no board change (resignation, timeout), a status change, or a retry.
- In `gameOverFor`, query the plain class selector first. Use the attribute-substring selector only in that forced check.

The 2.0.3 restore constant is `CV.WATCHDOG_SKIP_UNCHANGED = false`.

Gate: in scenario 1 board reads drop by at least 60% and document-wide queries by at least 75%. Scenario 3 plays the same move with the same recorder output.

**A2. Reuse the stable read** (`scheduleStable`, `check`, `observeBoard`, `buildFen`)

The second read of a stable read is thrown away, and `check()` reads the board again.
- Make one read return `{ grid, count, highlights }` once.
- Compute the signature from that read.
- Pass the second read into `check(reason, read)` → `observeBoard(read)`, so one stable check costs two reads, not three.
- Direct calls such as `schedule()` and the retry timer still read fresh.

Gate: scenario 3 shows one fewer read per check, with identical tracker events.

**A3. Filter board mutations** (`attach`)

Today every mutation under the board starts a stable double read. That includes:
- hover squares;
- drag ghosts;
- arrows;
- coordinates;
- the extension's own synthetic pointer moves during the cursor glide.

Look at the `MutationRecord`s and schedule only when at least one is relevant:
- a `class` change on an element with class `piece` or `highlight`; use `attributeOldValue: true` so an element that LOST one of those classes also counts;
- a `class` change on the board element itself (`flipped`);
- a `childList` change that adds or removes an element that is, or contains, a `.piece` or `.highlight`.

chess.com's markup is not fully known, so the watchdog (A1) stays the safety net. The 2.0.3 restore constant is `CV.MUTATION_FILTER = false`.

Unverified on the real site. Test the filter with recorded or synthetic records.

**A4. Push the idle status instead of polling it** (`idleWork`; background `aggroIdleStatus`)

- Open one `runtime.connect({ name: 'chessvision' })` port per tab.
- The background pushes `{ pondering, evalLine, found }` to the port of the tab that started the idle job, only when a value changes, at most 4 times a second.
- `idleWork()` stops sending `aggroIdleStatus`. Keep the handler in the background for debug use.
- Reconnect the port if it drops (background reload).
- Port disconnects feed B1/B2.

Gate: scenario 2 sends zero status messages.

**A5. lichess** (`manifest.json`)

No code in the extension reads a lichess board: `findBoard` and `readPosition` only know chess.com's markup.
- Before you change anything, **ask the owner** whether `allowed-pages.txt` contains any lichess.org entry. Do not open the file to find out.
- Only if the owner says it does not: remove `*://*.lichess.org/*` from `content_scripts.matches` and from `permissions`, and update the README.
- If there is no answer, skip this task and list it as "not done: waiting for the owner".

### B: Background, memory and start-up

**B1. Start engines lazily and shut them down when idle** (`initStockfish`, `initAggro` and every place that awaits `sfReady` / `aggroGet()`)

Today both main workers start when the browser starts. Each one compiles a ~1.8 MB wasm, allocates its hash and runs a warm-up, in a persistent MV2 background page, even if chess.com is never opened.

Start the engine only when it is needed:
- Replace the load-time `initStockfish(); initAggro();` with `ensureStockfish()` / `ensureAggro()`.
- Call them from `analyze`, `aggroIdle` and a new `{ type: 'warm', engine }` message.
- `content.js` sends `warm` when Auto-play is on on an allowed page, and again when the engine setting changes. That way the first move is not slower than in 2.0.3.

Shut it down when it is idle:
- After `CV.ENGINE_IDLE_MS` (10 min) with no request and no connected port, terminate both main workers and all ponder workers (active, spare and cancelling).
- Drop the compiled-Module promises, so they compile again on the next start.
- No request may ever see a half-torn-down engine. Serialise start and stop, and let a request that arrives during a stop wait for a fresh start.
- Keep `sfDbg`/`aggroDbg` counters across restarts, and add `engineStarts`/`engineStops`.

The 2.0.3 restore constant is `CV.LAZY_ENGINES = false`: start both at load and never stop.

Update `tests/background-sim.test.js` and add a test for:
- start on first request;
- stop after idle;
- a request arriving during the stop;
- an engine switch.

Gate: first-move latency in `background-sim` (fake workers) matches 2.0.3 when `warm` was sent. Memory in Firefox is **unverified**.

**B2. Release ponder spares when nobody needs them** (`ponderTopUp`, `ponderSpares`)

Spares are kept indefinitely while `ponderWanted`.
- Set `ponderWanted = false` and kill the spares when the last port disconnects.
- Do the same at the B1 idle timeout.
- A new idle job makes them again, as today.

### C: Storage

**C1. Fewer settings writes** (`overlay.js` `slider`, `content.js` `onUiChange`, `applyCfg`, `storage.onChanged`)

A slider writes to storage on every `input` event. Each write reaches every chess.com tab, and each tab calls `applyCfg` + `ui.render`, which runs `applyPosition` and forces a layout through `place()`.
- On `input`: update the label and this tab's `cfg` only, through a new `opts.onPreview(patch)` that applies without storing.
- On `change` (release): store once.
- In `storage.onChanged`: skip `applyCfg`/`render` when every changed value already equals `cfg`. This is the echo of this tab's own write.
- In `render`: call `applyPosition` only when `overlayX`, `overlayY` or `overlayOpen` changed.

Gate: one drag across a slider causes exactly one `storage.local.set` (it was one per step), and the panel and engine behave the same.

**C2. Saved games: per-game keys, written by the background** (`storeGame`, `onListGames`, `onClearGames`, `storage.onChanged`, `overlay.js` `refreshGames`)

Today each save rewrites the whole `savedGames` array (up to `maxSavedGames`, max 200), and `storage.onChanged` carries old and new copies to every tab. Every tab then re-reads and re-renders the list, even with "Game saving" closed. Saves are also only serialised per tab, so two tabs can still race.

Change it as follows:
- Move saving into the background through a `{ type: 'saveGame', record, max }` message, serialised there.
- Store each game under `game:<id>`, plus a small index `savedGameIds` (newest first).
- Pruning deletes keys beyond `max`, keeping `mergeSaved`'s rules (dedupe by id).
- `listGames` and `clearGames` become background messages.
- `refreshGames` runs only while the `<details>` is open. Otherwise mark it dirty and refresh it on the `toggle` event.
- The `onChanged` settings filter must ignore `game:*` and `savedGameIds`.

Migration (one-way):
- At background start, if `savedGames` exists, write it out as keys + index, verify it by reading it back, and only then remove `savedGames`.
- Make the migration idempotent, and test it, including when it is interrupted halfway.

Gate: saving one game writes one game key plus the index (it used to write the whole list).

### D: Move latency

**D1. Hidden tab: no per-step cursor waits** (`glideTo`, `dragFromTo`)

Firefox clamps timers in background tabs to about 1 s. A cursor path of 8-38 steps with a `sleep` per step can then take tens of seconds and run into `BUSY_TIMEOUT_MS`.
- While `document.hidden`, dispatch the path's events without the per-step sleeps.
- The human-like pause before the move is unchanged (it is a single timer).

The restore constant is `CV.HIDDEN_NO_STEP_WAIT = false`. Unverified in Firefox; test it with a fake `document.hidden`.

**D2. Cheaper hit-testing and geometry** (`targetAt`, `squareCenter`, `squarePoint`, `movePoints`, `glideTo`)

- `targetAt`: use `document.elementFromPoint` first. Because the panel is in a shadow root, a hit inside it returns `ui.host`. Fall back to `elementsFromPoint` only when the result is `ui.host` or null.
- Read `board.getBoundingClientRect()` once per move in `movePoints` and pass it down. Today it is read for every point.

The clicked target must be the same element as in 2.0.3. Check this in Chromium with the panel placed over the board.

**D3. Clocks and names in one pass, cached** (`readClock`, `readMyClock`, `readOppClock`, `readNames`, `fullPlan`)

`fullPlan` reads my clock and the opponent's clock separately, and each read scans the whole document with `[class*="clock"]` and the increment selectors.
- Collect the candidates once, and return `{ me, opp, inc }` from one pass.
- Cache the matched elements and reuse them while `el.isConnected` and their text still parses. Fall back to a fresh scan otherwise.
- Do the same for `readNames`.
- The values returned must be identical to 2.0.3. Test the selection rules against synthetic DOMs with the same cases.

### E: Pure JS hot spots

**E1. Tracker gap matching** (`boardstate.js` `matchOne`, `matchTwo`)

`matchTwo` tries every two-ply sequence (~35 × 35 applies plus a `legalMoves` per first move).

Rule: in any matching sequence, the from-square of every ply is a square whose content differs between `last.placement` and the observed placement.
- Afterwards that square is empty, or holds a piece of the other colour.
- This holds for castling, en passant and promotion as well.

Compute the set of changed squares once, and skip every candidate ply whose `from` is not in it, at both levels. `matchOne` also applies each move twice (once in `legalMoves`, once in the match). Reuse the work where you can.

Add an equivalence test: random games from varied FENs, drop one or two plies, and compare the 2.0.3 and new matcher results exactly (thousands of cases). Bench `matchTwo` before and after.

**E2. chessmini allocations and early exits** (`chessmini.js`)

- `attacked()` allocates arrays and closures on every call (`['n']`, `[-1, 1]`, the ortho/diag table, the `own` closure). Hoist them to constants.
- Add `hasLegalMove(pos)`, which stops at the first legal move, and use it in `gameState` and `isMate`.
- `legalMoves` must return exactly the same list, in the same order, with the same fields.
- Prove it with `perft`: start position to depth 4 (197281), the "kiwipete" position to depth 3 (97862), and two en-passant/promotion test positions with known counts.
- Bench `legalMoves` before and after.

Then add a replay cache in the background:
- `runIdleJob`/`runIdleSfJob` call `CV.replayUci(startFen, moves)` for the whole game on every ponder job.
- Keep the last `{ startFen, moves, pos }`, and when the new request extends it, apply only the new moves.
- Its result must equal a full replay (test it).

**E3. Cheap tracker counters** (`boardstate.js` `info()`, `content.js` `buildFen`, `histFor`)

Every check calls `tracker.info()`, which copies the move list and scans all entries for the repetition count, just to read `halfmove`/`fullmove`. `histFor` then calls it again.
- Add `counters()` → `{ halfmove, fullmove }`, and a `history()` that returns `{ startFen, moves }`, copying `moves` only when it is actually sent.
- Keep `info()` for the debug info.

### F: Packaging

**F1. A packaging script** (new `tools/package.sh`)

There is no build step. Zipping the repo ships the following, which are not needed at runtime:
- `engine-src/` (two 400 KB nets and the Rust sources);
- `docs/`, `tests/`, `tools/`;
- the markdown files.

Write `tools/package.sh`:
- Zip only the runtime files: `manifest.json`, the scripts it lists, `popup.html`/`popup.js`, `engine/` (including `NOTICE.txt`), `LICENSE` and `allowed-pages.txt`. Include the last one by path; never read it.
- `--lean`: also leave out `engine/stockfish-19-asm.js` (the asm.js fallback; Firefox always has WebAssembly) and the threaded build `engine/stockfish-19-lite.{js,wasm}`. Per the 2.0.2 notes, Firefox extension pages have no SharedArrayBuffer, so it never runs.
  - Check that `background.js` already survives a missing threaded file (it should: `sfApplyThreads` catches the failure and keeps the single-thread engine). Fix it if it does not.
  - The files stay in the repository, so the fallback rules of 2.0.2 still hold for the default package.
- After zipping, verify the result: unzip it to a temp directory and check that every path the manifest lists, and every engine constant in `background.js` (`SF_*`, `AGGRO_*`, the worker files), exists. In lean mode, skip the files lean mode leaves out.
- Print the zip size for both modes.
- Document it in the README and the REFERENCE Development section.

### G: Release 2.0.4

- Set `manifest.json` version and `FALLBACK_VERSION` in `content.js` to `2.0.4`.
- Write the REFERENCE changelog: one entry per task, with the §3 measurements, the restore constants, what is unverified, and what was not done and why.
- Update the README sections whose behaviour changed (watchdog, saved games, engine start-up, packaging) and `chessvision-project-summary.md`.
- Add the new constants and settings to the REFERENCE tables.

## 5. Order if time runs short

A1, A2, B1, C1, A3, C2, A4 + B2, D1, D3, E1, D2, E3, E2, F1, then G (always last). A5 only with the owner's answer.

## 6. Final report

Give one line per task: done / reverted (with the numbers) / not done (with the reason). After that, give the before/after table from §3 and the list of unverified points.
