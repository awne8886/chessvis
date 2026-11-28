#!/usr/bin/env bash
# 2.0.4 (F1): builds the extension zip from the runtime files only (no engine sources, docs, tests, tools or notes).
#
#   tools/package.sh [--lean] [--out DIR]
#
# Default package: manifest.json, every script the manifest lists (background + content scripts), the popup
# (popup.html and the scripts it loads), engine/ (all of it, NOTICE.txt included), LICENSE and allowed-pages.txt.
# --lean also leaves out engine/stockfish-19-asm.js (the asm.js fallback: Firefox always has WebAssembly). The file stays in
# the repository, so the default package keeps the 2.0.2 fallback rules. 2.0.6: --lean KEEPS both threaded builds
# (engine/stockfish-19-lite.js/.wasm and engine/stockfish-19-lite-rsimd.js/.wasm): release Firefox has no SharedArrayBuffer
# in extension pages, but Firefox Nightly with dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled runs them
# (owner-verified on Android with 2.0.5). The script list comes from the manifest, so ponderstats.js (2.0.6, the temporary
# ponder-stats recorder) is packaged while the manifest lists it.
#
# allowed-pages.txt is put in the zip by its path; this script never reads or prints it. After zipping, the zip is
# unpacked into a temporary directory and checked: every path the manifest lists, the popup's scripts and every engine
# file background.js names (SF_*, AGGRO_* and the worker files, with each loader's .wasm) must be there (in lean mode
# except the one left out). Prints the zip size. Needs zip, unzip and node.
set -euo pipefail
cd "$(dirname "$0")/.."
LEAN=0
OUT=dist
while [ $# -gt 0 ]; do
  case "$1" in
    --lean) LEAN=1 ;;
    --out) OUT="$2"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
for t in zip unzip node; do command -v "$t" >/dev/null || { echo "needs $t" >&2; exit 2; }; done

VERSION=$(node -p "require('./manifest.json').version")
SUFFIX=""
if [ "$LEAN" = 1 ]; then SUFFIX="-lean"; fi
NAME="chessvision-$VERSION$SUFFIX.zip"
LEAN_SKIP=(engine/stockfish-19-asm.js)

# the files: from the manifest and popup.html (paths only), engine/, LICENSE, allowed-pages.txt
mapfile -t FILES < <(node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  const out = new Set(["manifest.json", "LICENSE", "allowed-pages.txt"]);
  for (const f of (m.background && m.background.scripts) || []) out.add(f);
  for (const cs of m.content_scripts || []) for (const f of (cs.js || []).concat(cs.css || [])) out.add(f);
  const popup = m.browser_action && m.browser_action.default_popup;
  if (popup) {
    out.add(popup);
    for (const x of fs.readFileSync(popup, "utf8").matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) out.add(x[1]);
  }
  for (const f of fs.readdirSync("engine")) out.add("engine/" + f);
  console.log([...out].sort().join("\n"));
')
KEEP=()
for f in "${FILES[@]}"; do
  skip=0
  if [ "$LEAN" = 1 ]; then for s in "${LEAN_SKIP[@]}"; do [ "$f" = "$s" ] && skip=1; done; fi
  [ "$skip" = 1 ] && continue
  [ -e "$f" ] || { echo "missing in the repository: $f" >&2; exit 1; }
  KEEP+=("$f")
done

mkdir -p "$OUT"
rm -f "$OUT/$NAME"
zip -q -X -9 "$OUT/$NAME" "${KEEP[@]}"

# check the zip: unpack and look for everything the extension loads
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
unzip -q "$OUT/$NAME" -d "$TMP"
node -e '
  const fs = require("fs"), path = require("path");
  const [dir, lean] = [process.argv[1], process.argv[2] === "1"];
  const skip = new Set(process.argv.slice(3));
  const need = new Set(["manifest.json", "LICENSE", "allowed-pages.txt", "engine/NOTICE.txt"]);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  for (const f of (m.background && m.background.scripts) || []) need.add(f);
  for (const cs of m.content_scripts || []) for (const f of cs.js || []) need.add(f);
  const popup = m.browser_action && m.browser_action.default_popup;
  if (popup) { need.add(popup); for (const x of fs.readFileSync(path.join(dir, popup), "utf8").matchAll(/<script[^>]+src="([^"]+)"/g)) need.add(x[1]); }
  // every engine file background.js names; a Stockfish loader (stockfish-*.js, not asm.js) needs its .wasm next to it
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
  for (const x of bg.matchAll(/^const (?:SF|AGGRO)_[A-Z_]+ = \x27([^\x27]+\.(?:js|wasm))\x27/gm)) {
    const f = x[1].startsWith("engine/") ? x[1] : "engine/" + x[1];
    need.add(f);
    if (/^engine\/stockfish-.*\.js$/.test(f) && !/asm/.test(f)) need.add(f.replace(/\.js$/, ".wasm"));
  }
  const missing = [...need].filter((f) => !(lean && skip.has(f)) && !fs.existsSync(path.join(dir, f)));
  const extra = lean ? [...skip].filter((f) => fs.existsSync(path.join(dir, f))) : [];
  if (missing.length || extra.length) { console.error("zip check FAILED; missing: " + missing.join(", ") + (extra.length ? "; should be left out: " + extra.join(", ") : "")); process.exit(1); }
  console.log("zip check: " + [...need].filter((f) => !(lean && skip.has(f))).length + " required files present" + (lean ? " (lean: " + skip.size + " left out)" : ""));
' "$TMP" "$LEAN" "${LEAN_SKIP[@]}"
BYTES=$(wc -c < "$OUT/$NAME")
echo "$OUT/$NAME: ${#KEEP[@]} files, $BYTES bytes ($(awk -v b="$BYTES" 'BEGIN { printf "%.2f MB", b / 1048576 }'))"
