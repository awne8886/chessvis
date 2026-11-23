#!/usr/bin/env bash
# Rebuilds engine/aggrochess.wasm (plain) and engine/aggrochess-simd.wasm (simd128) from engine-src/aggrochess.
#
#   tools/build-aggrochess.sh                  build both, copy them to engine/, print their sha256
#   tools/build-aggrochess.sh --out DIR        build both into DIR instead of engine/
#   tools/build-aggrochess.sh --upstream-diff  also write engine-src/aggrochess/upstream.diff (needs git + network):
#                                              every change against the AggroChess 4.6.1 sources it was made from
#
# Pinned tools (a different version gives a different binary, maybe a different speed, but must not change a search;
# check with: node tests/bench-engines.js --diff OLD.wasm NEW.wasm and node tests/engine-signature.test.js):
#   Rust     1.100.0 (rustc 0ef1bc386 2026-11-09), target wasm32-unknown-unknown, installed with rustup
#   wasm-opt binaryen version_132 (only with WASM_OPT=1, see below)
# Crate dependencies are pinned by engine-src/aggrochess/Cargo.lock (cargo --locked).
#
# WASM_OPT=1 runs `wasm-opt -O3` with the feature set rustc emitted on top (BINARYEN=/path/to/binaryen/bin, default:
# wasm-opt on PATH). Not used for the shipped 2.0.2 binaries (see docs/REFERENCE.md, 2.0.2 changelog).
set -euo pipefail

RUST_TOOLCHAIN=1.100.0
UPSTREAM_REPO=https://github.com/PhelRin/AggroChess
UPSTREAM_COMMIT=4d7692e955b677e7b3f6ec7a457598c2311685fe   # tag v4.6.1

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CRATE=$ROOT/engine-src/aggrochess
OUT=$ROOT/engine
UPSTREAM_DIFF=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=$(mkdir -p "$2" && cd "$2" && pwd); shift 2 ;;
    --upstream-diff) UPSTREAM_DIFF=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

if ! rustup run "$RUST_TOOLCHAIN" rustc -V >/dev/null 2>&1; then
  rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --target wasm32-unknown-unknown
fi
rustup target add --toolchain "$RUST_TOOLCHAIN" wasm32-unknown-unknown >/dev/null
echo "using $(rustup run "$RUST_TOOLCHAIN" rustc -V)"

# The registry path ends up in panic-location strings; map it to a fixed prefix so the result does not depend on where
# cargo lives on this machine.
CARGO_HOME_DIR=${CARGO_HOME:-$HOME/.cargo}
REMAP="--remap-path-prefix=$CARGO_HOME_DIR=/cargo"

build() {   # $1 = output name, $2 = extra RUSTFLAGS, $3 = target dir
  (cd "$CRATE" && RUSTFLAGS="$2 $REMAP" CARGO_TARGET_DIR="$CRATE/$3" \
    cargo "+$RUST_TOOLCHAIN" build --release --locked --target wasm32-unknown-unknown)
  local wasm="$CRATE/$3/wasm32-unknown-unknown/release/aggrochess_web.wasm"
  if [ "${WASM_OPT:-0}" = "1" ]; then
    local opt="${BINARYEN:+$BINARYEN/}wasm-opt"
    "$opt" -O3 --enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int --enable-sign-ext \
      --enable-mutable-globals --enable-multivalue --enable-reference-types --enable-call-indirect-overlong \
      $( [ -n "$2" ] && echo --enable-simd ) "$wasm" -o "$OUT/$1"
  else
    cp "$wasm" "$OUT/$1"
  fi
}

build aggrochess.wasm "" target
build aggrochess-simd.wasm "-C target-feature=+simd128" target-simd

if [ "$UPSTREAM_DIFF" = "1" ]; then
  TMP=$(mktemp -d)
  git -C "$TMP" init -q && git -C "$TMP" fetch -q --depth 1 "$UPSTREAM_REPO" "$UPSTREAM_COMMIT" && git -C "$TMP" checkout -q FETCH_HEAD
  {
    echo "# Changes in engine-src/aggrochess against AggroChess $UPSTREAM_COMMIT (tag v4.6.1, $UPSTREAM_REPO)."
    echo "# src/lib.rs and src/web_clock.rs are new (the web wrapper); the nets are unchanged."
    for f in search eval nnue book matesearch; do diff -u "$TMP/src/$f.rs" "$CRATE/src/$f.rs" --label "a/src/$f.rs" --label "b/src/$f.rs" || true; done
    for f in aggro.nnue aggro-ocb.nnue; do cmp -s "$TMP/$f" "$CRATE/$f" || echo "# $f DIFFERS from upstream"; done
  } > "$CRATE/upstream.diff"
  rm -rf "$TMP"
  echo "wrote $CRATE/upstream.diff"
fi

(cd "$OUT" && sha256sum aggrochess.wasm aggrochess-simd.wasm && ls -l aggrochess.wasm aggrochess-simd.wasm)
