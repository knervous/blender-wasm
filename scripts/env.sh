#!/usr/bin/env bash
# Shared host environment for every build script. Source it; do not run it.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
#
# Everything here is derived from the checkout location and the host, never
# from a particular machine. Every value can be overridden from the caller's
# environment (ROOT, EMSDK, SYSROOT, PYTHON, NPROC, DEVELOPER_DIR, ...).

if [ -n "${BLENDER_WASM_ENV_LOADED:-}" ]; then return 0 2>/dev/null || exit 0; fi
BLENDER_WASM_ENV_LOADED=1

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The emsdk is pinned in-repo. A stale EMSDK exported by the user's shell must
# not redirect the build to some other toolchain, so only BLENDER_WASM_EMSDK
# overrides it.
EMSDK_VERSION="${EMSDK_VERSION:-6.0.1}"
EMSDK="${BLENDER_WASM_EMSDK:-$ROOT/emsdk}"
EM_BIN="$EMSDK/upstream/emscripten"
BINARYEN_BIN="$EMSDK/upstream/bin"

SYSROOT="${SYSROOT:-$ROOT/wasm-sysroot}"
DEPS="${DEPS:-$ROOT/deps}"
# The Makefile clones Blender into blender/; scripts read it from here.
BLENDER_SRC="$ROOT/blender"
BLENDER_BUILD="${BLENDER_BUILD:-$ROOT/build-blender}"
DIST="${DIST:-$ROOT/dist}"

HOST_OS="$(uname -s)"

if [ -z "${NPROC:-}" ]; then
  NPROC="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
fi

# --- macOS host ------------------------------------------------------------
# The dependency builds assume GNU make/sed/find/coreutils (stat -c, sed -i,
# find -printf ...). On macOS they come from Homebrew and are put ahead of the
# BSD tools. Linux hosts already have them.
GNU_PATH=""
if [ "$HOST_OS" = "Darwin" ]; then
  # A Mac can carry both an Apple-silicon (/opt/homebrew) and an Intel
  # (/usr/local) Homebrew, with the GNU tools split across them, so look for
  # each tool in every prefix rather than trusting `brew --prefix`.
  BREW_PREFIXES=""
  for candidate in ${BREW_PREFIX:-} /opt/homebrew /usr/local; do
    case " $BREW_PREFIXES " in *" $candidate "*) ;; *) [ -d "$candidate/bin" ] && BREW_PREFIXES="$BREW_PREFIXES $candidate" ;; esac
  done
  for tool in make gnu-sed findutils coreutils gnu-tar; do
    for prefix in $BREW_PREFIXES; do
      if [ -d "$prefix/opt/$tool/libexec/gnubin" ]; then
        GNU_PATH="$GNU_PATH:$prefix/opt/$tool/libexec/gnubin"
        break
      fi
    done
  done
  for prefix in $BREW_PREFIXES; do GNU_PATH="$GNU_PATH:$prefix/bin:$prefix/sbin"; done
  # A broken Xcode selection leaves /usr/bin/clang++ unusable while the
  # Command Line Tools still work. Fall back to them only when needed.
  if [ -z "${DEVELOPER_DIR:-}" ] && ! xcrun -f clang++ >/dev/null 2>&1 \
      && [ -d /Library/Developer/CommandLineTools ]; then
    export DEVELOPER_DIR=/Library/Developer/CommandLineTools
  fi
fi

export PATH="${GNU_PATH#:}${GNU_PATH:+:}$EM_BIN:$PATH"

export PYTHON="${PYTHON:-$(command -v python3)}"
export ROOT EMSDK EMSDK_VERSION EM_BIN BINARYEN_BIN SYSROOT DEPS BLENDER_SRC BLENDER_BUILD DIST NPROC HOST_OS

# Blender's data-file version directory (scripts/, datafiles/ live under it).
BLENDER_VERSION_DIR="${BLENDER_VERSION_DIR:-5.3}"
export BLENDER_VERSION_DIR

log() { echo ">> [$(basename "${0%.sh}")] $*" >&2; }
die() { echo "!! [$(basename "${0%.sh}")] $*" >&2; exit 1; }
