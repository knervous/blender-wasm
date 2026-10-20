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
  `geometry` (mesh data) and `material`.

## A sync

1. **Out.** `diffToBlender(agreed, scene.read())` lists the scene's edits:
   new entities, deleted ones, and Blender-writable fields that differ (name,
   parent, transform, visible). Each update carries `previous`, the agreed value.
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

## Translators and adapters

The field logic comes in two layers. Both can be replaced per field:

- **`FieldTranslator`** (`translators.ts`), side-neutral. `equal` decides
  whether two values count as a change: the transform translator uses a
  tolerance and treats `q` and `−q` as the same rotation. `toBlender` and
  `toScene` can reshape a value on its way to either side.
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
    beforeRun(job) {},                    // last look at the Blender job (commands, script, handlers)
    afterRun(report) {},
    onConflict(conflict) {},
    afterApply(changes, direction) {},
  },
  translators: { transform: myTranslator },
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

- **Fields.** Blender has writers for name, parent, transform and visibility.
  A material assignment or material property edited on the scene side does
  not travel to Blender yet (it does the other way). Mesh edits made on the
  scene side travel only when an entity is created.
- **Conflicts** are decided per field: the winning side's whole transform
  replaces the other's.
- **Lights and cameras** move as entities. Their light and camera properties
  are not in the shared description yet.
- **Granularity.** Every sync is one Blender run, about 4 s in the browser,
  mostly startup. The project queues runs, and the demo's auto-sync debounces
  edits into one.
