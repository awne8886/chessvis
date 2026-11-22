# ChessVision

A Firefox extension that plays chess for you against the computer bots on chess.com, using an engine that runs locally in the browser: **AggroChess** (Tal-style, WebAssembly) or **Stockfish** (WebAssembly). Nothing is sent to a server; the engines run inside the extension.

It adds a small control panel to the page where you change the engine, depth and delays, switch human-like behaviour on and off, and tune a watchdog that keeps the add-on from getting stuck. You do not need the Firefox extension menu for any of it.

> **Scope.** ChessVision only acts on pages listed in [`allowed-pages.txt`](#allowed-pages). The shipped list contains chess.com's computer-bot pages (`chess.com/play/computer`, `chess.com/game/computer`); everywhere else it stays paused. Please keep it to bot games: do not use it in games against other people, in rated play, or anywhere engine assistance is not allowed.

- Version: 1.8.0
- Platform: Firefox, Manifest V2
- Site: the extension loads on `*://*.chess.com/*` and acts only on the pages in `allowed-pages.txt`
- Permissions: `storage`, `clipboardWrite` (for the Export and Copy debug info buttons), and access to chess.com. No data collection.

---

## Install

### Temporary (development)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and select `manifest.json` from this folder.
3. Open a bot game at `https://www.chess.com/play/computer`.

Temporary add-ons are removed when Firefox restarts. A permanent install of an unsigned build only works in Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to `false`; release Firefox needs a signed add-on.

---

## Using it

1. Start a game against a bot on chess.com.
2. The **ChessVision** panel appears in the bottom-right corner of the page.
3. Switch **Auto-play** on. The extension reads the board, asks the engine for a move when it is your turn, and plays it.

### The panel

| Action | How |
| --- | --- |
| Collapse / expand | Tap the header, or the arrow on the right. |
| Move it | Drag the header. The position is remembered. |
| Open a section | Tap **Human-like play**, **Quick replies** or **Watchdog**. |
| Turn a whole section off | Use the switch on the section's header. Its controls grey out. |
| AggroChess options | Visible only when the engine is AggroChess (see [AggroChess options](#aggrochess-options-aggro)). |
| Game saving | Open **Game saving** (see [Game recording and saving](#game-recording-and-saving)). |
| Backup, debug, reset | Open **Tools & backup**: Export / Import settings, Copy debug info, Clear engine memory, Reset settings (see [Tools & backup](#tools--backup)). |

The status line in the header shows what it is doing (`WFO` = waiting for opponent, with ` · pondering…` added while it ponders, `thinking (Stockfish)...`, `playing e2e4 · quick recapture`, `paused - this page is not in allowed-pages.txt`, and so on). The dot is grey when off, teal when active, amber for a warning, red for an error.

All settings are saved in `storage.local` and apply immediately, including to other open chess.com tabs. The toolbar popup now only has the Auto-play switch.

---

## Settings reference

Every control in the panel is listed here with its storage key, range and default.

### Core

| Control | Key | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Auto-play | `enabled` | on/off | off | Master switch. |
| Engine | `engine` | `aggro`, `stockfish` | `aggro` | AggroChess plays aggressive, sacrificial chess. Stockfish plays the strongest move it finds. |
| Think time | `thinkMs` | 200-5000 ms | 1000 | AggroChess search time per move. Shown for AggroChess only. |
| Search depth | `depth` | 1-20 | 10 | Stockfish search depth. Shown for Stockfish only. The WebAssembly engine makes depths above 14 practical; the asm.js fallback is much slower. |
| Stockfish max think time | `sfMaxMs` | 0-10000 ms, step 100 | 0 (off) | Optional time cap for Stockfish. When above 0 the search is started as `go depth N movetime M` and stops at whichever limit is reached first, so it can return before the depth is reached. 0 = depth only. Shown for Stockfish only. Applies to the full search, not to quick looks (those stay at depth 8 or less). |
| Min delay | `minDelay` | 100-3000 ms | 300 | Lower bound of the pause before a normal move. |
| Max delay | `maxDelay` | 100-3000 ms | 800 | Upper bound of that pause. Kept >= min delay automatically. |

The engine searches **while** the delay runs, so the real wait before a move is whichever is longer: the delay or the engine's time.

### AggroChess options (`aggro`)

Shown in the panel only when the engine is AggroChess. All of it is off by default except the clock.

| Control | Key | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Use the game clock | `aggroUseClock` | on/off | on | Reads **your** clock from the page and sizes the full search with AggroChess's `think_clock(soft, hard)` (milliseconds). `soft = min(Think time, remaining/40 + 0.8 x increment)`, `hard = min(remaining/8, 3 x Think time)`, floors of 100 ms; under 10 s left a much shorter budget is used (`soft = remaining/60`, `hard = remaining/15`, never above remaining/4) and the hand moves faster. The human-like pause is capped at 8% of the remaining time. If no clock can be read (or the option is off) the fixed Think time is used. Quick replies keep their small budget. The constants are named at the top of `clock.js`. |
| Ponder on opponent's time | `aggroPonder` | on/off | off | While the opponent thinks, one to three extra AggroChess workers (**Ponder workers**, never the main one) share one queue of opponent moves and prepare replies for **many** possible opponent moves, not just one. First a very short search after every legal opponent move ranks them by how good they are for the opponent; then the most likely ones get a reply search each (120-600 ms), best first. Every reply found is kept. When the opponent moves, the reply found for exactly that move is played at once (usual human delay applies; status shows `ponder hit`), even if pondering is not finished. If that move's reply was not finished (or the move was not prepared) the ponder worker is terminated and a normal search runs; a real search never waits for it. The ponder time is a **ceiling**: the whole job (including the evaluation line) stops by then. Ponder workers are killed all at once when the opponent has moved and no prepared reply is used (a real search never waits for them), and warmed-up replacements are made while the main worker is idle, so the next job starts at once (only while pondering or the evaluation line is on). Entries are dropped on a new game, takeback, switching pondering off, switching engine and when the tab is hidden. Debug info counts attempts, hits, misses (move not prepared or other position), late (move planned, reply not finished yet) and skipped. The status shows `WFO · pondering N` / `WFO · pondered N` (N = replies found). |
| Ponder time | `aggroPonderMs` | 200-5000 ms, step 100 | 1500 | Total time budget of the pondering job; it never runs past it. |
| Ponder workers | `aggroPonderWorkers` | 1-3 | 1 | How many ponder workers share the work. They pull opponent moves from one shared queue (a dynamic queue, not a fixed split), for the ranking pass and for the reply searches, so more of the opponent's moves get a reply inside the same ponder time. **Each worker costs about 50 MiB of memory** (about 28 MiB with an 8 MB hash, see below) and a CPU core while it works. The number actually used is capped at `max(1, navigator.hardwareConcurrency - 1)`, so the main worker and the page keep a core; if the browser does not report a CPU count, 1 is used. 1 behaves like 1.7.8. |
| Ponder hash | `aggroPonderHashMb` | 4-64 MB, step 4 | 32 | Hash table of each **ponder** worker (the main worker keeps the engine's own 32 MB). 32 = unchanged. A smaller table lowers the memory per worker (a worker's memory is about 18 MiB plus the hash) so more workers fit on a phone; shallower replies are possible with a small table. Needs the engine build shipped in 1.7.9 (older builds ignore it). |
| Show evaluation | `aggroShowEval` | on/off | off | One line while the opponent thinks, e.g. `Eval +0.42 (you) d11 · opp best Nf3 (book)`. AggroChess reports White's point of view; it is converted so **+ is good for you**. `(book)` means the predicted opponent move is in AggroChess's opening book (shown only when a prediction exists). Display only; dropped if the opponent moves first. Runs on the ponder worker (300 ms) before the ponder search. |
| Verify position with engine | `aggroVerify` | on/off | off | Before each AggroChess search the position is sent to the engine without searching; the panel and debug info warn if the engine rejects it, the side to move differs or its legal moves differ from the page's. Warns only, never blocks play. |

### Stockfish options (`stockfish`)

Shown in the panel only when the engine is Stockfish. All of it is off (or 1) by default, so Stockfish plays exactly as in 1.7.9 until you change something.

| Control | Key | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Use the game clock | `sfUseClock` | on/off | off | Reads **your** clock from the page and caps the full search with a time budget (`soft`, the same rule as for AggroChess in `clock.js`: never more than a quarter of the remaining time, a short budget under 10 s). With **Stockfish max think time** also set, the smaller of the two is used. Depth still applies: the search ends at the depth or at the cap, whichever comes first. No clock readable = unchanged. Quick looks are not capped. |
| Ponder on opponent's time | `sfPonder` | on/off | off | While the opponent thinks, 1-3 extra Stockfish workers (**never the main one**) rank the opponent's moves and prepare replies, see *Stockfish pondering* below. Off while **Imperfection** is above 0 (a prepared reply is always the best line). |
| Ponder time | `sfPonderMs` | 200-5000 ms, step 100 | 1500 | Ceiling of the whole pondering job. |
| Ponder workers | `sfPonderWorkers` | 1-3 | 1 | Workers sharing the job; capped at `max(1, navigator.hardwareConcurrency - 1)` (unknown CPU count = 1). Measured in Node: **about 58 MiB per worker with a 16 MB hash** (42 MiB + the hash table; 74 MiB at 32 MB). |
| Ponder hash | `sfPonderHashMb` | 4-64 MB, step 4 | 16 | Hash table of each ponder worker (the main worker keeps 32). |
| Search threads | `sfThreads` | 1-4 | 1 | Threads of the **main** worker. Above 1 only if the threaded build (`engine/stockfish-19-lite.js`) can run: a runtime test (`SharedArrayBuffer`, `Atomics`, shared `WebAssembly.Memory`) must pass, the number is capped at `max(1, cores - 1)`, and any failure keeps the single-thread engine. **Not verified in Firefox** (see Not tested). |

**Stockfish pondering.** After your move the background page starts a job on a pool of 1-3 extra Stockfish workers. First **one MultiPV search** (8 lines, 120 ms) of the position the opponent faces ranks their moves by how good they are for the opponent; then the most likely moves each get a reply search (`go depth <your depth> movetime <slice>`, slice 120-600 ms), best first, every worker pulling the next move from one shared queue. Every finished reply is kept; when the opponent plays a prepared move the reply is used at once (`ponder hit`). Differences from AggroChess pondering, all because Stockfish can be stopped and keeps its hash: a worker is cancelled with `stop` + `isready` (about 20 ms) and goes back to the warm spares; it is only terminated if it does not answer within 1.5 s; a reply search that is still running when the opponent plays exactly that move is stopped and used if it already reached depth 8 (`partial`); with exactly one legal opponent move there is no ranking and that move gets the whole ponder time. Workers are started through `engine/sf-worker.js` with one shared compiled `.wasm`, warmed up (`ucinewgame`, `isready`, `go movetime 10` on a non-book position, `ucinewgame`) and kept as spares only while pondering is on and no real search is running. A new game sends `ucinewgame` to them. Entries are dropped on a new game, takeback, pondering off, engine switch and when the tab is hidden. Hit / miss / late counts are in Copy debug info (`background.ponder`, `background.stockfish`). The ranking method is the constant `SF_RANK_MODE` (`'multipv'` or `'scan'`, a short search after every legal move as for AggroChess) at the top of the Stockfish ponder section of `background.js`; the benchmark below is why it is `'multipv'`. True UCI pondering (`go ponder` / `ponderhit`) was measured and **not** used (below).

### Game recording and saving

ChessVision records **every move that lands on the board**: the bot's, the opponent's, and your own moves (also while Auto-play is paused, because the board is still read on allowed pages). The recorder does not trust a live move-by-move guess. It keeps the list of distinct board positions that were seen and builds the move list from them when the game is saved (at its end, or with **Save current game now**).

- **Missed moves are reconstructed at the end.** If two consecutive positions differ by more than one move (the board was not read in between), the recorder searches the legal move sequences (up to 6 plies) that lead from the earlier position to the later one. It uses what it knows about both positions: which side was to move (the number of plies must fit), the square of the last move, the moves the bot announced, and the real castling / en passant rules from the start of the game. With several explanations it prefers the one that ends on the highlighted square and contains the bot's own moves; when the board alone cannot tell (two move orders reach the same position) the order may differ from what was played, but the positions never do.
- **A position that cannot be explained** (a read in the middle of an animation, for example) is skipped if one of the next two positions can be explained from the last certain one. If nothing works, the PGN stops at the last certain move and says so in the `ChessVisionIncomplete` header.
- **A takeback** (the board returns to an earlier position) removes the positions after it and their sacrifice marks.
- **The PGN is plain:** the seven standard tags in order, move numbers, SAN and the result, wrapped at 80 columns, with no comments. SAN has the check `+` and mate `#` markers, promotions (`e8=Q+`, `exd8=N`), castling `O-O` / `O-O-O` (with `+` / `#` when they give check), en passant as a normal pawn capture, and the shortest correct disambiguation (`Nbd2`, `R1a3`, `Qh4e1`). Reconstructed moves are counted in the `ChessVisionReconstructedPlies` header, not marked in the move text.

| Control | Key | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Save games with sacrifices | `saveWithSacrifices` | on/off | off | Master switch of the threshold rule. |
| Save game when sacrifices reach | `saveSacrificeThreshold` | 1-20 | 3 | A finished game is stored when its counted sacrifices are at least this. |
| Save every game | `saveEveryGame` | on/off | off | Store every finished game. |
| Pawn / Knight / Bishop / Rook / Queen | `sacrificeTypePawn` ... `sacrificeTypeQueen` | on/off | all on | Which sacrificed piece types are counted. A disabled type is not counted and not in the saved total; its move stays in the PGN. |
| Keep at most | `maxSavedGames` | 5-200 | 50 | Oldest games are dropped first (also when the stored list exceeds about 4 MB). |
| Count chess.com brilliant moves | `countBrilliants` | on/off | off | Best effort, see below. |
| Brilliant check wait | `brilliantWaitSec` | 1-15 s | 4 | Wait after the game ends before looking for the popup. |

- **Sacrifices** come from AggroChess's own flag (the `sacrifice` field it returns with each move). A flagged move is counted only when the board confirms it as the bot's ply: when the extension executes a move it remembers (position, move, flag); when the finished move list contains that exact move from that exact position by your colour, the flag is attached (also when the move was part of a reconstructed gap). A move that never landed, a manual move and the opponent's moves are never counted. The flag carries no piece type, so the **sacrificed piece type is the type of the piece that moved** (a king move has no toggle and is not counted).
- **Only AggroChess has the flag.** A game with no AggroChess ply has sacrifice count **unknown**: stored as `null` and shown `n/a`, never 0. The threshold rule cannot trigger on it; only **Save every game** or **Save current game now** saves such a game. A move played because it was the only legal move does not count as an AggroChess ply.
- **When a game is saved:** once, when the game ends (checkmate or stalemate from the position, or chess.com's result dialog), if the rules above say so. A new game that starts without the old one having been seen to end saves the old one with result `*` if the rules say so. **A game still in progress when the tab is closed or reloaded is not saved** (no recovery).
- **Stored** in `storage.local` under `savedGames`, newest first: id, date, result, sacrifice count (or null), brilliant counts (mine / opponent, or null), opponent name, engine, PGN. A game is saved at most once (stable id; "Save current game now" followed by the automatic save replaces the entry). **Reset settings does not delete saved games, and saved games are not part of the settings export.**
- **PGN headers:** Event `chess.com computer game`, Site `chess.com`, Date, Round (`-`), White, Black (names read from the page if possible, otherwise `You` / `Bot`), Result (checkmate `1-0`/`0-1`, stalemate `1/2-1/2`, anything else `*` because the result dialog is not read), `ChessVisionSacrifices`, `ChessVisionBrilliants` (each omitted when unknown), `Engine` (engine of the most recent bot ply), `ChessVisionReconstructedPlies` (only when moves were reconstructed), `ChessVisionIncomplete` (only when the PGN had to stop early), and `SetUp`/`FEN` when the recording did not start from the standard position (including recording that began mid-game).
- **Panel (Game saving):** saved games list (date, result, sacrifices, brilliants; opponent brilliants as tooltip) with **Download .pgn** and **Copy PGN** per game, **Download all as one .pgn**, **Clear saved games** (asks to click again), **Save current game now**. Downloads use a Blob and a download link created in the page, so no permission is needed; if the browser does not start the download, use **Copy PGN**.
- **Brilliant moves (best effort, untested on the real site):** after the game ends and the wait, the page is searched for chess.com's post-game popup. Layer a reads text / alt / title / aria-label containing "Brilliant" with an adjacent number per side; layer b counts classification icons whose URL, file name or class contains "brilliant" per side. Every selector, word and hint is a *candidate* in one block at the top of `brilliant.js`; what each layer found is written to the debug log (console). If the popup is not found or nothing can be read the value is `null` / `n/a`, never 0. The lookup runs in the background of the normal flow and the game is saved when it finishes. Layer c: icons that layers a/b cannot name by file or class are downloaded by the background page, drawn on a canvas, and their dominant colour is compared with brilliant teal (about `#1baca6`, tolerance 70; a candidate, edit it in `brilliant.js`). It runs only for a side still unknown after a and b, with at most 30 images. This needs a **new host permission**, `*://*.chesscomfiles.com/*`, because chess.com's icons are normally served from that image domain (my assumption, not verified); the background only downloads https images from `chess.com` / `chesscomfiles.com`, up to 300 KB, without cookies. If the icons live on another domain, change the permission in `manifest.json` and the host check in `fetchImage` in `background.js`.

### Human-like play (`humanize`, default on)

The section switch turns the whole block on or off. With it off, delays are uniform between min and max, clicks land on the exact centre of the squares, the cursor does not move, and moves are made with two clicks (the behaviour of version 1.2.0).

| Control | Key | Default | What it does |
| --- | --- | --- | --- |
| Delay: Natural / Uniform | `delayStyle` | `natural` | **Uniform** picks evenly between min and max. **Natural** uses a right-skewed distribution: most moves take a typical time, some take longer, and positions with more legal moves take longer on average. It stays inside min-max, except for pauses (below). |
| Rare long pauses | `hesitation` | on | In Natural mode, about 4% of moves wait 1.4-2.2x the max delay, as if the player stopped to think. These can exceed Max delay by design. |
| Curved cursor path | `mouseMove` | on | Sends `pointermove`/`mousemove` events along a curved, eased path with small jitter, and occasionally a small overshoot. Total travel time is about 160-520 ms depending on distance. |
| Off-centre clicks | `clickOffset` | on | Clicks a random point inside the square (centre-weighted, up to about +/-32% of the square) instead of its exact centre. |
| Input: Click / Drag / Mixed | `inputMode` | `click` | **Click** selects the piece, then the target square. **Drag** presses on the piece, moves, and releases on the target. **Mixed** drags about 35% of the time. If a drag does not register, ChessVision switches to clicks automatically (see [Input fallback](#input-fallback)). |
| Imperfection | `imperfection` | 0% | Per move, the chance of playing a near-best alternative instead of the best move. **Stockfish only.** See below. |

**Imperfection.** When above 0, Stockfish searches 3 lines (MultiPV 3). With the given probability it picks one of the other lines whose evaluation is within 60 centipawns of the best. It never deviates when the best line is a forced mate, and never replaces a best move that qualifies as a quick reply. It is not applied to quick looks. Because it searches three lines, it is a little slower. AggroChess does not support it.

### Quick replies (`quickReplies`, default on)

People play obvious moves fast. When the position makes a move obvious, ChessVision answers quickly instead of waiting out the normal delay.

| Control | Key | Default | A move qualifies when... |
| --- | --- | --- | --- |
| Only legal move | `quickOnlyMove` | on | You have exactly one legal move. The engine is skipped entirely. |
| Recapture | `quickRecapture` | on | The opponent's last move was a capture, and the chosen move captures on the square they captured on. |
| Promotion and pawn runs | `quickPromotion` | on | The move is a promotion (including capture-promotions), **or** it pushes a passed pawn to within two squares of promotion in an endgame with a clear road ahead. |
| Mate in one | `quickMate` | on | The chosen move checkmates. |
| Quick min / max delay | `quickMinDelay`, `quickMaxDelay` | 80 / 300 ms | Pause before a quick reply (range 40-1000 / 40-1500 ms). |
| Quick think time | `quickThinkMs` | 300 ms | AggroChess budget for a move that looks obvious (100-2000 ms). Stockfish uses depth 8 or the configured depth, whichever is lower. |

Definitions used above:

- **Endgame:** at most 6 pieces on the board in total that are neither pawns nor kings (both sides together). Set by `ENDGAME_MAX_PIECES` in `humanize.js`.
- **Passed pawn run:** a pawn with no enemy pawn ahead of it on its own file or the two neighbouring files, moving to the 6th or 7th rank (White) or 3rd or 2nd rank (Black), with every square in front of it empty.

How it works:

1. A built-in rules engine (`chessmini.js`) lists your legal moves. If one is forced, it is played at once.
2. If any legal move *could* qualify, the engine is asked with the reduced quick budget.
3. If its move qualifies, ChessVision waits only the quick delay and uses a faster hand (cursor about 2.2x faster, shorter pauses).
4. If it does not qualify, the reduced-budget answer is thrown away, the engine is asked again with the full budget, and the normal delay applies. Only moves that pass the check are ever played on the reduced budget.


### Watchdog (`watchdogMs`, default 1000 ms, range 200-5000)

Every `watchdogMs` milliseconds the extension re-reads the board and decides whether it is your turn, regardless of whether chess.com's page told it anything changed. This fixes the case where the panel sat on *WFO* (waiting for opponent) after the opponent had already moved and only woke up when you touched a piece.

- Lower values recover faster and use a little more CPU. Higher values are lighter but can leave you waiting up to that long after a missed update.
- The check is idempotent: when nothing changed it does nothing.
- The 1-second board re-attach timer (it follows chess.com replacing the board element) is separate and fixed.

Other recovery measures in the same area:

- A change that arrives while a move is being made is remembered and re-checked as soon as the move finishes (it used to be dropped).
- A move attempt stuck for more than 45 s (for example a hung engine) is abandoned, and a late answer from it is ignored.
- If a move does not register, it is retried up to 3 times, then the panel says `move not registering`.
- If the engine returns nothing, it retries up to 3 times.

### Input fallback

Drag moves are sent as synthetic mouse events and a site may ignore them. When a drag move is still not on the board after about 1.8 s, ChessVision retries that move with two clicks and keeps using clicks until you change **Input** or **Human-like play** (or reload the tab). The status line then ends with `click fallback`. Retries stay limited to 3 attempts per position.

### Game over and new games

- **Checkmate and stalemate** are detected from the position itself, on either side. The status shows `game over: checkmate - you won` / `- you lost` or `game over: stalemate`, and nothing is played.
- **Other endings** (resignation, time, agreed draw) cannot be seen from the board. ChessVision also looks for chess.com's result dialog (`.game-over-modal-container` or any class containing `game-over-modal`) and stops while it is visible. This selector is a best guess and has not been checked on the live site.
- **New game:** when the untouched start position appears (no last-move highlight; this also covers the position returning to the start), or the piece count rises and no earlier position of the game matches, per-game memory (castling rights, history, retry counters, recapture tracking) is cleared and AggroChess's hash is cleared.
- **Takeback / undo:** if the board returns to an earlier position of the game, the history and the recording are cut back to it. This is not a new game and does not clear AggroChess's hash.
- ChessVision never starts, accepts or rematches a game for you.

### Tools & backup

The **Tools & backup** section of the panel has five buttons:

| Button | What it does |
| --- | --- |
| Export settings | Copies your settings to the clipboard as JSON (`{"type": "chessvision-settings", "version": 1, "settings": {...}}`). If the browser blocks the clipboard, the text is shown in the box below the buttons so you can copy it by hand. |
| Import settings | Opens a box; paste an export and press **Apply**. Unknown keys are ignored and numbers are clamped to their valid range. |
| Clear engine memory | Clears AggroChess's hash and sends `ucinewgame` to Stockfish. |
| Copy debug info | Copies a JSON report: version, browser, page path, whether the page is allowed, all settings, internal state (busy, attempts, input fallback), history (length, halfmove clock, repetition count, history resets), the last clock reading, AggroChess ponder / verify counters and board state (size, flipped, piece and highlight counts, FEN, side to move, game state). It contains no page text, cookies or account data. Paste it into an issue when something misbehaves. |
| Reset settings | Restores every setting to its default, including turning Auto-play off. The panel's position and open/closed state are kept. |

Export and import skip **Auto-play** (so importing can never start play) and the panel position and open/closed state, which are per device. Saved games are not part of the export.

---

## How it works

```
chess.com page                         extension
-------------------------------        -------------------------------------
wc-chess-board DOM  --read-->  content.js  --sendMessage-->  background.js
 (.piece, .highlight)           |  builds FEN                   |  Stockfish worker (wasm)
                                |  decides turn                 |  AggroChess worker (wasm)
                                |  quick-reply logic            |
 clicks / drags  <--events--    |  executes the move  <--uci--  |
                             overlay.js (panel UI)
```

### Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V2. Loads the content scripts below (settings, chessmini, humanize, boardstate, clock, pgn, brilliant, recorder, overlay, content), in order, on chess.com. The background page loads `settings.js`, `chessmini.js` and `background.js`. |
| `settings.js` | Defaults, limits and validation for every setting, plus the parser and matcher for `allowed-pages.txt`. Shared by the page scripts and the popup. |
| `allowed-pages.txt` | Plain-text list of pages where auto-play is allowed. |
| `chessmini.js` | Small rules engine: FEN parsing, legal moves, make-move, check, mate and stalemate. Used to recognise obvious moves and finished games; it never chooses moves, but the recorder uses it to reconstruct missed moves. |
| `humanize.js` | Quick-reply classification, delay distribution, cursor paths, input-method choice. No DOM access. |
| `boardstate.js` | Pure board logic: grid to FEN, last-move highlights, castling rights, and the history tracker (move reconstruction, takeback, new game, halfmove / fullmove, repetition count) with its events. |
| `clock.js` | Pure: clock text parsing and the AggroChess clock budget (`soft` / `hard`). |
| `pgn.js` | Pure: SAN (disambiguation, check / mate, promotion), plain PGN assembly, sacrifice counting, auto-save rule, saved-game list merging. |
| `recorder.js` | Keeps every board position that was seen, rebuilds the move list from them when a game is built (missed moves are reconstructed by a legal-move search, using all later positions as context) and builds the saved record. |
| `brilliant.js` | Best-effort brilliant-move count from chess.com's post-game popup; all selector candidates in one block at the top. |
| `overlay.js` | The on-page panel, in a Shadow DOM so chess.com's CSS cannot affect it. Includes the Tools & backup section. |
| `content.js` | Reads the board (DOM only), calls the pure modules, decides when to move, runs the watchdog, detects game over, reads clock and names, performs the move with pointer events (the panel is ignored when picking the target of a synthetic event), saves games, builds the debug report. |
| `background.js` | Hosts the two engines and answers `analyze` requests. Implements Stockfish MultiPV and imperfection, runs AggroChess in a main worker plus a pool of 1-3 killable ponder workers (start timeout, think timeout, error cooldown; failures reach the panel as `AggroChess: ...`). It compiles the AggroChess `.wasm` once (the SIMD build when the browser validates SIMD, else the plain one) and posts the compiled module to every worker. Also serves the text of `allowed-pages.txt` to the page scripts. |
| `engine/sf-worker.js` | Small wrapper worker for the **unmodified** Stockfish loader: it receives the compiled `.wasm` Module from `background.js` and lets the loader's own `instantiateStreaming` step use it instead of fetching and compiling again (verified in Node with the real loader in a browser-like vm; the direct path stays as the fallback). GPL-3.0, written for ChessVision. |
| `engine/stockfish-19-lite.js` + `.wasm` | The **threaded** lite build from the same npm package, byte-identical, used only for `sfThreads` > 1 when the SharedArrayBuffer test passes. |
| `popup.html`, `popup.js` | Toolbar popup with the Auto-play switch. |
| `LICENSE` | GNU GPL v3. |
| `.github/workflows/tests.yml` | GitHub Action that syntax-checks the scripts and runs the unit tests on every push and pull request. |
| `engine/` | Engine binaries and workers. `stockfish-19-lite-single.js` + `stockfish-19-lite-single.wasm` (Stockfish.js 19, WebAssembly, lite net, single thread; the file name is the constant `SF_FILE` at the top of the Stockfish section of `background.js`), `stockfish-19-asm.js` (asm.js fallback, used only if the wasm engine fails to start), `aggrochess.wasm` and `aggrochess-simd.wasm` (AggroChess 4.6.1; the same engine built without and with simd128), `aggro-worker.js` (all GPL-3.0), `aggrochess-4.6.1-chessvision.patch` (the changes to the AggroChess 4.6.1 web source behind the two binaries, see Development). Sources and licences: `engine/NOTICE.txt` (not updated for 1.7.9: it still describes the older AggroChess build). |
| `chessvision-project-summary.md` | Project context for the next person or model; kept in the zip and updated with every change. |
| `tests/` | Node unit tests, and `bench-aggro.js`, `bench-stockfish.js` + `bench-stockfish-sims.js` (benchmarks, not part of the test run). |

### Reading the position

The extension has no access to chess.com's game state, so it builds a FEN from the page:

- **Pieces:** every `.piece` element's classes (`wp`, `bk`, ... and `square-FR`).
- **Side to move:** the colour of the piece on the highlighted last-move square, then the opposite colour. If nothing is highlighted, White.
- **En passant:** inferred from a highlighted two-square pawn push.
- **Castling rights:** inferred from whether kings and rooks are still on their home squares; reset when a new game is detected.
- **Move counters:** the halfmove clock (reset by a pawn move or capture) and the fullmove number come from the history tracker (below). A game recorded from mid-game starts counting at 0 / 1.
- **History:** every board read on an allowed page (also with Auto-play off) is shown to the tracker in `boardstate.js`, which reconstructs the move between two observed positions by trying each legal move; if a move was missed it tries every two-move sequence; if that is still ambiguous it reports a gap and restarts the history from the current position (counted as `historyResets`). Stockfish gets `position fen <startFen> moves ...` and AggroChess gets the same start and moves, so both see repetitions and the 50-move rule; if the history does not end at the current position the bare FEN is sent as before. A probe of `aggrochess.wasm` showed that its rules honour threefold repetition and the 50-move rule from the move list (status 5 and 3); whether its search steers around draws was not shown by the probe.
- **Your colour:** Black if the board element has the `flipped` class, otherwise White.

### Allowed pages

Auto-play only runs on pages matched by `allowed-pages.txt`, a plain-text file in the extension folder:

```
# comment
chess.com/play/computer
chess.com/game/computer
*.example.com/bots
```

- One entry per line. Blank lines and lines starting with `#` are ignored; `#` after a space ends the line's entry.
- Entries are compared with the page address **without** `https://`, `www.`, query string and fragment, case-insensitively. A pasted full URL such as `https://www.chess.com/play/computer/` works; it is normalised.
- An entry matches that page **and everything below it**: `chess.com/play/computer` matches `chess.com/play/computer/Nelson` but not `chess.com/play/computerx`, and not `chess.com.evil.com/play/computer`.
- `*` matches any text. `*.chess.com/play/computer` matches subdomains but not the bare `chess.com`; list both if you want both.
- The match is re-evaluated on every board check, because chess.com navigates without reloading the page.
- A missing, empty or unreadable file means nothing is allowed.
- After editing: reload the add-on at `about:debugging`, then refresh the tab. The file is read once per browser session by the background script.

The status line shows `paused - this page is not in allowed-pages.txt` on any page that does not match.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Panel is not visible | Reload the chess.com tab after loading the add-on. Make sure the add-on is listed at `about:debugging`. |
| `paused - this page is not in allowed-pages.txt` | The page is not matched by any entry. Open a bot game, or check the entries and reload the add-on after editing the file. |
| `loading page list...` stays on screen | The background script could not read `allowed-pages.txt`; reload the add-on and check the console. |
| `no board found` | The board element was not found; chess.com may have changed its markup. |
| Stays on `WFO` | Lower the watchdog interval. If it still happens, open the console (F12) and look for `[ChessVision]` lines; check that the last-move highlight is on the board. |
| `move not registering` | The clicks were ignored. Try Input: Click, switch off Curved cursor path, or reload the tab. Then use **Copy debug info** and check `board.fen`, `board.turn` and `state`. |
| Status ends with `click fallback` | A drag did not register, so clicks are being used. Change Input to reset it. |
| `game over` but the game is still running | The result-dialog check matched something else on the page. Report it with **Copy debug info**; the selector is in `gameOverFor()` in `content.js`. |
| Moves look wrong for castling or en passant | Rights are inferred from the page; a position loaded mid-game can differ from the real one. |
| Slow replies with Stockfish | Lower the depth, or set **Stockfish max think time** to cap the time per move. Stockfish normally runs as WebAssembly (`engine/stockfish-19-lite-single.js` + `.wasm`); if it failed to start, the much slower asm.js engine is used instead. The background console (`about:debugging` > Inspect) shows `[ChessVision] Stockfish active: ...` and, after a failed start, `falling back to engine/stockfish-19-asm.js`. |
| Console is noisy | Set `DEBUG = false` at the top of `content.js`. |

---

## Development

```
node tests/perft.test.js       # move generator against published perft counts, plus a mate check
node tests/humanize.test.js    # quick-reply classification, delays, paths, settings validation
node tests/allowlist.test.js   # allowed-pages.txt parsing and matching
node tests/settings.test.js    # settings export/import, checkmate and stalemate detection
node tests/stockfish.test.js   # Stockfish helpers, sfMaxMs settings, position command with history, background.js start-up/fallback/ucinewgame and AggroChess failure handling, the ponder worker pool, the module hand-off with its fallbacks, the SIMD choice, and `engine/aggro-worker.js` (warm-up, fallbacks) with fake workers (no engine needed)
node tests/boardstate.test.js  # grid to FEN, highlights, castling rights, history tracker
node tests/clock.test.js       # clock parsing and budget
node tests/ponder.test.js      # ponder keys / hit-miss-late / invalidation, running-move set, worker-count cap, new settings keys
node tests/stockfish-pool.test.js  # 1.8.0: Stockfish ponder pool, module hand-off with its fallbacks, stop-based cancel and its timeout, hit / miss / late / harvest, the SAB feature test, the threaded-build gate, setoption only on change (fake workers, no engine)
node tests/recorder.test.js    # recorder + pgn.js: positions seen -> moves, gap reconstruction, SAN (checks, promotions, castling, en passant), PGN text, sacrifice rules, takeback, new game
```

No build step. Edit the files and reload the add-on from `about:debugging`.

```
node tests/bench-stockfish.js [--quick] [--reps N] [--only startup|depth|conc|verify|rank|strength|hash|reuse|threads] [--json]
node tests/bench-aggro.js [--wasm file] [--quick] [--reps N] [--only startup|depth|conc|verify|polls] [--json]
```

The benchmark (plain Node, `worker_threads`, a few minutes) reports instantiate time, the lazy-init cost of a cold first search, depth at 150 / 500 / 1500 ms on 5 fixed positions (cold first search vs warmed-up), depth with 1 / 2 / 3 concurrent instances, a check that a warmed-up instance answers exactly like a cold one, and how often the engine polls the clock. `--wasm engine/aggrochess-simd.wasm` measures the SIMD build.

**Rebuilding the engine binaries** (not needed to use the extension). Source: AggroChess 4.6.1 web package (`source/`), plus `engine/aggrochess-4.6.1-chessvision.patch` (`patch -p0` style: apply the two hunks to `src/lib.rs` and `src/search.rs`). Then, with `opt-level = 3`, `lto = true` (fat), `codegen-units = 1`, `panic = "abort"` as in its `Cargo.toml`:

```
cargo build --release --target wasm32-unknown-unknown                                   # engine/aggrochess.wasm
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown   # engine/aggrochess-simd.wasm
```

Both were built with rustc 1.100 (conda-forge); the plain build reproduced the shipped 4.6.1 binary's size to within 136 bytes before the patch.

**Continuous integration:** `.github/workflows/tests.yml` runs `node --check` on every script, validates `manifest.json` and runs all `tests/*.test.js` on every push and pull request (Node 20). The browser-level checks below are not part of CI.

What has been checked, and what has not:

- The move generator matches the standard perft results for the start position, Kiwipete and three other test positions.
- The panel, settings, watchdog, quick replies, input modes the allowed-pages list (a non-listed page stays paused; adding an entry enables it), drag-to-click fallback, checkmate detection for both outcomes, new-game reset, the result-dialog check and the Tools & backup buttons were exercised in Chromium against a mock board that imitates chess.com's markup and a random bot. In that setup the 1.2.0 code stopped moving once DOM notifications stopped, and 1.3.0 kept playing at every watchdog interval tried (300, 1000 and 5000 ms).
- Stockfish imperfection was run through `background.js` with the real engine; every returned move was legal.
- **Not tested: real Firefox.** Everything above ran in Node (and earlier versions in Chromium). Firefox's handling of the extension has not been measured here.
- **Not tested on the live chess.com site.** Its markup and its handling of synthetic pointer events can differ from the mock, so drag and mixed input in particular should be treated as experimental. Click mode is the one carried over from 1.2.0.

## Changelog

**1.8.0** (Stockfish: pondering pool, shared module, optional clock cap and threads. Only the version changes in `manifest.json`: no permission, no CSP change. Defaults leave Stockfish behaving as in 1.7.9.)
- **Stockfish pondering** (`sfPonder`, `sfPonderMs`, `sfPonderWorkers`, `sfPonderHashMb`; off by default). Same pool, shared ponder state, token / deadline logic and hit / miss / late accounting as AggroChess; the main Stockfish worker is never used for idle work. Cancel is `stop` + `isready` (terminate only after 1.5 s without an answer). Ranking by one MultiPV search (8 lines), reply searches from one shared queue, one legal move = think about it for the whole time, a running reply search is harvested when the opponent plays that move and it is already at depth 8. Failure handling as for AggroChess (start timeout, `onerror`, error cooldown, a failing worker drops out, the main engine is unaffected).
- **Shared compiled module** through the new `engine/sf-worker.js` (the shipped Stockfish loader is untouched): the `.wasm` is compiled once (`compileStreaming`, then `fetch` + `compile`), posted to the wrapper, and used by the loader's own wasm step. Start order for every Stockfish worker: wrapper + module, loader directly, asm.js (main worker only).
- **Warm spares**: a ponder worker is warmed up before it counts as ready and spares exist only while pondering is wanted and no real search is running; a new game sends them `ucinewgame`.
- **`sfThreads`** (default 1) and the threaded build `engine/stockfish-19-lite.js/.wasm` (byte-identical copies from the npm package, `stockfish@19.0.1`). A runtime test of `SharedArrayBuffer` / `Atomics` / shared memory (shown in Copy debug info) decides; any failure keeps the single-thread engine and is not retried. **No manifest, CSP or header change was made; none is needed for the code to run, but whether Firefox allows SharedArrayBuffer in the background page is unverified.**
- **`sfUseClock`** (default off): caps the full search with the clock budget of `clock.js` (never more than a quarter of the remaining time), combined with `sfMaxMs`.
- `setoption MultiPV` is only sent when the value changes. New tests (`tests/stockfish-pool.test.js`, additions to `tests/ponder.test.js`); older tests unchanged and green. New `tests/bench-stockfish.js`.
- **What was measured and not changed** (details below): Hash 64 / 128 for the main worker (no gain), ponder-hit reuse by swapping roles (+0.25 ply), UCI pondering with `go ponder` (hit rate 52% against 88% for the queue), Move Overhead (no effect with `go depth` / `movetime`).

**Measured in Node 22.23 on 1 CPU core (Intel Xeon @ 2.10 GHz), engine `stockfish-19-lite-single` in worker_threads. Node/V8 only: not Firefox, not a phone. The machine has 1 core, so every number about several workers shows time-slicing, not a speed-up.**

| Start-up and memory (median) | before (1.7.9) | after (1.8.0) |
| --- | ---: | ---: |
| cold worker, creation to `readyok` (Hash 32) | 144 ms, paid when needed | 144 ms, paid in the background by a warm spare; a ready spare starts at once |
| warm-up | none | 28 ms (before the spare counts as ready) |
| first search, `movetime 30` | 33.2 ms | 31.3 ms after warm-up (the repeat costs 31.0) |
| V8 compile of the `.wasm` per extra worker | 4.7 ms (lazy in V8; Firefox compiles up front, not measured) | once for all workers |
| memory per worker (RSS growth) | - | 58 MiB (Hash 16), 74 (32), 106 (64), 170 (128) |

| Depth of the first search of a fresh worker, mean of 5 positions x 3 | 150 ms | 500 ms | 1500 ms |
| --- | ---: | ---: | ---: |
| cold (1.7.9, no warm-up) | 11.7 | 16.8 | 20.1 |
| after the warm-up | 12.9 | 17.1 | 20.3 |

The warm-up helps the very first 150 ms search (mostly one position, 8.0 -> 10.7, probably the engine code still being optimised) and is within noise at 500 / 1500 ms. Nodes per second of a warmed worker: 177k (150 ms), 371k (500 ms), 451k (1500 ms). **Warm and cold agree exactly:** with `go nodes 60000` and Threads 1, 14 of 14 searches (warm vs cold, and after `stop` + `ucinewgame` vs cold) gave the same bestmove, score, depth and node count (so the warm-up and the stop-cancel leave no state behind). Concurrent workers at 500 ms, mean depth per worker: 17.8 (1), 16.3 (2), 15.2 (3), on 1 core.

| Ponder hit rate (48 positions after our move, 31.9 legal opponent moves on average, simulation) | top 1 | top 3 | top 5 | top 8 |
| --- | ---: | ---: | ---: | ---: |
| opponent AggroChess 150 ms: per-move scan 12 ms (401 ms wall) | 38% | 73% | 88% | 96% |
| opponent AggroChess 150 ms: MultiPV 8, 120 ms (121 ms wall) | 46% | 77% | 88% | 94% |
| opponent AggroChess 150 ms: the engine's own UCI `ponder` move | 52% | - | - | - |
| opponent Stockfish depth 9 (same engine family, optimistic): MultiPV 120 ms | 71% | 92% | 98% | 98% |
| opponent Stockfish depth 9: scan 12 ms | 56% | 81% | 92% | 98% |

At a 1500 ms ponder time with a 250 ms reply slice the model gives room for 4-5 replies with 1 worker (MultiPV: 5, scan: 4), 8-10 with 2 and 12-15 with 3 (workers assumed parallel). Hit rate at that capacity, opponent AggroChess: 1 worker 77-81% (MultiPV 60-120 ms) against 75% (scan 12 ms); 2 workers 88-94% against 88%; 3 workers 90% against 100% (scan 12 ms). Against a random-move opponent (floor): 1 worker 23% (MultiPV) vs 13% (scan); 3 workers 44% vs 54%. So MultiPV ranks better and costs a third of the CPU with 1 worker (the case that matters on a phone); with 3 workers the scan ranks the whole move list and is slightly better against very weak opponents. `SF_RANK_MODE` is `'multipv'`; switch it to `'scan'` if you mostly use 3 workers against weak bots. The single-move UCI ponder (`go ponder` / `ponderhit`) would cover one move (52% hit, same as the top 1 above) while the queue covers 4-5 (88%), so it was **not implemented**.

| Move quality (30 positions; loss in cp against a depth-14 best move, moves scored at depth 12) | mean loss | losing > 100 cp | same move as the normal search |
| --- | ---: | ---: | ---: |
| normal search, `go depth 10` | 2.8 | 0 | - |
| ponder reply, `go depth 10 movetime 250` | 2.4 | 0 | 30 / 30 |
| ponder reply stopped after 60 ms (harvest) | 3.4 | 0 | 29 / 30 |

On these positions the ponder replies were not weaker than the normal search (sample is small; this is not a strength rating). Main-worker hash at equal time (500 ms, 16 positions): depth 17.19 / 16.81 / 16.88 and 405k / 381k / 383k nodes/s for 32 / 64 / 128 MB: **no gain, the main hash stays 32 MB and there is no setting for it.** Ponder-hit reuse (next real search, 250 ms, 16 positions): depth 15.31 on the ponder worker that searched the position, 15.06 on the main worker with its older hash, 14.31 cold: +0.25 ply for the role swap, **not implemented**. Threaded build (`stockfish-19-lite`, Node): it runs, depth 17.8 / 15.6 / 14.2 for Threads 1 / 2 / 4 and 484k / 485k / 493k nodes/s at equal time, which on this **1-core** machine only shows time-slicing; no speed-up was or could be measured.

- **Not done, and why:** Move Overhead (only used with `wtime`/`btime`; the extension sends `depth` / `movetime`); stopping pondering when the opponent replies faster than a minimum slice (the opponent's speed is unknown); "skip the search when pointless" (one legal move, recapture, promotion, mate in 1 already go through the quick-reply path; a prepared reply is the new case, done); batching `postMessage` and info parsing (the main worker already parses `info` only with MultiPV above 1; ponder workers parse the few lines they get); SIMD: the shipped lite-single wasm was not scanned for v128 opcodes and no SIMD gain is claimed; true `go ponder`; swapping the roles of ponder and main worker.
- **Not tested:** real Firefox and Firefox for Android (the wrapper worker with `importScripts`, `compileStreaming` on a `moz-extension://` URL, `postMessage` of a Module, memory of 3 Stockfish workers on a phone, the time `stop` takes there), whether Firefox allows `SharedArrayBuffer` / threaded workers in the background page (so whether `sfThreads` above 1 ever starts), the hit rate against real chess.com bots (the simulation used AggroChess, Stockfish and random moves), the panel's new section, `sfUseClock` with the real chess.com clock.

**1.7.9** (AggroChess engine path faster; nothing else changed. Only the version changes in `manifest.json`: no permission, no CSP change.)
- **Ponder worker pool** (`aggroPonderWorkers`, 1-3, default 1 = the old behaviour; capped at `max(1, hardwareConcurrency - 1)`; about 50 MiB per worker). The workers take opponent moves from one shared queue for the ranking pass and for the reply searches; the token / deadline / overrun checks apply to every worker; a miss, a late reply, a new game or switching pondering off terminates all of them; a real search never waits for a ponder worker. The ponder state keeps a *set* of running moves (the old `setRunning` still works) and `decide()` also says whether a worker was on the very move the opponent played. A failing worker drops out and the others finish the job. Small fix: a real request while a job had no entry yet (evaluation line still running) did not stop the ponder workers; it does now.
- **Shared compiled module + warm spare.** `background.js` compiles the `.wasm` once (`compileStreaming`, falling back to `fetch` + `arrayBuffer`) and posts the module to every worker, which only instantiates it; without a module (or if cloning or instantiating throws) the worker fetches the file as before. Before `ready` a worker now runs a warm-up (`set_position` of a non-book middlegame FEN, `think(5)`, `clear_hash`, `set_position('')`), so the engine's lazy initialisation (net, book, hash table) is not paid inside the first real search. If the engine traps in the warm-up, a clean second instance is used. After ponder workers are killed, warmed replacements are made (only while pondering or the evaluation line is on, never more workers in total than the cap, and not while a real search is running, so they cannot take CPU from it). Start timeout, `onerror`, cooldown and think timeout work as before.
- **Engine: AggroChess 4.6.1 (was an older build) in two builds.** `engine/aggrochess.wasm` and `engine/aggrochess-simd.wasm` (simd128); `background.js` picks the SIMD one when `WebAssembly.validate` accepts a tiny SIMD module and compiles it, else the plain one. Both come from the 4.6.1 web source with a small patch (clock polled every 256 nodes instead of 1024; new exports `set_tt_mb(mb)` and `think_depth(depth, ms)`). The playing code is untouched. **This replaces the older engine binary that 1.7.8 shipped**: on 5 positions x 3 runs at 300 ms the first move was the same as the old binary's in 15 of 15 searches, but that is not a strength test.
- **New setting `aggroPonderHashMb`** (4-64 MB, default 32): hash size of the ponder workers only, so more of them fit on a phone. The main worker is unchanged.
- **Stepped ponder replies (off).** `think_depth` lets a ponder reply be searched one depth at a time, each finished depth being a usable partial reply. It is wired in behind `PONDER_STEPPED = false` at the top of the ponder section of `background.js`, because replies from it have not been compared with `think(ms)` replies for strength. Cancelling still terminates the worker (the pool rules above), so the "cancel between depths and keep the hash" idea is not used.
- **New `tests/bench-aggro.js`** (see Development) and tests for the pool, the hand-off and its fallbacks, the SIMD choice, the hash size, the stepped path, the worker's warm-up and `ponder.test.js` additions. All earlier tests unchanged and green.
- **Measured in Node 22 on 1 CPU core of a 2.3 GHz Xeon (V8, not Firefox; numbers vary by machine):**

| Start-up, median of 7 (ms) | 1.7.8 | 1.7.9 |
| --- | ---: | ---: |
| instantiate in each worker | 8.2 (from bytes) | 1.0 (shared module) |
| warm-up before `ready` | - | 61 |
| first search (budget 30 ms), wall | 55.4 | pays no lazy init |
| the lazy init inside that first search | 21.8 | ~0 |

(V8 compiles lazily, so the compile cost, 0.6 ms here, is under-stated; Firefox compiles up front.)

| Depth of the first search of a fresh instance, mean of 5 positions | 150 ms | 500 ms | 1500 ms |
| --- | ---: | ---: | ---: |
| 1.7.8 (compiled from bytes, no warm-up) | 11.6 | 14.2 | 16.8 |
| 1.7.9 (shared module + warm-up) | 11.6 | 14.4 | 16.8 |

No depth gain was measurable (the lazy init is 20-60 ms, once per worker); the gain is that the first search no longer loses that time, and that a replacement ponder worker is ready before it is needed. **Warm-up leaves no trace:** with a deterministic clock and random source, a warmed-up instance gave exactly the same move, score, depth and flags as a cold one in 16 of 16 searches (both builds; includes the warm-up position itself and positions with move history). Concurrent instances, 500 ms, mean depth per instance: 14.8 (1), 13.0 (2), 12.2 (3), but this machine has **1 core**, so that only shows time-slicing; it says nothing about a multi-core phone.

| AggroChess build (Node, same work) | time for identical searches | identical results |
| --- | ---: | ---: |
| plain vs SIMD | SIMD took 0.83-0.86 of the time in two orders (plain vs plain control: 0.95, so about 5% noise) | 15 / 15 (move, score, depth, number of clock polls) |

SIMD therefore looks about 15% faster in V8. **Not measured: Firefox, Firefox for Android, ARM.**
- **Clock polling:** the clock is now read every 256 nodes (was 1024): about 3 times as many calls (1996 vs 685 per second at 150 ms), 99th-percentile gap between reads 1.6 ms instead of 6.8 ms. The 50 ms overrun seen in the browser was **not reproduced in Node** (overrun past the budget was at most 1.4 ms before and 4.5 ms after over 40 searches at 100/200 ms), so no overrun gain is claimed.
- Not tested: real Firefox (module hand-off by `postMessage`, `WebAssembly.compileStreaming` on a `moz-extension://` URL, `WebAssembly.validate` of the SIMD probe, memory use of 3 ponder workers on Android, the hit rate with more workers), the real chess.com page.

**1.7.8**
- **PGN recorder rewritten.** The recorder now keeps every board position that was seen and rebuilds the moves when the game is built. Missed moves (a gap between two reads) are reconstructed at the end by searching the legal move sequences between the earlier and the later position, with all later positions as context (side to move, last-move square, the bot's announced moves). Before, a gap was guessed on the spot, wrongly, and the following moves were then recorded from a wrong position, which produced illegal PGN that chess.com rejected.
- Moves you play by hand while Auto-play is paused are recorded like any other; only the bot's moves count for sacrifices, matched by position and move so they also count inside a reconstructed gap.
- The PGN is plain (no `{gap}` comments); it has the full seven-tag roster, and two optional headers (`ChessVisionReconstructedPlies`, `ChessVisionIncomplete`). SAN checked for check / mate markers, promotions, castling, en passant and disambiguation.
- The live history tracker (used for the engines) no longer accepts a two-ply explanation when the side to move says it cannot be one.
- **Maia-3 removed completely:** the `maia3` engine option, its three settings (`maiaElo`, `maiaOppoElo`, `maiaTemperature`), `maia.js`, `tests/maia.test.js`, `tools/`, the ONNX model and the onnxruntime-web files in `engine/`. The package shrinks by about 61 MB. A stored `engine: maia3` setting is ignored and AggroChess is used. `engine/NOTICE.txt` was not edited and still lists the Maia-3 and onnxruntime-web components; remove those entries by hand.
- `chessvision-project-summary.md` is part of the zip and is updated with every change.
- New test: `tests/recorder.test.js` (the reported game, sparse snapshots, castling / promotion / en passant in gaps, takeback, new game, stray reads, unreachable positions). Not tested: the real chess.com page, real Firefox.

**1.7.2**
- Pondering prepares replies for many opponent moves inside the ponder time (ceiling) and uses whatever was found when the opponent moves; the status shows the number of replies found.
- Brilliant layer c (colour match) built; new host permission `*://*.chesscomfiles.com/*` (images only, fetched by the background page).
- Panel header: the "ChessVision" title is gone and "waiting for opponent" is now "WFO", so the pondering state is readable while the panel is collapsed.
- AggroChess fails cleanly: a worker that errors before `ready`, raises `onerror` or does not start within 15 s makes the move request return `AggroChess: ...` (shown in the panel in the error tone) instead of waiting forever; a failed worker is not re-created for 15 s, then retried with a fresh one. Every think is guarded by a timeout (3x the requested time plus 4 s); on timeout the stuck worker is terminated and re-created.
- History: Stockfish and AggroChess get the game's start and moves (repetition, 50-move rule); correct halfmove and fullmove numbers in the FEN; takebacks no longer count as new games. New pure module `boardstate.js` holds the board logic that used to be in `content.js`.
- Clock: AggroChess sizes its search from your clock (`aggroUseClock`, default on).
- AggroChess's hash is cleared on a real new game; new **Clear engine memory** button.
- The panel no longer blocks moves when it is dragged over the board (synthetic events skip it).
- **AggroChess options** group: clock, pondering on the opponent's time with a separate killable worker, evaluation line, position verification.
- Game recording to PGN, sacrifice counter (AggroChess's own flag), piece-type toggles, automatic saving rule, saved games list with download / copy, best-effort brilliant-move count (untested on the real site).
- Version strings unified (the content script said 1.3.0; it now reads the manifest). The manifest change is the version and the new content scripts in the list; no permission or CSP change. New tests: `boardstate`, `clock`, `ponder`, `pgn`; `stockfish.test.js` gained history-command and AggroChess-failure cases (the existing cases are unchanged).
- Not tested: the real chess.com page (clock selectors, player names, result dialog, brilliant popup), real Firefox, the Blob download, the AggroChess sacrifice flag on a real game, takebacks on the real site, ponder hit rate, the panel-over-the-board fix.

**1.6.0**
- Stockfish now runs as WebAssembly: Stockfish.js 19, lite NNUE net, single thread (`engine/stockfish-19-lite-single.js` + `.wasm`, GPL-3.0, see `engine/NOTICE.txt`). The multi-thread builds are not used (they need cross-origin isolation). The old `engine/stockfish-19-asm.js` stays as an automatic fallback if the wasm worker errors or does not answer `readyok` within 30 s; the active engine is logged in the background console.
- The search state is no longer cleared on every move: `ucinewgame` is sent only when a new game starts (first request, the standard start position, or more pieces than the previous request), detected in `background.js` from the FEN.
- `setoption name Threads value 1` and `setoption name Hash value 32` are sent once after start-up, before `isready`; the engine's option list is checked (a missing `Threads` option on the asm fallback is ignored).
- New optional setting **Stockfish max think time** (`sfMaxMs`, 0 = off, default 0, 0-10000 ms): `go depth N movetime M` when above 0. Included in Export/Import and the settings table. Quick replies are unchanged.
- If Stockfish cannot be started at all, the panel shows `Stockfish: could not start (...)` instead of waiting forever.
- Node check, 2 positions (start, Kiwipete), 1 CPU core, `ucinewgame` before each run, two runs: asm.js 19 took 0.4-7.8 s for depths 10-16 (about 23 s in total), WebAssembly Stockfish.js 18 lite 0.02-0.35 s (about 1.0 s in total; measured before the switch to the 19 lite build, which was not re-timed). The two engines search different node counts, so compare times, not nodes/s. Strength was **not** measured. Not tested: real Firefox, the wasm worker inside the extension, the asm fallback in a browser, timings on a real machine.
- No manifest permission or CSP change (the existing CSP already has `'wasm-unsafe-eval'`). New test: `tests/stockfish.test.js`.

**1.3.0**
- On-page control panel replaces the popup for all settings.
- Human-like play: natural delays, rare pauses, curved cursor, off-centre clicks, click/drag/mixed input, Stockfish imperfection.
- Quick replies for forced moves, recaptures, promotions and endgame pawn runs, and mate in one.
- Adjustable watchdog; changes arriving during a move are no longer dropped; stuck attempts time out.
- Auto-play only runs on pages listed in `allowed-pages.txt` (default: chess.com computer-bot pages).
- Drag moves fall back to clicks automatically when they do not register.
- Maia-3 as a third engine (`maia3`, removed in 1.7.8): runs the Maia-3 ONNX network locally with onnxruntime-web, loaded on first use; move choice masked to legal moves with temperature sampling; new settings Maia-3 rating, Opponent rating and Temperature (600-2600 / 0-1); replaces Imperfection for that engine. Adds about 46 MB (23M model) and 15 MB (runtime). Maia-3 and its ONNX export are AGPL-3.0; onnxruntime-web is MIT (see `engine/NOTICE.txt`).
- Game-over detection (checkmate, stalemate, result dialog) and per-game state reset.
- Tools & backup: export/import settings, copy debug info.
- GitHub Actions workflow for the unit tests; GPL-3.0 `LICENSE`.

**1.2.0** Initial version in this repository.

## License

GNU General Public License v3.0, see [`LICENSE`](LICENSE). The bundled engines in `engine/` are also GPL-3.0 (see `engine/NOTICE.txt`), which is why the extension's own code uses the same licence.

The Stockfish.js 19 WebAssembly files (`stockfish-19-lite-single.js` / `.wasm`, GPL-3.0) are listed with their source and checksums in `engine/NOTICE.txt`; both files come from the npm package `stockfish` 19.0.1 (`bin/`).
