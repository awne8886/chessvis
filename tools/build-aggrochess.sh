#!/usr/bin/env bash
# Rebuilds engine/aggrochess.wasm (plain) and engine/aggrochess-simd.wasm (simd128) from engine-src/aggrochess.
#
#   tools/build-aggrochess.sh                  build both, copy them to engine/, print their sha256
#   tools/build-aggrochess.sh --out DIR        build both into DIR instead of engine/
#   tools/build-aggrochess.sh --upstream-diff  also write engine-src/aggrochess/upstream.diff (needs git + network):
#                                              every change against the AggroChess 4.6.1 sources it was made from
#   tools/build-aggrochess.sh --net512 --out DIR   the 2.0.3 experiment (cargo feature net512: the (768 x 3 king
#                                              buckets -> 512) x 2 network, src/nnue512.rs); not shipped, so --out is
#                                              required (engine-src/aggrochess/README.md, "The 2.0.3 network")
#
# Pinned tools (a different version gives a different binary, maybe a different speed, but must not change a search;
# check with: node tests/bench-engines.js --diff OLD.wasm NEW.wasm and node tests/engine-signature.test.js):
#   Rust     1.100.0 (rustc 0ef1bc386 2026-11-09, the newest stable in Nov 2026), target wasm32-unknown-unknown, rustup
#   wasm-opt binaryen version_132 (downloaded into .build/ and checked by sha256 when BINARYEN is not given)
# Crate dependencies are pinned by engine-src/aggrochess/Cargo.lock (cargo --locked).
#
# wasm-opt -O3 runs on cargo's output with the feature set rustc emits (bulk-memory, nontrapping-fptoint, sign-ext,
# mutable-globals, multivalue, reference-types, bulk-memory-opt, call-indirect-overlong; + simd128 for the SIMD build;
# check with: wasm-opt --detect-features --print-features FILE). Since 2.0.2: 11% smaller (2.06 -> 1.84 MB), the same
# search, speed within noise. It drops the name section: WASM_OPT=0 gives cargo's output with function names (profiling).
# BINARYEN=/path/to/binaryen/bin uses an installed binaryen (it should be version_132).
set -euo pipefail

RUST_TOOLCHAIN=1.100.0
UPSTREAM_REPO=https://github.com/PhelRin/AggroChess
UPSTREAM_COMMIT=4d7692e955b677e7b3f6ec7a457598c2311685fe   # tag v4.6.1

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CRATE=$ROOT/engine-src/aggrochess
OUT=$ROOT/engine
UPSTREAM_DIFF=0
FEATURES=
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=$(mkdir -p "$2" && cd "$2" && pwd); shift 2 ;;
    --upstream-diff) UPSTREAM_DIFF=1; shift ;;
    --net512) FEATURES=net512; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
if [ -n "$FEATURES" ] && [ "$OUT" = "$ROOT/engine" ]; then echo "--net512 needs --out DIR (it is not shipped)" >&2; exit 2; fi

if ! rustup run "$RUST_TOOLCHAIN" rustc -V >/dev/null 2>&1; then
  rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --target wasm32-unknown-unknown
fi
rustup target add --toolchain "$RUST_TOOLCHAIN" wasm32-unknown-unknown >/dev/null
echo "using $(rustup run "$RUST_TOOLCHAIN" rustc -V)"

# The registry path ends up in panic-location strings; map it to a fixed prefix so the result does not depend on where
# cargo lives on this machine.
CARGO_HOME_DIR=${CARGO_HOME:-$HOME/.cargo}
REMAP="--remap-path-prefix=$CARGO_HOME_DIR=/cargo"

BINARYEN_VERSION=132
BINARYEN_SHA256=195ddc94f9bc89f45abdabb0b9eea86023d727ba90eac8b35b80f2544fc30572   # binaryen-version_132-x86_64-linux.tar.gz
if [ "${WASM_OPT:-1}" = "1" ] && [ -z "${BINARYEN:-}" ]; then
  BINARYEN=$ROOT/.build/binaryen-$BINARYEN_VERSION/bin
  if [ ! -x "$BINARYEN/wasm-opt" ]; then
    mkdir -p "$ROOT/.build/dl"
    tgz=$ROOT/.build/dl/binaryen-$BINARYEN_VERSION.tar.gz
    curl -sSL -o "$tgz" "https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN_VERSION/binaryen-version_$BINARYEN_VERSION-x86_64-linux.tar.gz"
    echo "$BINARYEN_SHA256  $tgz" | sha256sum -c - >/dev/null
    mkdir -p "$ROOT/.build/binaryen-$BINARYEN_VERSION" && tar -xzf "$tgz" -C "$ROOT/.build/binaryen-$BINARYEN_VERSION" --strip-components=1
  fi
fi
[ "${WASM_OPT:-1}" = "1" ] && echo "using $("$BINARYEN/wasm-opt" --version)"

build() {   # $1 = output name, $2 = extra RUSTFLAGS, $3 = target dir
  (cd "$CRATE" && RUSTFLAGS="$2 $REMAP" CARGO_TARGET_DIR="$CRATE/$3" \
    cargo "+$RUST_TOOLCHAIN" build --release --locked --target wasm32-unknown-unknown ${FEATURES:+--features $FEATURES})
  local wasm="$CRATE/$3/wasm32-unknown-unknown/release/aggrochess_web.wasm"
  if [ "${WASM_OPT:-1}" = "1" ]; then
    local opt="$BINARYEN/wasm-opt"
    "$opt" -O3 --enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int --enable-sign-ext \
      --enable-mutable-globals --enable-multivalue --enable-reference-types --enable-call-indirect-overlong \
      $( [ -n "$2" ] && echo --enable-simd ) "$wasm" -o "$OUT/$1"
  else
    cp "$wasm" "$OUT/$1"
  fi
}

build aggrochess.wasm "" target${FEATURES:+-$FEATURES}
build aggrochess-simd.wasm "-C target-feature=+simd128" target-simd${FEATURES:+-$FEATURES}

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
