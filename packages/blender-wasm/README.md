# @knervous/blender-wasm

Blender 5.3, compiled to WebAssembly, embedded in your page and kept in sync
with a Babylon.js or three.js scene. Blender boots once in a worker and stays
alive, so a sync takes milliseconds. The two sides exchange typed per-field
changes, never whole scenes, and mesh data crosses only where geometry
changed. Python 3.13, numpy, glTF and Cycles (CPU) are in the runtime.

```
npm install @knervous/blender-wasm @knervous/blender-wasm-runtime
```

The binaries are in `@knervous/blender-wasm-runtime` (33 MB, brotli), a peer
dependency, so npm 7+ installs them with this package. They ship apart from
the API, as ffmpeg.wasm keeps its core apart, so API releases don't republish
them. `three` or `@babylonjs/core` is your own, an optional peer the adapter
uses as found in your app.

## Entries

| import | what |
|---|---|
| `@knervous/blender-wasm` | `Project`, typed changes, translators, hooks, `MemoryScene`, the shared description's types |
| `@knervous/blender-wasm/browser` | `createBlenderSession` (persistent, with boot progress), `createBlenderRunner` (a run per call), `runtimeInstalled` |
| `@knervous/blender-wasm/three` | `ThreeSide`: project entities as `Object3D`s |
| `@knervous/blender-wasm/babylon` | `BabylonSide`: project entities as `TransformNode`s (deep imports, so tree-shaken) |
| `@knervous/blender-wasm/vite` | `blenderWasm()`: headers, the runtime served in dev and emitted on build |
| `@knervous/blender-wasm/runtime` | `installRuntime`, `resolveRuntimeDir` (Node, build tooling) |
| `@knervous/blender-wasm/node` | `createNodeSession`, `createNodeRunner`, `runPython` (Node runtime) |
| `blender-wasm` (bin) | `blender-wasm install <dir>`, `blender-wasm info` |

## With Vite

```js
// vite.config.js
import { blenderWasm } from "@knervous/blender-wasm/vite";
export default { plugins: [blenderWasm()] };
```

```ts
import { Scene } from "three";
import { Project } from "@knervous/blender-wasm";
import { createBlenderSession } from "@knervous/blender-wasm/browser";
import { ThreeSide } from "@knervous/blender-wasm/three";

const scene = new Scene();
const side = new ThreeSide(scene);                 // adds its project root to the scene
const session = createBlenderSession({
  onProgress: ({ fraction, detail }) => { bar.style.width = `${fraction * 100}%`; label.textContent = detail; },
});
const project = new Project({ session, scene: side });

await project.newScene();                          // Blender's startup scene arrives as creates
side.createPrimitive("sphere", { color: [0.8, 0.1, 0.1, 1] });
await project.sync();                              // only the new sphere goes out
await project.sync({ script: "import bpy\nbpy.ops.mesh.primitive_monkey_add()" });
const blend = await project.exportBlend();
```

Babylon.js is the same with `new BabylonSide(scene)` from `/babylon`.

The plugin:

- sends `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` from dev and preview;
- keeps both packages out of `optimizeDeps`;
- serves `blender-runtime/` in dev (brotli when the browser accepts it);
- writes the runtime into `outDir/blender-runtime/` on build.

## Without Vite

Copy the runtime to where your pages are served, then point the session at
it:

```
npx blender-wasm install public/blender-runtime
```

```ts
createBlenderSession({ runtimeUrl: "/blender-runtime/" }); // the default is "blender-runtime/" under the page's base
```

The directory holds `blender.js`, `blender.wasm`, `blender.data`, their `.br`
copies, the two workers and `manifest.json`. Every file is checked against the
runtime's sha256 manifest on install.

## Serving it

- **Cross-origin isolation is required.** Blender is a pthread build, so it
  needs `SharedArrayBuffer`, and there is no single-thread fallback. A page
  that isn't isolated gets a `NotIsolatedError`. Static hosts that can't set
  headers (GitHub Pages) need a COI service worker.
- **Compression.** Serve `blender.wasm` and `blender.data` with
  `Content-Encoding: br` from the `.br` copies (32 MB instead of 170 MB).
  `blender.wasm` must be `application/wasm` for streaming compilation.
  Progress uses the manifest's raw sizes, so it stays right when compressed.
- **Caching.** The files change only with the runtime version, so cache them
  long on a versioned path, or revalidate.
- **Loading model.** This is the static-directory model of pyodide's
  `indexURL` and onnxruntime's `wasmPaths`, not bundler imports. The workers
  and the emscripten glue load unmodified: Blender's pthreads re-load the
  glue, and a bundled copy breaks them. The page compiles `blender.wasm` while
  `blender.data` downloads, then hands both to the worker (`instantiateWasm`).
- **From a CDN.** `runtimeUrl` may point at another origin, which must send
  CORS and `Cross-Origin-Resource-Policy: cross-origin`. Workers must be
  same-origin, so they start from a blob that imports the real script. This
  is the workaround emscripten's maintainers gave for pthreads in
  emscripten#21937.

## Node

The Node runtime is a separate build (`./build.sh node`), not published yet:

```ts
import { MemoryScene, Project } from "@knervous/blender-wasm";
import { createNodeSession } from "@knervous/blender-wasm/node";

const session = await createNodeSession({ runtimeDir: "dist/blender-wasm-node" });
const project = new Project({ session, scene: new MemoryScene() });
await project.newScene();
await project.sync({ script: "import bpy\nbpy.ops.mesh.primitive_monkey_add()" });
process.exit(0); // Blender's threads keep the process alive
```

## Design

`DESIGN.md` covers the sync model (identity, the shared description, typed
changes, conflicts), translators, adapters and hooks, the persistent session,
boot, and the measurements against the previous whole-scene approach.

## License

GPL-2.0-or-later, like Blender. Files produced *by* Blender, such as `.glb` and
`.blend`, are not covered.
