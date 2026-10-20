/* The Blender side of the editor. The authoritative scene is a .blend held by
 * the page; every operation opens it in headless Blender, changes it, and
 * returns the new .blend plus a GLB of it for Babylon to show:
 *
 *   newScene()            Blender's default scene
 *   open(file)            .blend opened as-is; .glb/.gltf/.obj/.fbx/.stl/.ply imported into an empty scene
 *   pushTransforms(map, deleted)  Babylon's node transforms (and deletions) written back onto the Blender objects
 *   replaceWithGlb(glb)   the whole Babylon scene, exported, becomes the Blender scene
 *   runPython(code)       any bpy script against the current scene
 */

/* Saves the session and exports what Babylon will display. Runs after every
 * operation, so the .blend and the GLB always describe the same scene. */
const EPILOGUE = `
import bpy as _bpy, json as _json
_bpy.ops.wm.save_as_mainfile(filepath="/out/session.blend", check_existing=False)
_bpy.ops.export_scene.gltf(
    filepath="/out/scene.glb", export_format="GLB",
    export_cameras=True, export_lights=True, export_extras=True, export_yup=True,
    # Babylon shows the evaluated mesh; the .blend keeps the modifiers.
    export_apply=True)
_json.dump({
    "blender": _bpy.app.version_string,
    "objects": [{"name": o.name, "type": o.type, "parent": o.parent.name if o.parent else None}
                for o in _bpy.context.scene.objects],
}, open("/out/report.json", "w"))
`;

const EMPTY_SCENE = `
import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
`;

const IMPORTERS = {
  glb: 'bpy.ops.import_scene.gltf(filepath=path)',
  gltf: 'bpy.ops.import_scene.gltf(filepath=path)',
  obj: 'bpy.ops.wm.obj_import(filepath=path)',
  fbx: 'bpy.ops.import_scene.fbx(filepath=path)',
  stl: 'bpy.ops.wm.stl_import(filepath=path)',
  ply: 'bpy.ops.wm.ply_import(filepath=path)',
};
export const BLENDER_FORMATS = ["blend", ...Object.keys(IMPORTERS)];

/* Babylon hands over glTF-space local matrices (row-vector layout, translation
 * in elements 12..14). The glTF exporter writes each object's matrix_local
 * conjugated into Y-up, so the inverse conjugation recovers it exactly. Cameras
 * and lights are skipped: the exporter adds an orientation correction to them. */
const APPLY_TRANSFORMS = `
import bpy, json
from mathutils import Matrix
to_gltf = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
from_gltf = to_gltf.inverted()
job = json.load(open("/job/transforms.json"))
removed = []
for name in job["deleted"]:
    obj = bpy.data.objects.get(name)
    if obj is not None:
        bpy.data.objects.remove(obj, do_unlink=True)
        removed.append(name)
if removed:
    print("deleted", len(removed), "object(s):", ", ".join(removed))
moved = []
for name, m in job["transforms"].items():
    obj = bpy.data.objects.get(name)
    if obj is None or obj.type in {"CAMERA", "LIGHT"}:
        continue
    local_gltf = Matrix((m[0:4], m[4:8], m[8:12], m[12:16])).transposed()
    obj.matrix_local = from_gltf @ local_gltf @ to_gltf
    moved.append(name)
print("moved", len(moved), "object(s):", ", ".join(moved))
`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createSession(blender, { onLine } = {}) {
  let blend = null; // the authoritative scene
  let busy = Promise.resolve();

  const run = (code, { files = {}, useSession = true } = {}) => {
    const job = busy.then(async () => {
      const staged = { ...files };
      if (useSession && blend) staged["/in/session.blend"] = blend;
      const result = await blender.run({
        code: code + "\n" + EPILOGUE,
        blendFile: useSession && blend ? "/in/session.blend" : undefined,
        files: staged,
        onLine,
      });
      blend = result.files["/out/session.blend"];
      return {
        glb: result.files["/out/scene.glb"],
        report: JSON.parse(decoder.decode(result.files["/out/report.json"])),
        output: result.output,
      };
    });
    busy = job.catch(() => {});
    return job;
  };

  return {
    get blend() { return blend; },

    newScene: () => run("", { useSession: false }),

    open(name, bytes) {
      const ext = name.split(".").pop().toLowerCase();
      if (ext === "blend") {
        blend = bytes;
        return run("");
      }
      const importer = IMPORTERS[ext];
      if (!importer) throw new Error(`Blender does not import .${ext} here`);
      const path = `/in/source.${ext}`;
      return run(`${EMPTY_SCENE}\npath = ${JSON.stringify(path)}\n${importer}`, {
        files: { [path]: bytes },
        useSession: false,
      });
    },

    pushTransforms: (transforms, deleted = []) => run(APPLY_TRANSFORMS, {
      files: { "/job/transforms.json": encoder.encode(JSON.stringify({ transforms, deleted })) },
    }),

    replaceWithGlb: (glb) => run(`${EMPTY_SCENE}\nbpy.ops.import_scene.gltf(filepath="/in/babylon.glb")`, {
      files: { "/in/babylon.glb": glb },
      useSession: false,
    }),

    runPython: (code) => run(code),
  };
}
