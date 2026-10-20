# CMake initial-cache for the full Blender → WASM build on the OpenGL backend,
# running on wink (Mesa's GL on WebGPU, github.com/MercuryWorkshop/mesa-wink)
# instead of the custom WebGPU GPU backend. Passed via `cmake -C`.
#
# Same feature set as blender-wasm-cache.cmake, plus Cycles (CPU): the GL
# backend can use GPU contexts from any pthread (wink runs the driver on the
# browser main thread and marshals GL from workers), which is what Cycles'
# viewport display and threaded render jobs need.

include(${CMAKE_CURRENT_LIST_DIR}/blender-wasm-cache.cmake)

set(WITH_WEBGPU_BACKEND      OFF CACHE BOOL "" FORCE)
set(WITH_OPENGL_BACKEND      ON  CACHE BOOL "" FORCE)
set(WITH_VULKAN_BACKEND      OFF CACHE BOOL "" FORCE)

# wink + libepoxy (scripts/build_wink.sh, scripts/build_epoxy.sh).
set(WINK_ROOT        "${CMAKE_CURRENT_LIST_DIR}/../wasm-sysroot/wink" CACHE PATH "")
set(WINK_INCLUDE_DIR "${WINK_ROOT}/include" CACHE PATH "")
set(EPOXY_ROOT_DIR   "${CMAKE_CURRENT_LIST_DIR}/../wasm-sysroot" CACHE PATH "")

# --- Cycles (CPU only), same knobs as the standalone cycles-wasm build ------
set(WITH_CYCLES               ON  CACHE BOOL "" FORCE)
set(WITH_CYCLES_DEVICE_CUDA   OFF CACHE BOOL "")
set(WITH_CYCLES_DEVICE_OPTIX  OFF CACHE BOOL "")
set(WITH_CYCLES_DEVICE_HIP    OFF CACHE BOOL "")
set(WITH_CYCLES_DEVICE_ONEAPI OFF CACHE BOOL "")
set(WITH_CYCLES_DEVICE_METAL  OFF CACHE BOOL "")
set(WITH_CYCLES_CUDA_BINARIES OFF CACHE BOOL "")
set(WITH_CYCLES_HIP_BINARIES  OFF CACHE BOOL "")
set(WITH_CYCLES_EMBREE        OFF CACHE BOOL "")
set(WITH_CYCLES_OSL           OFF CACHE BOOL "")
set(WITH_CYCLES_PATH_GUIDING  OFF CACHE BOOL "")
set(WITH_CYCLES_LOGGING       OFF CACHE BOOL "")
set(WITH_CYCLES_DEBUG         OFF CACHE BOOL "")
set(WITH_NANOVDB              OFF CACHE BOOL "")
set(WITH_PUGIXML              ON  CACHE BOOL "")
