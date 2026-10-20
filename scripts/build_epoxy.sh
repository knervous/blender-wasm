#!/usr/bin/env bash
# libepoxy 1.5.10 → wasm-sysroot (GL function loading for Blender's OpenGL
# backend, which runs on Mesa-on-WebGPU "wink").
#
# There is no dlopen()able libGL, no GLX and no EGL in the browser: wink exports
# no gl* symbols at all and hands out every entry point through
# wink_get_proc_address(). So every epoxy resolver (core dlsym, GLX/EGL
# GetProcAddress, GLES dlsym, bootstrap) is routed to wink_get_proc_address
# under __EMSCRIPTEN__; the generated dispatch tables are stock.
set -euo pipefail
source "$(dirname "$0")/dep_common.sh"
src=$(fetch_extract \
  "https://github.com/anholt/libepoxy/archive/refs/tags/1.5.10.tar.gz" \
  "libepoxy-1.5.10.tar.gz" "libepoxy-1.5.10")

b="$BLD/epoxy"
rm -rf "$b"; mkdir -p "$b/epoxy"

# --- route every resolver to wink -------------------------------------------
python3 - "$src/src/dispatch_common.c" "$b/dispatch_common.c" <<'EOF'
import re, sys
s = open(sys.argv[1]).read()
hook = '''
#ifdef __EMSCRIPTEN__
    return wink_get_proc_address(name);
#endif
'''
funcs = ['epoxy_gl_dlsym', 'epoxy_gles1_dlsym', 'epoxy_gles2_dlsym', 'epoxy_gles3_dlsym',
         'epoxy_get_core_proc_address', 'epoxy_get_bootstrap_proc_address',
         'epoxy_get_proc_address']
for f in funcs:
    pat = re.compile(r'(\n(?:void \*|void\s*\*)\n' + f + r'\([^)]*\)\n\{\n)')
    s, n = pat.subn(lambda m: m.group(1) + hook, s)
    assert n == 1, f
s = s.replace('#include "dispatch_common.h"',
              '#include "dispatch_common.h"\n#ifdef __EMSCRIPTEN__\n'
              'extern void *wink_get_proc_address(const char *name);\n#endif', 1)
open(sys.argv[2], 'w').write(s)
EOF

# --- config + generated dispatch ---------------------------------------------
cat > "$b/config.h" <<'EOF'
#define PACKAGE_NAME "libepoxy"
#define PACKAGE_VERSION "1.5.10"
#define HAVE_KHRPLATFORM_H 0
#define ENABLE_GLX 0
#define ENABLE_EGL 0
#define ENABLE_X11 0
#define EPOXY_PUBLIC __attribute__((visibility("default"))) extern
EOF
python3 "$src/src/gen_dispatch.py" --source --no-header --outputdir="$b" "$src/registry/gl.xml"
python3 "$src/src/gen_dispatch.py" --header --no-source --outputdir="$b/epoxy" "$src/registry/gl.xml"
cp "$src/include/epoxy/common.h" "$src/include/epoxy/gl.h" "$b/epoxy/"

CF="$WASM_CFLAGS -I$b -I$src/include -I$src/src -D_GNU_SOURCE"
emcc $CF -c "$b/dispatch_common.c" -o "$b/dispatch_common.o"
emcc $CF -c "$b/gl_generated_dispatch.c" -o "$b/gl_generated_dispatch.o"
rm -f "$SYSROOT/lib/libepoxy.a"
emar rcs "$SYSROOT/lib/libepoxy.a" "$b/dispatch_common.o" "$b/gl_generated_dispatch.o"
mkdir -p "$SYSROOT/include/epoxy"
cp "$b/epoxy/"*.h "$SYSROOT/include/epoxy/"
log "installed epoxy into $SYSROOT"
