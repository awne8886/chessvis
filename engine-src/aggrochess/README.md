# AggroChess 4.6.1 for the web (ChessVision build source)

The source of `engine/aggrochess.wasm` and `engine/aggrochess-simd.wasm`. It is **not** loaded at runtime; it is here so
the shipped binaries can be rebuilt and changed reproducibly (`tools/build-aggrochess.sh`).

AggroChess is by Rinarto Gibson, GPL-3.0 (`LICENSE`): <https://github.com/PhelRin/AggroChess>.

## Where the files come from

| File | Origin |
| --- | --- |
| `src/search.rs`, `src/eval.rs`, `src/nnue.rs`, `src/book.rs`, `src/matesearch.rs`, `aggro.nnue`, `aggro-ocb.nnue`, `LICENSE` | AggroChess **v4.6.1**, commit `4d7692e955b677e7b3f6ec7a457598c2311685fe` (tag `v4.6.1`), with the changes listed in `upstream.diff` |
| `src/lib.rs`, `src/web_clock.rs`, `Cargo.toml`, `build.rs` | the web wrapper, **reconstructed** for ChessVision 2.0.2 (see below) |
| `Cargo.lock` | AggroChess v4.6.1's lock file (cozy-chess 0.3.4, polyglot-book-rs 0.1.0), package renamed |

`upstream.diff` lists every change against the upstream files (regenerate it with
`tools/build-aggrochess.sh --upstream-diff`). In short:

* **web shims** (as in the original web package): the clock (`std::time::Instant`) and the random seeds of the opening
  book come from JavaScript (`env.js_now`, `env.js_random`, `src/web_clock.rs`);
* **ChessVision patch** (since 1.7.9, `engine/aggrochess-4.6.1-chessvision.patch` until 2.0.0): the clock and the stop
  flag are polled every 256 nodes instead of 1024; the exports `think_depth` and `set_tt_mb`;
* **2.0.2**: the bench export `last_info`; the speed changes described in `docs/REFERENCE.md` (2.0.2 changelog).

## How the wrapper was reconstructed, and how it was checked

The AggroChess 4.6.1 *web package* that the 2.0.0 binaries were built from (`AggroChess-4.6.1-wasm.zip`: `lib.rs`,
`build.rs` and the shims) was not available for 2.0.2. Its search, evaluation, net, book and mate-search sources are
the upstream ones (the shipped binaries embed the upstream nets byte for byte, and the crate is named `aggrochess_web`
with the modules `search`, `eval`, `nnue`, `book`, `matesearch`, `web_clock` in their name section). `lib.rs` and
`web_clock.rs` were rebuilt from the shipped binaries: their exports and imports, the function names in the name
section, the format strings in the data section, the disassembled wrapper functions (`wasm-dis`), and black-box calls.
The `position` handling mirrors AggroChess's own `uci.rs` (sacrifice count, the remembered score).

The rebuilt crate is accepted because it is indistinguishable from the shipped 2.0.0 binaries:

* `node tests/bench-engines.js --diff <2.0.0 build> <rebuild>`: 145 scripted calls (positions and failures, `think`,
  `think_clock`, `think_depth`, `analyze` up to 300 ms, book moves, SEE, ponder move, game status) with a deterministic
  fake clock (each `js_now` call advances it by 0.1 ms, also run at 0.037 and 0.013 ms) and a fixed random sequence:
  every answer **and** the number of `js_now` / `js_random` calls after every call are identical, for the plain and the
  SIMD build. With a fake clock a timed search stops at an exact node, so a single different node anywhere in a search
  shows up here.
* The bench signature of `docs/OPUS_PROMPT_2.0.2.md` §3, measured on the original crate: depth 12 = 1 422 083 nodes and
  depth 8 = 118 270 nodes, moves `e5g6 f3g5(book) e1g1 c1g5 c3e2 e4e5 f5d3 f6g4 f4f5 d4d8`: reproduced exactly
  (`tests/engine-signature.test.js` checks depth 8 on every test run).

Two details found on the way: a bad FEN in `set_position` gives the start position and drops the moves after it, and
`analyze` also switches off `SWINDLE` and `BEAUTIFUL_MATES` (search.rs: "Analysis turns it off").

## Build

```
tools/build-aggrochess.sh          # rustc 1.100.0 (pinned), both builds, copied to engine/, sha256 printed
```

The build is byte-reproducible (two clean builds give the same files); the sha256 of the shipped files are in
`engine/NOTICE.txt`.
