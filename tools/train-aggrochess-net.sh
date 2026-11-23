#!/usr/bin/env bash
# ChessVision 2.0.3: how engine-src/aggrochess/aggro-768x3hm-512.nnue (an experimental AggroChess network, NOT shipped:
# it lost to 4.6.1's network, see engine-src/aggrochess/README.md) is made. Not part of the extension build: the network
# file is committed, and tools/build-aggrochess.sh --net512 --out DIR builds an engine with it.
#
#   1. Self-play data: AggroChess 4.6.1 (native build of the upstream tag, with its own network) plays itself from
#      random openings with the personality off: `aggro_chess datagen <prefix> <threads> <positions> <nodes> <seed>`
#      (upstream src/datagen.rs; quiet positions with the search score and the game result). Deterministic per
#      thread for a given seed.
#   2. engine-src/aggrochess/bullet `convert`: to bulletformat, shuffled with a fixed seed; 100 000 positions are held
#      out (`pack loss` measures the loss on them; bullet's CPU backend computes no validation loss itself).
#   3. `train`: bullet (pinned to the last commit with a CPU backend), (768 x 3 mirrored king buckets -> 512) x 2,
#      8 output buckets, AdamW, cosine learning rate, WDL weight 0.3 (as 4.6.1's trainer), eval scale 400.
#      Multi-threaded float training is not bit-reproducible; the result is committed.
#   4. `pack`: bullet's quantised.bin -> the engine's file; `pack calibrate` measures the engine's OUT_SCALE (nnue.rs)
#      that puts the new network's evaluations on 4.6.1's scale.
#
#   tools/train-aggrochess-net.sh [--work DIR] [--threads N] [--positions N] [--nodes N] [--seed S]
#                                 [--superbatches K] [--batches B] [--lr X] [--wdl X] [--skip-datagen]
# Defaults: --work .build/net, --threads 4, --positions 6000000, --nodes 3000, --seed 1001, --superbatches 40,
# --batches = one pass over the data per superbatch (positions / 16384), --lr 0.001, --wdl 0.3.
# 2.0.3's network: two datagen runs of 4 threads at 3000 nodes (seeds 1001 and 2002, stopped after 3.4 and 3.3 million
# positions), then --skip-datagen --superbatches 24 (engine-src/aggrochess/README.md has the numbers).
# Then: copy the network to engine-src/aggrochess/, set OUT_SCALE in src/nnue512.rs, build with --net512, regenerate
# tests/fixtures/nnue-eval.txt (tests/make-nnue-fixture.js), and play tests/match-aggro.js against engine/.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$ROOT/.build/net THREADS=4 POSITIONS=6000000 NODES=3000 SEED=1001 SB=40 BATCHES= LR=0.001 WDL=0.3 SKIP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --work) WORK=$2; shift 2 ;; --threads) THREADS=$2; shift 2 ;; --positions) POSITIONS=$2; shift 2 ;;
    --nodes) NODES=$2; shift 2 ;; --seed) SEED=$2; shift 2 ;; --superbatches) SB=$2; shift 2 ;;
    --batches) BATCHES=$2; shift 2 ;; --lr) LR=$2; shift 2 ;; --wdl) WDL=$2; shift 2 ;; --skip-datagen) SKIP=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
RUST_TOOLCHAIN=1.100.0
UPSTREAM_REPO=https://github.com/PhelRin/AggroChess
UPSTREAM_COMMIT=4d7692e955b677e7b3f6ec7a457598c2311685fe   # tag v4.6.1
mkdir -p "$WORK"

# 1. data
if [ "$SKIP" = 0 ]; then
  if [ ! -x "$WORK/upstream/target/release/aggro_chess" ]; then
    rm -rf "$WORK/upstream" && git init -q "$WORK/upstream"
    git -C "$WORK/upstream" fetch -q --depth 1 "$UPSTREAM_REPO" "$UPSTREAM_COMMIT" && git -C "$WORK/upstream" checkout -q FETCH_HEAD
    (cd "$WORK/upstream" && RUSTFLAGS="-C target-cpu=native" cargo +$RUST_TOOLCHAIN build --release --locked)
  fi
  (cd "$WORK" && "$WORK/upstream/target/release/aggro_chess" datagen data "$THREADS" "$POSITIONS" "$NODES" "$SEED")
fi

# 2-4. convert, train, pack
(cd "$ROOT/engine-src/aggrochess/bullet" && cargo +$RUST_TOOLCHAIN build --release --locked)
BIN=$ROOT/engine-src/aggrochess/bullet/target/release
"$BIN/convert" "$WORK/train.bf" --valid "$WORK/valid.bf" 100000 "$WORK"/data_*.bin
N=$(( $(stat -c %s "$WORK/train.bf") / 32 ))
[ -n "$BATCHES" ] || BATCHES=$(( (N + 16383) / 16384 ))
"$BIN/train" "$WORK/train.bf" "$WORK/checkpoints" "$SB" "$BATCHES" "$THREADS" "$LR" "$WDL" aggro-768x3hm-512
Q=$(ls -d "$WORK"/checkpoints/aggro-768x3hm-512-"$SB" | head -1)/quantised.bin
"$BIN/pack" "$Q" "$WORK/aggro-768x3hm-512.nnue"
"$BIN/pack" loss "$Q" "$WORK/valid.bf" "$WDL" "$ROOT/engine-src/aggrochess/aggro.nnue"
"$BIN/pack" calibrate "$Q" "$ROOT/engine-src/aggrochess/aggro.nnue" "$WORK/valid.bf" 100000
echo "network: $WORK/aggro-768x3hm-512.nnue (copy it to engine-src/aggrochess/, set OUT_SCALE in src/nnue512.rs)"
