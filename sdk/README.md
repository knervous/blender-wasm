# Project sync: Blender and a scene engine as one working project

`sdk/project` holds a project with Blender on one side and an engine scene on
the other, such as Babylon, three.js or anything that implements `SceneSide`.
The two sides stay in step by exchanging typed changes, never whole scenes.
`demos/babylonjs` is the reference integration.

```
          scene edits                         Blender results
 SceneSide ──read──▶ diffToBlender ──▶ commands ──▶ protocol.py ──▶ report ──▶ diffToScene ──apply──▶ SceneSide
                         ▲                                                          │
                         └──────────── agreed snapshot (last matched state) ◀──────┘
```

## Model

- **Identity.** Every object has a stable `id` that survives renames. Blender
  stores it as the custom property `bw_id`; a scene side keeps it on its node.
  Objects created on either side get one on their first trip.
- **Shared description** (`types.ts`). Each `EntityState` holds `name`, `kind`,
  `parent`, `transform` (t/r/s), `visible` and `materials`, plus Blender's
  `geometry` fingerprint. Everything is in glTF space: Y up, right-handed,
  quaternions as `[x, y, z, w]`. `protocol.py` is the only place Blender's Z-up
  is converted; a scene side converts its own conventions in its adapters.
- **Truth and agreement.** The `.blend` is the persistent truth. `agreed` is
  the last snapshot both sides matched.
- **Changes** are typed records: `create`, `delete`, `update` (one field),
  `geometry` (mesh data) and `material` (one material's properties, by name).

## A sync

1. **Out.** `diffToBlender` lists the scene's edits: properties of the
   materials its entities use that differ, then new entities, deleted ones, and
   fields that differ (name, parent, transform, visible, materials). Each
   update and material change carries `previous`, the agreed value. Material
   commands run first, so a create or slot assignment in the same run can name
   a material created by it.
2. **Blender.** One run of `protocol.py` opens the session `.blend` and applies
   the commands, then runs an optional `bpy` script. It reports the whole
   scene in the shared description. Before writing a field, Blender checks
   that its current value still equals `previous`. If not, both sides changed
   it: a **conflict**, resolved by `conflictPolicy` (Blender wins by default).
3. **Mesh data only where it changed.** Blender fingerprints each evaluated
   mesh, with values quantized so that modifier evaluation noise doesn't count
   as a change. It writes mesh data (positions, normals and UVs, unindexed and
   grouped by material slot, in glTF space) only where the fingerprint differs
   from what the scene already shows.
4. **In.** `diffToScene(scene.read(), report)` compares Blender's report with
   what the scene holds *now*. Edits Blender accepted produce nothing, so only
   Blender's own work comes back: script results, UI edits, normalization
   such as a renamed duplicate, and conflicts Blender won.
5. The report becomes the new `agreed` state, and its `.blend` the new session.

Opening a file, starting a new scene, and adopting a `.blend` saved from
Blender's UI are all the same run (`open`, `newScene`, `adoptBlend`). The
first two discard the scene's pending edits. `adoptBlend` replays them onto
the outside file under the conflict policy.

Measured in the Babylon demo, with Blender as browser wasm in the tab, at about
4 s per run (mostly Blender startup):

| action | sent | received |
|---|---|---|
| new scene | 0 | 1 material + 3 creates (one mesh) |
| Python adds Suzanne | 0 | 1 material + 1 create |
| move cube, add box and sphere, delete light | 4 | 2 meshes (Blender's versions of the new ones) |
| Python bevels the cube | 0 | 1 mesh |
| sync with nothing changed | 0 | 0 |

## Against the previous whole-scene path

`demos/babylonjs/bench.html` runs one scenario both ways on the same in-tab
Blender: `?mode=sdk`, and `?mode=legacy`, which re-implements the demo's
previous path (each operation exports the whole scene as GLB, and Babylon
disposes everything and reloads it). Each mode gets its own fresh page load. The
scene has 36 objects (beveled cubes, 48×24 spheres and monkeys) and 4 materials.
Measured on 2026-10-20, means of two rounds:

| operation | Blender ms (legacy → sdk) | page ms | out of Blender | geometries rebuilt |
|---|---|---|---|---|
| move 1 object | 5440 → 5620 | 18 → 3 | 3.5 MB → 254 KB | 37 → 0 |
| bevel 1 object | 5700 → 5770 | 15 → 5 | 4.2 MB → 0.7–1.7 MB (that mesh only) | 37 → 0 |
| recolour 1 material | 5490 → 5790 | 14 → 3 | 4.2 MB → 254 KB | 37 → 0 |
| idle sync / reload | 5780 → 5510 | 15 → 2 | 4.2 MB → 254 KB | 37 → 0 |

- **Blender time doesn't change.** Each run is dominated by starting Blender
  and loading and saving the `.blend`, about 5.5 s either way. The SDK's
  per-mesh fingerprinting costs about what the legacy whole-scene GLB export
  did. Within that noise, the SDK is not faster per operation.
- **What changes is what crosses and what the page rebuilds.** The legacy
  path ships the whole scene every time (3–4 MB here, growing with the scene)
  and rebuilds all 37 geometries and their materials. The SDK ships the
  session `.blend` plus only changed meshes, and rebuilds nothing.
  Page-side time drops from 12–21 ms to 2–6 ms at this scene size.
- **JS heap** (`performance.memory`, no forced GC). The legacy path climbs
  290.8 → 296.3 MB over eight operations, recreating 296 geometries. The SDK
  stays at 291–295 MB and recreates none. `measureUserAgentSpecificMemory`
  is refused in the demo's embedded browser, so whole-page and GPU memory are
  not measured.
- **First load costs more in the SDK.** Its mesh data is unindexed float32
  (4.2 MB for the setup, against a 3.1 MB GLB), and the setup row ran two
  Blender runs in SDK mode (new scene, then script) against one, so its total
  is not comparable.

Two ways to cut the remaining cost are fingerprinting only the objects the
run touched, and indexed mesh data for creates.

## Translators and adapters

The field logic comes in two layers. Both can be replaced per field:

- **`FieldTranslator`** (`translators.ts`), side-neutral. `equal` decides
  whether two values count as a change: the transform translator uses a
  tolerance and treats `q` and `−q` as the same rotation. `toBlender` and
  `toScene` can reshape a value on its way to either side. Material
  *assignment* is the `materials` field and goes through this translator.
- **`MaterialTranslator`**, the same contract for a material's *properties*
  (linear base colour, metallic, roughness; the default compares with a
  tolerance). Replace it with `ProjectPlugin.materialTranslator`.
- **Scene field adapters** (for example `FieldAdapter` in the demo's
  `babylon-side.ts`) read and write a field on a node, converting the engine's
  conventions to the shared description.

On the Blender side, each field has a Python reader and writer in
`protocol.py`. New commands come from plugins (see below).

## Hooks and plugins

```ts
project.use({
  name: "my-plugin",
  hooks: {
    filterChange(change, direction) {},   // replace, drop (null) or keep a change, each way
    conflictPolicy(id, field) {},         // "blender" | "scene" when both changed a field
                                          // (field "material": id is the material name)
    beforeRun(job) {},                    // last look at the Blender job (commands, script, handlers)
    afterRun(report) {},
    onConflict(conflict) {},
    afterApply(changes, direction) {},
  },
  translators: { transform: myTranslator },
  materialTranslator: myMaterialTranslator,
  blenderHandlers: { bake_ao: "def handle(cmd, by_id, api): ..." },
});
```

Hooks run in this order around a sync:

`pending → filterChange(toBlender) → conflictPolicy → beforeRun → Blender →
afterRun → onConflict → filterChange(toScene) → scene.apply → afterApply`.

A `blenderHandlers` entry adds a Blender-side command. Its Python source
defines `handle(cmd, by_id, api)`, and any command `{ op: "<name>", ... }`
(from `SyncOptions.commands` or a `beforeRun` hook) is routed to it. `api`
exposes `read_entity`, `write_transform`, `log` and the axis matrices.

## Writing a scene side

Implement `SceneSide`:

- `read()` and `readMaterials()`: the tracked entities and materials in the
  shared description.
- `meshData(id)` and `materialsOf(id)`: what an entity the scene created
  needs for its first trip to Blender.
- `apply(changes)`: create, update, delete, replace geometry, upsert
  materials. Handle parents after all creates, since a report's order is
  not meaningful.

Untracked content, such as files loaded straight into the engine, is the
scene's business until it adopts it into the project.

## Limits of this slice

- **Fields.** Blender has writers for name, parent, transform, visibility,
  material assignment and material properties (base colour, metallic,
  roughness of the Principled BSDF). Mesh edits made on the scene side travel
  only when an entity is created.
- **Conflicts** are decided per field: the winning side's whole transform
  replaces the other's.
- **Lights and cameras** move as entities. Their light and camera properties
  are not in the shared description yet.
- **Granularity.** Every sync is one Blender run, about 4 s in the browser,
  mostly startup. The project queues runs, and the demo's auto-sync debounces
  edits into one.
