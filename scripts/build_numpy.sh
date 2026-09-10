#!/usr/bin/env bash
# Cross-compile numpy for wasm32-emscripten / CPython 3.13 → side modules.
#
# Why this exists: Blender's glTF addon (io_scene_gltf2) imports numpy at module
# scope, so without it `bpy.ops.export_scene.gltf` cannot run — which is the only
# thing libra asks of wasm Blender. No usable prebuilt wheel exists: Pyodide's is
# cp312 / emscripten 3.1.58, we are cp313 / emscripten 6.0.1.
#
# The extensions are built as SIDE_MODULEs (see cmake/emscripten-cross.ini) so
# CPython's dlopen can load them. That requires the Blender module to be linked
# with -sMAIN_MODULE, which in turn requires the whole sysroot to be -fPIC.
#
#   bash scripts/build_numpy.sh
set -euo pipefail
ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"
# The venv's bin comes first so meson finds `cython` — it treats Cython as a
# compiler for the host machine and looks it up on PATH, not in the cross file.
export PATH="$ROOT/.venv-numpy/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$ROOT/emsdk/upstream/emscripten:$PATH"

SYSROOT="$ROOT/wasm-sysroot"
VENV="$ROOT/.venv-numpy"
SRC="$ROOT/numpy-build/numpy-2.2.6"
OUT="${OUT:-$ROOT/numpy-build/dist}"
CROSS="$ROOT/cmake/emscripten-cross.ini"

[ -d "$SRC" ] || { echo "numpy source missing: $SRC"; exit 1; }
[ -x "$VENV/bin/python" ] || { echo "build venv missing: $VENV"; exit 1; }

# Point every Python introspection at the TARGET interpreter, not the host one.
# Without this meson-python configures against host CPython 3.14 and emits a
# wheel with the wrong ABI tag and the wrong headers.
export _PYTHON_SYSCONFIGDATA_NAME="_sysconfigdata__emscripten_wasm32-emscripten"
export PYTHONPATH="$SYSROOT/lib/python3.13"
export PKG_CONFIG_PATH="$SYSROOT/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig"

mkdir -p "$OUT"
cd "$SRC"

echo ">> cross-building numpy 2.2.6 for wasm32-emscripten (cp313)"
# allow-noblas: no BLAS/LAPACK in the wasm sysroot, and the glTF addon only uses
# array/dtype/reshape operations, none of which need an accelerated backend.
# disable-optimization: numpy's SIMD dispatch probes by running binaries, which
# is impossible when cross-compiling to wasm.
"$VENV/bin/python" -m pip wheel . \
  --no-build-isolation \
  --no-deps \
  -w "$OUT" \
  -Csetup-args="--cross-file=$CROSS" \
  -Csetup-args="-Dallow-noblas=true" \
  -Csetup-args="-Ddisable-optimization=true" \
  -Cbuild-dir="$ROOT/numpy-build/meson"

echo ">> built:"
ls -la "$OUT"/*.whl 2>/dev/null || echo "(no wheel produced)"
