# Blender ⇄ Babylon

A small Babylon.js editor with headless Blender on the other end. Open a
`.blend` (or anything Blender imports) and edit it in Babylon. Your moves and
deletions push back onto the Blender objects. You can also run `bpy` against
the scene, or load Babylon content and send the whole Babylon scene into
Blender.

```bash
npm install
npm run blender   # builds or reuses ../../dist/blender-wasm-{browser,node}
npm run dev       # http://localhost:5321
```

`npm run blender` reuses the packages in `../../dist/` when they exist and
otherwise runs `../../build.sh browser` and `../../build.sh node`. A first build
compiles Blender from source, which takes hours (see the top-level README).
`npm run blender:browser` and `npm run blender:node` each prepare one of them.

## Where Blender runs

The **Blender runs** selector lists the runtimes that are installed:

- **In this tab (WebAssembly worker).** This is the browser runtime. The page
  compiles `blender.wasm` and fetches the data package once. Each operation
  then runs in a fresh worker that gets the compiled module, because Blender's
  `main()` never returns and an instance is good for one run. The worker is
  terminated afterwards, along with its pthreads. This needs the page to be
  cross-origin isolated; the dev and preview servers send the COOP/COEP
  headers.
- **On the dev server (Node).** This is the Node runtime behind `/api/blender/run`,
  one process per run. Only `npm run dev` provides it. A static `vite build`
  has the browser runtime only.

Both backends answer the same call: a Python script against an optional
`.blend`, returning what it printed and every file it wrote under `/out`.

## How the two sides stay in step

The `.blend` the page holds is the source of truth for everything that came
from Blender. Every operation opens it, changes it, saves it again and exports a
GLB for Babylon to display (`src/session.js`).

| action | what happens |
|---|---|
| New Blender scene / Open | Blender's default scene, or the file. A `.blend` opens as-is; `.glb/.gltf/.obj/.fbx/.stl/.ply` are imported into an empty scene. |
| Move / rotate / scale, Delete | Babylon only, until you push. Moved nodes are marked in the outliner. |
| **Push transforms → Blender** | Changed transforms and deletions, matched by object name, are applied to the Blender objects. Modifiers, materials and everything else in the `.blend` stay intact. |
| **Run Python** | Any `bpy` script against the current scene. |
| Add box / sphere, opening `.babylon`/USD (or Shift+open a glTF) | Babylon-only content, shown as such in the outliner. |
| **Send Babylon scene → Blender** | The whole Babylon scene (minus the editor's camera, lights and grid) is exported to GLB and becomes the new Blender scene. This is lossy for Blender-only data. |

Transforms cross in glTF space. Babylon's glTF loader keeps each node's
authored right-handed TRS under a `__root__` that converts handedness. Blender's
exporter writes each `matrix_local` conjugated into Y-up. So the push applies
`M_blender = A⁻¹ · M_gltf · A`, with `A` mapping Blender's (x, y, z) to glTF's
(x, z, −y). Cameras and lights are not pushed, because the exporter adds an
orientation correction to them.

The GLB is exported with modifiers applied, so Babylon shows the evaluated
mesh. Blender's own lights come across in physical units (a 1000 W lamp is very
bright in Babylon), so they are off in the viewport unless you tick the box.

## Limits of this build

- No OpenSubdiv, so Subdivision Surface does nothing. Array, Bevel, Mirror and
  the other non-subdivision modifiers work.
- Each Blender operation takes a few seconds. Most of that is starting Blender,
  not the work itself.
- The console shows a `_multiprocessing` traceback on every run. That's an
  add-on import Blender reports and moves past.
