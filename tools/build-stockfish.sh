#!/usr/bin/env bash
# Builds the relaxed-SIMD Stockfish builds: Stockfish.js 19.0.1, lite net, with WebAssembly relaxed SIMD.
#   engine/stockfish-19-lite-single-rsimd.{js,wasm}   single thread (ChessVision 2.0.2, B1)
#   engine/stockfish-19-lite-rsimd.{js,wasm}          threaded (pthreads, SharedArrayBuffer; ChessVision 2.0.6, C)
# Each plain build is rebuilt first and must reproduce the shipped file byte for byte (same source, same toolchain):
# engine/stockfish-19-lite-single.{js,wasm} (single) and engine/stockfish-19-lite.{js,wasm} (threaded, the npm
# stockfish 19.0.1 files). So the only difference of a relaxed build is the one compiler flag. When the plain THREADED
# build does not reproduce the npm files, the script stops (exit 1) before the relaxed threaded build: an unverified
# rebuild is never shipped. (The single-thread check only warns, as in 2.0.2.)
#
#   tools/build-stockfish.sh [--work DIR] [--emsdk DIR] [--out DIR] [--only single|threaded]
#
# Pinned (network needed: github.com for git, storage.googleapis.com for emsdk, registry.npmjs.org for terser,
# tests.stockfishchess.org or github.com for the lite net, which net.sh checks by its sha256 name):
#   source  https://github.com/nmrugg/stockfish.js tag v19.0.1 (commit 0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6), GPL-3.0
#   emsdk   6.0.9 (the version stockfish.js 19.0.1's build.js expects)
#   terser  5.51.2 (stockfish.js's own devDependency, exact)
# The relaxed build adds -mrelaxed-simd at compile and link time through a 6-line switch in emscripten/wasm-makefile.mk
# (RELAXED_SIMD=yes, below). Stockfish's own src/nnue/simd.h then uses wasm_i32x4_relaxed_dot_i8x16_i7x16_add for the
# int8 affine layers; that is deterministic here because the activations are clipped to 0..127. No other source change.
set -euo pipefail

SF_REPO=https://github.com/nmrugg/stockfish.js
SF_COMMIT=0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6
EMSDK_VERSION=6.0.9

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$ROOT/.build}
EMSDK_DIR=""
OUT=$ROOT/engine
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --work) WORK=$2; shift 2 ;;
    --emsdk) EMSDK_DIR=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --only) ONLY=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$WORK" "$OUT"
EMSDK_DIR=${EMSDK_DIR:-$WORK/emsdk}

if [ ! -x "$EMSDK_DIR/emsdk" ]; then git clone -q https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"; fi
(cd "$EMSDK_DIR" && ./emsdk install "$EMSDK_VERSION" >/dev/null && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
emcc --version | head -1

SRC=$WORK/stockfish.js
if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC" && git -C "$SRC" fetch -q --depth 1 "$SF_REPO" "$SF_COMMIT" && git -C "$SRC" checkout -q FETCH_HEAD
fi
git -C "$SRC" checkout -q "$SF_COMMIT" -- . && git -C "$SRC" clean -qfd src/emscripten
(cd "$SRC" && npm install --no-audit --no-fund --silent)

# the relaxed-SIMD switch (an environment variable that make only reads; appending to EM_CXXFLAGS from the
# environment would be exported to the recursive make and appended twice)
python3 - "$SRC/src/emscripten/wasm-makefile.mk" <<'EOF'
import sys
p = sys.argv[1]; s = open(p).read()
old = "else\n\tEM_CXXFLAGS += -msimd128\n"
new = old + ("\t# ChessVision 2.0.2: WebAssembly relaxed SIMD (RELAXED_SIMD=yes). Stockfish's NNUE then uses\n"
             "\t# wasm_i32x4_relaxed_dot_i8x16_i7x16_add (src/nnue/simd.h; deterministic: the activations are clipped to 0..127).\n"
             "\tifeq ($(RELAXED_SIMD),yes)\n\t\tEM_CXXFLAGS += -mrelaxed-simd\n\t\tEM_LDFLAGS  += -mrelaxed-simd\n\tendif\n")
if "RELAXED_SIMD" not in s:
    assert s.count(old) == 1, "wasm-makefile.mk changed upstream"
    open(p, "w").write(s.replace(old, new))
EOF

build() {   # $1 = output dir, $2 = RELAXED_SIMD value, $3 = single | threaded
  (cd "$SRC/src" && make clean >/dev/null 2>&1 || true)
  mkdir -p "$1"
  local flags="--lite --no-split"
  if [ "$3" = single ]; then flags="--lite --single-threaded --no-split"; fi
  # shellcheck disable=SC2086
  (cd "$SRC" && RELAXED_SIMD=$2 node build.js $flags --output-dir="$1" > "$1/build.log" 2>&1)
}
scan() {    # the relaxed dot instruction (0xfd 0x93 0x02) in a .wasm, by a byte scan
  node -e '
const b = require("fs").readFileSync(process.argv[1]); let n = 0;
for (let i = 0; i + 2 < b.length; i++) if (b[i] === 0xfd && b[i + 1] === 0x93 && b[i + 2] === 0x02) n++;
console.log("relaxed dot instructions (byte scan) in " + require("path").basename(process.argv[1]) + ": " + n);
if (process.argv[2] === "need" && !n) process.exit(1);' "$1" "${2:-}"
}

if [ "$ONLY" != threaded ]; then
  build "$WORK/out-plain" no single
  if cmp -s "$WORK/out-plain/stockfish-19-lite-single.wasm" "$ROOT/engine/stockfish-19-lite-single.wasm" &&
     cmp -s "$WORK/out-plain/stockfish-19-lite-single.js" "$ROOT/engine/stockfish-19-lite-single.js"; then
    echo "plain build reproduces engine/stockfish-19-lite-single.{js,wasm} byte for byte"
  else
    echo "WARNING: the plain build differs from engine/stockfish-19-lite-single.* (toolchain or source drift)" >&2
  fi

  build "$WORK/out-rsimd" yes single
  cp "$WORK/out-rsimd/stockfish-19-lite-single.js" "$OUT/stockfish-19-lite-single-rsimd.js"
  cp "$WORK/out-rsimd/stockfish-19-lite-single.wasm" "$OUT/stockfish-19-lite-single-rsimd.wasm"
  scan "$OUT/stockfish-19-lite-single-rsimd.wasm" need
  (cd "$OUT" && sha256sum stockfish-19-lite-single-rsimd.js stockfish-19-lite-single-rsimd.wasm && ls -l stockfish-19-lite-single-rsimd.*)
fi

if [ "$ONLY" != single ]; then
  # 2.0.6 (C): the threaded build. The plain one must be the npm stockfish 19.0.1 file pair shipped as engine/stockfish-19-lite.*
  build "$WORK/out-plain-mt" no threaded
  for f in stockfish-19-lite.js stockfish-19-lite.wasm; do
    if ! cmp -s "$WORK/out-plain-mt/$f" "$ROOT/engine/$f"; then
      echo "ERROR: the plain threaded build differs from engine/$f (toolchain or source drift); the relaxed threaded build is NOT made" >&2
      ls -l "$WORK/out-plain-mt/$f" "$ROOT/engine/$f" >&2 || true
      sha256sum "$WORK/out-plain-mt/$f" "$ROOT/engine/$f" >&2 || true
      cmp "$WORK/out-plain-mt/$f" "$ROOT/engine/$f" >&2 || true
      exit 1
    fi
  done
  echo "plain threaded build reproduces engine/stockfish-19-lite.{js,wasm} byte for byte"

  build "$WORK/out-rsimd-mt" yes threaded
  cp "$WORK/out-rsimd-mt/stockfish-19-lite.js" "$OUT/stockfish-19-lite-rsimd.js"
  cp "$WORK/out-rsimd-mt/stockfish-19-lite.wasm" "$OUT/stockfish-19-lite-rsimd.wasm"
  scan "$OUT/stockfish-19-lite-rsimd.wasm" need
  (cd "$OUT" && sha256sum stockfish-19-lite-rsimd.js stockfish-19-lite-rsimd.wasm && ls -l stockfish-19-lite-rsimd.*)
fi
