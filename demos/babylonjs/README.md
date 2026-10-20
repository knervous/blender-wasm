# Blender ⇄ Babylon

A small Babylon.js editor with Blender running in the same tab, compiled to
WebAssembly. Open a `.blend` (or anything Blender imports) and edit it in
Babylon: moves, deletions, new objects, material assignment and material
colour/metallic/roughness sync back onto the Blender objects. You can also
run `bpy` against the scene, adopt Babylon content into the project, or edit
in Blender's own UI.

```bash
npm install
npm run blender   # builds or reuses ../../dist/blender-wasm-browser
npm run dev       # http://localhost:5321
```

`npm run blender` reuses `../../dist/blender-wasm-browser/` when it exists and
otherwise runs `../../build.sh browser`. A first build compiles Blender from
source, which takes hours (see the top-level README). It installs the runtime
into `public/blender-runtime/`.

## How Blender runs

Blender is the headless browser runtime: the pthread build, linked for
`web,worker`. The page assumes cross-origin isolation (COOP `same-origin` +
COEP `require-corp`), because Blender's threads need `SharedArrayBuffer`. The
dev and preview servers send those headers, and any static host must send them
too.

Blender boots once, in one worker (`public/blender-session-worker.js`,
`createBlenderSession` in `src/blender.ts`), with the project protocol running
as a server. It stays alive for the page, keeping the scene in memory, so a sync
takes milliseconds plus its work. The `.blend` is written only when needed (the
Blender UI, downloads). Nothing runs on a server.

## How the two sides stay in step

The page and Blender share one project (`../../sdk/project`, design in
[`sdk/README.md`](../../sdk/README.md)). Every object has a stable id. A sync
sends only what Babylon changed since the last agreed state and applies only
what Blender changed. Mesh data crosses only for geometry whose fingerprint
moved; there is no whole-scene export or reload.
`src/babylon-side.ts` is Babylon's side: it builds nodes from the changes and
reads them back. Project entities live under a root identical to the one
Babylon's glTF loader builds, so a `.blend` looks the way its glTF export would.

| action | what crosses |
|---|---|
| New Blender scene / Open | The file becomes the project, and its objects arrive as creates. A `.blend` opens as-is; `.glb/.gltf/.obj/.fbx/.stl/.ply` are imported into an empty scene. |
| Move, rotate, scale, delete, Add box/sphere | Listed under **Sync** as pending changes, typed and per object. |
| Material panel (selected mesh) | Pick the material in slot 0, make a **New** one, or edit its colour, metallic and roughness. The material is shared by everything using it, and both the assignment and the properties are pending changes. |
| **Sync with Blender** | Just those changes go out (create with mesh data, delete, update one field). What comes back is only what Blender changed beyond them. *Auto-sync* sends them shortly after each edit. |
| **Run Python** | A sync, plus a `bpy` script; only what the script changed comes back. |
| Open `.babylon`/USD (or Shift+open a glTF/OBJ/STL) | Loaded into Babylon outside the project ("Babylon only"). **Adopt Babylon content** brings it in, keeping its placement; the next sync creates it in Blender. |
| **Open in Blender UI** → Save back | The edited `.blend` is adopted: pending Babylon edits are replayed onto it, and where both sides changed a field the conflict policy decides (Blender by default). The result is logged. |

The status line and log show each sync's traffic, for example
`sent ~ Cube.transform, + box_ee7f · received ~ box_ee7f mesh (36 verts)`.

## Limits of this build

- No OpenSubdiv, so Subdivision Surface does nothing. Array, Bevel, Mirror and
  the other non-subdivision modifiers work.
- Booting Blender takes a few seconds once per page; syncs after that take
  milliseconds (see `sdk/README.md`).
- Mesh edits made in Babylon travel only when an object is created; see the
  limits in `sdk/README.md`.
- `bench.html?mode=sdk|legacy` measures the sync against the previous
  whole-scene path; results are in `sdk/README.md`.
- The console shows a `_multiprocessing` traceback on every run. That's an
  add-on import Blender reports and moves past.
