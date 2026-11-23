# AggroChess 4.6.1 for the web (ChessVision build source)

The source of `engine/aggrochess.wasm` and `engine/aggrochess-simd.wasm`. It is **not** loaded at runtime; it is here so
the shipped binaries can be rebuilt and changed reproducibly (`tools/build-aggrochess.sh`).

AggroChess is by Rinarto Gibson, GPL-3.0 (`LICENSE`): <https://github.com/PhelRin/AggroChess>.

## Where the files come from

| File | Origin |
| --- | --- |
| `src/search.rs`, `src/eval.rs`, `src/nnue.rs`, `src/book.rs`, `src/matesearch.rs`, `aggro.nnue`, `aggro-ocb.nnue`, `LICENSE` | AggroChess **v4.6.1**, commit `4d7692e955b677e7b3f6ec7a457598c2311685fe` (tag `v4.6.1`), with the changes listed in `upstream.diff` |
| `src/nnue512.rs`, `aggro-768x3hm-512.nnue` | 2.0.3 **experiment, not shipped**: a network trained for ChessVision with king buckets, and its code (cargo feature `net512`; see *The 2.0.3 network*) |
| `bullet/` | 2.0.3: the training tools (bullet, CPU backend): `convert`, `train`, `pack` |
| `src/lib.rs`, `src/web_clock.rs`, `Cargo.toml`, `build.rs` | the web wrapper, **reconstructed** for ChessVision 2.0.2 (see below) |
| `Cargo.lock` | AggroChess v4.6.1's lock file (cozy-chess 0.3.4, polyglot-book-rs 0.1.0), package renamed |

`upstream.diff` lists every change against the upstream files (regenerate it with
`tools/build-aggrochess.sh --upstream-diff`). In short:

* **web shims** (as in the original web package): the clock (`std::time::Instant`) and the random seeds of the opening
  book come from JavaScript (`env.js_now`, `env.js_random`, `src/web_clock.rs`);
* **ChessVision patch** (since 1.7.9, `engine/aggrochess-4.6.1-chessvision.patch` until 2.0.0): the clock and the stop
  flag are polled every 256 nodes instead of 1024; the exports `think_depth` and `set_tt_mb`;
* **2.0.2**: the bench export `last_info`; the speed changes described in `docs/REFERENCE.md` (2.0.2 changelog).
* **2.0.3**: nothing in the shipped build. The experimental network replaces `src/nnue.rs` by `src/nnue512.rs` only
  with `--features net512` (with the test exports `nn_eval_raw` and `nnue_selftest`); `upstream.diff` covers the
  default build.

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
tools/build-aggrochess.sh --net512 --out .build/net512   # the 2.0.3 experiment (not shipped); node tests/net512.test.js
```

The build is byte-reproducible (two clean builds give the same files); the sha256 of the shipped files are in
`engine/NOTICE.txt`.

## The 2.0.3 network (experiment, not shipped)

ChessVision 2.0.3 trained a larger network for AggroChess with bullet, with mirrored king buckets and a Finny table.
It is **not** in the shipped engine: at equal time per move it lost to 4.6.1's network (below). The code, the network
and the tools are kept so it can be retrained with more data: `tools/build-aggrochess.sh --net512 --out DIR` builds it.

`aggro-768x3hm-512.nnue`: (768 inputs x 3 king buckets, mirrored -> 512) x 2 -> SCReLU -> 1, with 8 output buckets by
piece count. 4.6.1's network is (768 -> 256) x 2 with no king buckets.

* **Inputs** are bullet's `ChessBucketsMirrored`: each side sees the board from its own side (Black's view flipped
  vertically) and mirrored left-right when its king is on files e-h; its king square picks one of three sets of
  feature weights: king sheltered in a corner (files a/b/g/h, ranks 1-2), central on the back two ranks (files c-f), or
  advanced (rank 3 and up). A factoriser (weights shared by the buckets) was trained with them and merged into each
  bucket when the network was saved.
* **Finny table** (`src/nnue512.rs`): a king move into another bucket, or across the middle of the board, changes every
  feature of that side. That side is then rebuilt from a per-thread cache holding one accumulator per (side, bucket,
  mirroring) together with the pieces it was built for: only the pieces that differ are added or removed. Positions
  the search has no accumulator for are built the same way. The sums are exact wrapping i16 arithmetic, so the result
  equals a build from scratch (`nnue_selftest` checks this through random games; `tests/net512.test.js`).
* **File format** ("AGNB", written by `bullet/src/bin/pack.rs`): the feature weights are stored one byte each, with an
  escape for the few outside -127..127 (lossless), and decoded once when the engine starts: 1.24 MB, and 2.70 MB per
  binary (the shipped ones are 1.84 MB).
* **Opposite-coloured bishop endings** with a buried bishop are still judged by 4.6.1's second network
  (`aggro-ocb.nnue`, 768 -> 256, its 67% output scale), evaluated from scratch.

**Training data.** AggroChess 4.6.1 itself (native build of the upstream tag, its own network) playing itself with
its personality off: `aggro_chess datagen`, random 8-9 ply openings, 3000 nodes per move, quiet positions labelled with
the search score and the game result: the recipe 4.6.1's network was made with (its README: three rounds, about 3.1
million positions). 6 703 120 positions, 100 000 of them held out.

**Training** (`bullet/`, bullet pinned to commit `feab644`, the last one with a CPU backend: trained without a GPU, on
4 cores): 24 passes over the data, AdamW, batch 16 384, cosine learning rate from 0.001, 30% weight on the game result
(as 4.6.1's trainer), evaluation scale 400, quantisation QA 255 / QB 64 (as 4.6.1); 1 h 18 min.
`tools/train-aggrochess-net.sh` runs the whole chain. Multi-threaded float training is not bit-reproducible, so the
network file is committed.

**Checks.** The engine's raw output equals bullet's own computation (`pack eval`, from bullet's feature mapping and
the quantised network) on the 783 positions of `tests/fixtures/nnue-eval.txt`, in both builds; the output scale
(`OUT_SCALE` = 56%) was measured against 4.6.1's scaled evaluation with `pack calibrate` (correlation 0.93).

**Result** (`tests/match-aggro.js`, Node 22, 4 cores, 200 games each: 100 paired openings, colours swapped, SIMD
builds; Elo of the new network, 95% interval):

| Time per move | New network: W / D / L | Elo |
| --- | --- | --- |
| 100 ms | 77 / 10 / 113 | -63 [-112, -16] |
| 300 ms | 64 / 6 / 130 | -119 [-172, -71] |

A first try on 2.4 million positions (10 passes) scored -60 [-110, -12] at 100 ms. The new network searches about 26%
fewer nodes per second (about 790 k against 1 070 k, `think(1000)` over the bench positions; depth 16.6 against 16.9),
but it lost by more at 300 ms, where that matters less: the network itself is the main cause. On the held-out
positions it fits the search scores worse than 4.6.1's network (squared error on the scores alone 0.0066 against
0.0059, `pack loss ... 0 aggro.nnue`; a comparison that favours 4.6.1's network, whose own searches made the labels),
and its error there stays well above its training error (0.0055 against 0.0039, with 30% results). The likely reason:
six times the first-layer weights of 4.6.1's network (1.18 million) learned from only about twice its data. More
self-play (tens of millions of positions; datagen makes about 2 million per hour on 4 cores) or training on a GPU is the
way to try again.
