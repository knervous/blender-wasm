#!/usr/bin/env bash
# wink (Mesa's OpenGL / GL ES / Vulkan on WebGPU, MercuryWorkshop/mesa-wink) →
# wasm-sysroot/wink: the GL driver Blender's OpenGL backend runs on in the
# browser.
#
# Built with mesa-wink's own wink/build.sh (Tint, emdawnwebgpu and Mesa for
# wasm), threaded variant only, on OUR emsdk and with OUR exception ABI:
# Blender and its deps use JS exceptions + JS setjmp/longjmp (-fexceptions, see
# dep_common.sh), while upstream wink targets .NET's wasm-EH. The patch in
# scripts/patches/mesa-wink-blender.patch switches the cross file to
# -sSUPPORT_LONGJMP=emscripten and relaxes the ABI checks accordingly. (Mesa's
# C++ is built without exceptions, which links into either ABI.)
#
# Blender uses wink's WINK_INIT_GL_ON_MAIN_THREAD mode: the driver runs on the
# browser main thread, Blender's pthreads marshal GL to it through glthread,
# so no JSPI is ever needed on Blender's side.
#
#   WINK_SRC=<dir>   reuse an existing mesa-wink checkout (default deps/src/mesa-wink)
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"

WINK_REPO=https://github.com/MercuryWorkshop/mesa-wink
WINK_REF=4be662262bdd1afb2404ee279801067da36ad7da
WINK_SRC="${WINK_SRC:-$SRC/mesa-wink}"
PATCH="$ROOT/scripts/patches/mesa-wink-blender.patch"

if [ ! -d "$WINK_SRC/.git" ]; then
  log "cloning mesa-wink @ $WINK_REF"
  git init -q "$WINK_SRC"
  git -C "$WINK_SRC" fetch -q --depth 1 "$WINK_REPO" "$WINK_REF"
  git -C "$WINK_SRC" checkout -q --detach FETCH_HEAD
fi
if git -C "$WINK_SRC" apply --check "$PATCH" 2>/dev/null; then
  log "applying $(basename "$PATCH")"
  git -C "$WINK_SRC" apply "$PATCH"
elif git -C "$WINK_SRC" apply --reverse --check "$PATCH" 2>/dev/null; then
  log "$(basename "$PATCH") already applied"
else
  log "ERROR: $(basename "$PATCH") does not apply to $WINK_SRC"; exit 1
fi

WINK_ALLOW_ANY_EMSDK=1 bash "$WINK_SRC/wink/build.sh" --variant=mt --emsdk="$EMSDK" \
  --jobs="$NPROC" --cache="$DEPS/wink-cache"

OUT="$WINK_SRC/build/wink/out/mt"
rm -rf "$SYSROOT/wink"
mkdir -p "$SYSROOT/wink"
cp -r "$OUT/lib" "$OUT/js" "$OUT/include" "$OUT/manifest.json" "$SYSROOT/wink/"
log "installed wink into $SYSROOT/wink"
