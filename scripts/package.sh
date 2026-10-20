#!/usr/bin/env bash
# Package a linked (and optionally optimised) build into dist/.
#
#   bash scripts/package.sh node      # dist/blender-wasm-node/      + .tar
#   bash scripts/package.sh browser   # dist/blender-wasm-browser/   + .tar
#   bash scripts/package.sh web       # dist/blender-web.tar.gz (the demo site)
#
# node / browser packages are self-contained runtimes:
#   blender.js            emscripten glue (createBlenderModule factory), unmodified:
#                         pthread workers load this exact file
#   blender.wasm.br|.zst  the module (browser: .br, node: .zst)
#   blender.data.br|.zst  preloaded scripts, datafiles, CPython stdlib, numpy
#   manifest.json         sizes and sha256 (compressed and raw), and the exact
#                         sources it was built from
#   LICENSE               Blender is GPL-2.0-or-later; so is this package
# The browser one is the npm package @knervous/blender-wasm-runtime, a peer
# dependency of the API (@knervous/blender-wasm, packages/blender-wasm), which
# installs it where pages are served (`blender-wasm install`, or its Vite
# plugin). Binaries ship separately from the API, as ffmpeg.wasm's core does,
# so API releases do not republish them. Its version is the API's
# (BLENDER_WASM_VERSION overrides).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

FLAVOR="${1:-}"
case "$FLAVOR" in node|browser|web) ;; *) die "usage: package.sh node|browser|web" ;; esac

FORK_REV="$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo unknown)"
BLENDER_REV="$(git -C "$BLENDER_SRC" rev-parse HEAD 2>/dev/null || echo unknown)"
mkdir -p "$DIST"

if [ "$FLAVOR" = web ]; then
  [ -f "$ROOT/demo/public/blender.wasm.zst" ] || die "no release link in demo/public — run ./build.sh web first"
  ( cd "$ROOT/demo" && { [ -d node_modules ] || npm ci || npm install; } && npm run build )
  out="$DIST/blender-web-$FORK_REV.tar.gz"
  tar -C "$ROOT/demo" -czf "$out" dist
  log "packaged $out ($(du -h "$out" | cut -f1))"
  exit 0
fi

VERSION="${BLENDER_WASM_VERSION:-$(node -p "require('$ROOT/packages/blender-wasm/package.json').version")}"
SRC="$ROOT/$FLAVOR"
for f in blender.js blender.wasm blender.data; do
  [ -f "$SRC/$f" ] || die "missing $SRC/$f — run ./build.sh $FLAVOR first"
done

PKG="$DIST/blender-wasm-$FLAVOR"
rm -rf "$PKG"; mkdir -p "$PKG"
cp "$SRC/blender.js" "$PKG/"
cp "$SRC/blender.wasm" "$SRC/blender.data" "$PKG/"
if [ "$FLAVOR" = browser ]; then
  # Brotli only: browsers decode it natively (Content-Encoding: br) and Node's
  # zlib inflates it at install time.
  COMPRESS_ZSTD=0 bash "$ROOT/scripts/compress.sh" "$PKG/blender.wasm" "$PKG/blender.data"
else
  COMPRESS_BROTLI=0 bash "$ROOT/scripts/compress.sh" "$PKG/blender.wasm" "$PKG/blender.data"
fi
cp "$ROOT/LICENSE" "$PKG/LICENSE"

if [ "$FLAVOR" = browser ]; then
  NAME="@knervous/blender-wasm-runtime"; PRIVATE=false; PKG_VERSION="$VERSION"
  cat > "$PKG/README.md" <<MD
# @knervous/blender-wasm-runtime

Blender $(git -C "$BLENDER_SRC" describe --tags --always 2>/dev/null || echo 5.3) compiled to WebAssembly (pthreads, headless),
built from [knervous/blender-wasm](https://github.com/knervous/blender-wasm) at $FORK_REV.
Binaries only: install [@knervous/blender-wasm](https://www.npmjs.com/package/@knervous/blender-wasm),
which loads this runtime and puts it where your pages are served.

\`manifest.json\` lists every file's size and sha256, compressed and raw.
GPL-2.0-or-later, like Blender.
MD
else
  NAME="@knervous/blender-wasm-runtime-node"; PRIVATE=true; PKG_VERSION="$VERSION-$FORK_REV"
fi

# The glue is CommonJS and references its own filename when spawning pthread
# workers, so it cannot be renamed to .cjs; scope CommonJS to this directory.
cat > "$PKG/package.json" <<JSON
{
  "name": "$NAME",
  "version": "$PKG_VERSION",
  "private": $PRIVATE,
  "description": "Blender compiled to WebAssembly: the runtime binaries for @knervous/blender-wasm",
  "license": "GPL-2.0-or-later",
  "repository": { "type": "git", "url": "git+https://github.com/knervous/blender-wasm.git" },
  "type": "commonjs",
  "files": ["blender.js", "blender.wasm.*", "blender.data.*", "manifest.json", "LICENSE", "README.md"]
}
JSON

python3 - "$PKG" "$FLAVOR" "$FORK_REV" "$BLENDER_REV" "$EMSDK_VERSION" "${WASM_OPT_LEVEL:-none}" <<'PY'
import hashlib, json, os, sys
pkg, flavor, fork, blender, emsdk, opt = sys.argv[1:]
digest = lambda data: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
files, raw = {}, {}
for name in sorted(os.listdir(pkg)):
    path = os.path.join(pkg, name)
    if name in ("manifest.json", "package.json") or not os.path.isfile(path):
        continue
    data = open(path, "rb").read()
    if name in ("blender.wasm", "blender.data"):
        raw[name] = digest(data)
    else:
        files[name] = digest(data)
json.dump({
    "flavor": flavor,
    "forkRevision": fork,
    "blenderRevision": blender,
    "emsdk": emsdk,
    "wasmOpt": opt,
    "files": files,
    "raw": raw,
}, open(os.path.join(pkg, "manifest.json"), "w"), indent=2)
PY
rm -f "$PKG/blender.wasm" "$PKG/blender.data"

if [ "$FLAVOR" = browser ]; then
  ( cd "$PKG" && npm pack --silent --pack-destination "$DIST" >/dev/null )
  log "packaged $PKG and $DIST/knervous-blender-wasm-runtime-$VERSION.tgz ($(du -h "$DIST/knervous-blender-wasm-runtime-$VERSION.tgz" | cut -f1))"
else
  out="$DIST/blender-wasm-$FLAVOR-$FORK_REV.tar"
  tar -C "$DIST" -cf "$out" "blender-wasm-$FLAVOR"
  log "packaged $PKG and $out ($(du -h "$out" | cut -f1))"
fi
