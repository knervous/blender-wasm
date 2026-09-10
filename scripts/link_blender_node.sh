#!/usr/bin/env bash
# Relink the Blender wasm module for NODE (headless, no GPU backend).
#
# Counterpart to link_blender_web.sh. That script takes CMake's node-targeted
# link line and converts it to a browser app; this one keeps the node settings
# and only fixes what makes CMake's own link fail:
#
#   * initial memory too small          -> ALLOW_MEMORY_GROWTH + INITIAL_MEMORY
#   * undefined wgpu_* symbols          -> ERROR_ON_UNDEFINED_SYMBOLS=0
#   * undefined wasmfs_* / malloc_stats -> same
#
# The undefined WebGPU symbols are referenced from wm.cc and
# gpu_select_sample_query.cc, which this fork calls unconditionally even with
# WITH_WEBGPU_BACKEND=OFF. Tolerating them is safe for our use: they are only
# reached from interactive draw/select paths, and --background never enters them.
# The same tolerance is what the upstream web link relies on.
#
# NODERAWFS is deliberately KEPT. Blender then sees the real filesystem, so
# there is no asset tar, no WasmFS provider and no --preload-file: it reads
# blender/scripts and the CPython stdlib straight from disk, and libra's glTF
# temp files work with no marshalling.
set -euo pipefail
ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"
export PATH="/opt/homebrew/opt/make/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/bin:/opt/homebrew/sbin:$ROOT/emsdk/upstream/emscripten:$PATH"
BUILD="$ROOT/build-blender"
SYSROOT="$ROOT/wasm-sysroot"
OUT="${OUT:-$ROOT/node}"
STAGE="$OUT/blender_assets"

mkdir -p "$OUT"

# --- stage runtime assets (same trim as the web build) ---------------------
echo ">> staging assets -> $STAGE"
rm -rf "$STAGE"; mkdir -p "$STAGE/5.3"
cp -r "$ROOT/blender/scripts"           "$STAGE/5.3/scripts"
cp -r "$ROOT/blender/release/datafiles"  "$STAGE/5.3/datafiles"
cp -r "$SYSROOT/lib/python3.13"          "$STAGE/python3.13"
( cd "$STAGE/python3.13" && rm -rf test tests idlelib lib2to3 turtledemo tkinter \
    config-3.13-wasm32-emscripten ensurepip \
    && find . -name '__pycache__' -type d -prune -exec rm -rf {} + )
rm -f "$STAGE/5.3/datafiles/splash_template.xcf"

# --- Cycles addon ----------------------------------------------------------
# Cycles is registered as a render engine by a Python addon, not by the C
# library. That addon lives in intern/cycles/blender/addon and is copied into
# the scripts tree by CMake's *install* step, which this staging skips — so a
# Cycles-enabled build still reports only EEVEE, and `_cycles` imports fine
# while bpy.context.scene.render.engine has no CYCLES option. Copy it in.
if [ -d "$ROOT/blender/intern/cycles/blender/addon" ]; then
  mkdir -p "$STAGE/5.3/scripts/addons_core/cycles"
  cp -r "$ROOT/blender/intern/cycles/blender/addon/." "$STAGE/5.3/scripts/addons_core/cycles/"
  echo ">>   staged cycles addon"
fi

# --- make ctypes-dependent glTF imports lazy (staged copy only) -------------
python3 "$ROOT/scripts/patch_gltf_ctypes.py" "$STAGE"

# --- numpy (cross-built side modules) into the preloaded stdlib -------------
# io_scene_gltf2 imports numpy at module scope, so glTF export is impossible
# without it. No usable prebuilt wheel exists (Pyodide's is cp312/emscripten
# 3.1.58; we are cp313/emscripten 6.0.1), so scripts/build_numpy.sh cross-builds
# it. The .so files are emscripten SIDE_MODULEs loaded through CPython's
# dlopen, which is why the module must be linked -sMAIN_MODULE.
NUMPY_WHL=$(ls "$ROOT/numpy-build/dist/"*.whl 2>/dev/null | head -1)
if [ -n "$NUMPY_WHL" ]; then
  echo ">> staging numpy from $(basename "$NUMPY_WHL")"
  rm -rf "$STAGE/python3.13/site-packages/numpy"
  mkdir -p "$STAGE/python3.13/site-packages"
  ( cd "$STAGE/python3.13/site-packages" && unzip -o -q "$NUMPY_WHL" -x '*.dist-info/RECORD' )
  echo ">>   numpy=$(du -shL "$STAGE/python3.13/site-packages/numpy" | cut -f1)"
else
  echo ">> WARNING: no numpy wheel in numpy-build/dist — glTF export will fail"
fi

echo ">>   scripts=$(du -shL "$STAGE/5.3/scripts"|cut -f1) datafiles=$(du -shL "$STAGE/5.3/datafiles"|cut -f1) py=$(du -sh "$STAGE/python3.13"|cut -f1)"

# --- reuse CMake's exact object/library link line so we never drift ---------
raw=$(ninja -C "$BUILD" -t commands blender | grep -- "-o bin/blender.js" | tail -1)
cmd=${raw#*&& }
cmd=${cmd%% && cd *}
cmd=${cmd/-o bin\/blender.js/-o $OUT/blender.js}

# MODULARIZE is required, not cosmetic. Without it the glue does
#   var Module = typeof Module != "undefined" ? Module : {};
# which under require() hoists a module-scoped `Module`, shadows any global one,
# and silently discards the caller's config — preRun never runs, so
# BLENDER_SYSTEM_RESOURCES is never set and Blender cannot find scripts/modules.
# (Arguments still appear to work because emscripten reads process.argv on node.)
#
# ASSERTIONS=0 is required alongside MAIN_MODULE, not just a size choice. With
# assertions on, the dynamic linker verifies every undefined symbol at module
# load and aborts. Blender's build legitimately leaves some undefined — the two
# wgpu_* entry points (this fork calls them even with the backend off) and
# CPython's bz2/sqlite3 modules, which have no backing library here. None are
# reachable in --background, so they only need to not be checked eagerly.
#
# MAIN_MODULE=1, not 2. =2 prunes exports to what it can prove is needed, which
# drops Python C-API *data* symbols the side modules require: numpy's
# _multiarray_umath then dlopens and immediately fails on 'PyExc_ValueError'.
# =1 exports everything, at the cost of dead-code elimination and size.
#
# MAIN_MODULE enables emscripten's dlopen, which is what CPython's dynload_shlib
# uses to load numpy's SIDE_MODULE extensions. It requires every input to be
# position-independent: Blender's own objects always were, but the sysroot deps
# and CPython had to be rebuilt with -fPIC (WASM_CFLAGS override for the dep
# stack, an explicit CFLAGS edit in build_python.sh) before this would link.
#
# INITIAL_MEMORY is 256MB, not the 1GB the web build uses. Every call
# instantiates a fresh module (main never returns, so one module = one run), and
# repeated 1GB instantiations exhaust node's heap: "CALL_AND_RETRY_LAST
# Allocation failed" inside WasmInstantiate. Headless has no editor working set,
# and ALLOW_MEMORY_GROWTH covers anything larger.
#
# PROXY_TO_PTHREAD runs main() on a worker so the JS main thread stays free to
# service emscripten's pthread messages. Without it a synchronous callMain()
# deadlocks immediately — it blocks the very thread the workers need. With
# auto-run on the main thread the work completes but the factory promise never
# settles, so neither variant lets the caller regain control.
#
# Consequence for callers: completion cannot be detected from a return value or
# promise. The bridge resolves when the sentinel payload appears in the captured
# output instead — the same framing the socket transport already uses.
#
# Node runtime flags. No PROXY_TO_PTHREAD: there is no UI thread to keep free,
# and proxying only adds a hop for a CLI process that runs to completion.
# Filesystem: preloaded, NOT NODERAWFS.
#
# NODERAWFS looks like the obvious choice for node (real files, no marshalling)
# and is what the upstream comment claims CMake emits — but it is absent from the
# generated link line, and adding it deadlocks the module at startup before any
# output: NODERAWFS replaces the FS with node's synchronous fs, which does not
# work across pthreads, and Blender is compiled -pthread throughout.
#
# So the assets are preloaded exactly as the (working) web build does. Files move
# in and out through the exported FS runtime method instead of the host disk.
# CPython bundles its own expat (pyexpat) and Blender links the standalone
# libexpat.a via OpenImageIO, so the two collide on xmlparse/xmltok symbols.
# --allow-multiple-definition takes the first and moves on. Deleting the bundled
# objects from libpython3.13.a also resolves the clash but leaves pyexpat.o with
# dangling PyExpat_XML_* references, which corrupts CPython's builtin module
# table — Blender then fails to register _bpy_types and `import bpy` dies.
# libfreetype.a is built with woff2 support, so it calls into brotli to
# decompress Blender's .woff2 UI fonts at startup. CMake's link line omits it
# (the GUI build preloads decompressed fonts), which surfaces only at runtime as
# "missing function: BrotliDecoderDecompress" once a font is actually loaded.
BROTLI_LIBS="$SYSROOT/lib/libbrotlidec.a $SYSROOT/lib/libbrotlicommon.a"

# --- stubs for unreachable undefined symbols --------------------------------
# Under MAIN_MODULE the dynamic loader resolves undefined symbols at load time
# and refuses to start the module. Blender's link legitimately leaves ~96
# undefined (CPython bz2/sqlite3 with no backing libs, the fork's two wgpu_*
# entry points, browser-only WasmFS backends). None are reachable in
# --background, so no-op definitions satisfy the loader without changing
# behaviour. Regenerated from the link's own warnings each time.
STUBS_C="$ROOT/numpy-build/undef_stubs.c"
STUBS_O="$ROOT/numpy-build/undef_stubs.o"
UNDEF_TXT="$ROOT/numpy-build/undef_symbols.txt"
if [ -s "$UNDEF_TXT" ]; then
  python3 "$ROOT/scripts/gen_undef_stubs.py" "$UNDEF_TXT" "$STUBS_C"
  "$ROOT/emsdk/upstream/emscripten/emcc" -fPIC -O1 -c "$STUBS_C" -o "$STUBS_O"
  STUB_OBJ="$STUBS_O"
else
  echo ">> no undef_symbols.txt yet — link once, then regenerate (see README)"
  STUB_OBJ=""
fi

NODE_FLAGS="-pthread \
  -Wl,--allow-multiple-definition \
  -sPROXY_TO_PTHREAD -sEXIT_RUNTIME=0 \
  -O1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=4294967296 \
  -sSTACK_SIZE=16777216 -sDEFAULT_PTHREAD_STACK_SIZE=4194304 \
  -sPTHREAD_POOL_SIZE=4 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap,ENV,HEAPU8 \
  -sENVIRONMENT=node -sASSERTIONS=1 -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sMODULARIZE=1 -sEXPORT_ES6=0 -sEXPORT_NAME=createBlenderModule \
  -sMAIN_MODULE=1 \
  --preload-file $STAGE/5.3@/5.3 \
  --preload-file $STAGE/python3.13@$SYSROOT/lib/python3.13"

echo ">> relinking blender -> $OUT/blender.js (node, headless)"
( cd "$BUILD" && eval "$cmd $BROTLI_LIBS $STUB_OBJ $NODE_FLAGS" )

ls -la "$OUT"/blender.js "$OUT"/blender.wasm 2>&1
echo ">> done"
