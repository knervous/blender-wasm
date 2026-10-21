// NumPy + Python importer/exporter checks on a built demo site: numpy basics,
// glTF/FBX round trips of the startup scene (incl. animation), the C++ OBJ/PLY/
// STL operators, and imports of glTF sample models (skinning, morph targets,
// animation, textures). Each check prints "IOTEST ok|FAIL <name> ..."; ends with
// a Material Preview screenshot of the last (textured) import.
//   node scripts/numpy_io_test.mjs <dist-dir> <models-dir> [port=4193]
// Models (*.glb in <models-dir>) ride in via --python-expr as base64, since
// writing into the wasm FS from the page would malloc on the browser main
// thread, which the GL build's driver runner owns.
import { spawn } from "node:child_process";
import { createWriteStream, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const [dist, modelsDir, port = "4193"] = process.argv.slice(2);
const OUT = process.env.OUT || "/tmp/numpy_io";
mkdirSync(OUT, { recursive: true });
const models = {};
for (const f of readdirSync(modelsDir).filter((f) => f.endsWith(".glb")).sort())
  models[f] = readFileSync(`${modelsDir}/${f}`).toString("base64");

const py = String.raw`
import bpy, sys, os, base64, traceback
MODELS = ${JSON.stringify(models)}
TMP = "/tmp/iotest"
os.makedirs(TMP, exist_ok=True)

def ctx():
    w = bpy.context.window_manager.windows[0]
    a = next(a for a in w.screen.areas if a.type == "VIEW_3D")
    return bpy.context.temp_override(window=w, area=a, region=a.regions[-1])

def check(name, fn):
    try:
        print("IOTEST ok %s %s" % (name, fn()))
    except BaseException:
        traceback.print_exc()
        print("IOTEST FAIL %s" % name)
    sys.stdout.flush()

def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.actions,
                 bpy.data.armatures, bpy.data.cameras, bpy.data.lights):
        for d in list(coll):
            coll.remove(d)

def summary():
    return "objs=%d meshes=%d verts=%d mats=%d imgs=%d actions=%d arm=%d shapekeys=%d" % (
        len(bpy.data.objects), len(bpy.data.meshes),
        sum(len(m.vertices) for m in bpy.data.meshes), len(bpy.data.materials),
        len(bpy.data.images), len(bpy.data.actions), len(bpy.data.armatures),
        sum(1 for m in bpy.data.meshes if m.shape_keys))

def numpy_basics():
    import numpy as np
    a = np.arange(12, dtype=np.float32).reshape(3, 4)
    assert float(a.sum()) == 66.0
    m = np.array([[2.0, 1.0], [1.0, 3.0]])
    assert np.allclose(np.linalg.inv(m) @ m, np.eye(2))
    u, s, vt = np.linalg.svd(m)
    assert np.allclose(np.linalg.eigvalsh(m), sorted(s))
    assert np.allclose(np.fft.ifft(np.fft.fft(np.arange(8))).real, np.arange(8))
    r = np.random.default_rng(42).random(4)
    assert r.shape == (4,) and np.random.RandomState(1).randint(0, 10, 3).shape == (3,)
    assert list(np.unique([3, 1, 3, 2])) == [1, 2, 3]
    assert np.einsum("ij,ij->", a, a) == float((a * a).sum())
    h = np.array([1.5, 2.25], dtype=np.float16).astype(np.float64)
    assert list(h) == [1.5, 2.25]
    assert np.argsort(np.array([3.0, -1.0, 2.0])).tolist() == [1, 2, 0]
    v = np.frombuffer(np.array([1, 2, 3], dtype=np.uint16).tobytes(), dtype=np.uint16)
    assert v.tolist() == [1, 2, 3]
    assert str(np.datetime64("2026-01-01") + np.timedelta64(1, "D")) == "2026-01-02"
    me = bpy.data.meshes.new("np")
    me.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])
    co = np.empty(9, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    assert co.tolist() == [0, 0, 0, 1, 0, 0, 0, 1, 0]
    bpy.data.meshes.remove(me)
    return "numpy %s %s %r" % (np.__version__, np.array([0.1, 1e-8, 3.0]), r[:2])

def roundtrip(ext, exp, imp, **kw):
    def run():
        cube = bpy.data.objects.get("Cube")
        if cube and not cube.animation_data:
            cube.location = (0, 0, 0); cube.keyframe_insert("location", frame=1)
            cube.location = (2, 0, 1); cube.keyframe_insert("location", frame=20)
        path = os.path.join(TMP, "rt." + ext)
        with ctx():
            assert exp(filepath=path, **kw) == {"FINISHED"}
        size = os.path.getsize(path)
        saved = {o.name for o in bpy.data.objects}
        before = len(bpy.data.objects)
        with ctx():
            assert imp(filepath=path) == {"FINISHED"}
        new = [o for o in bpy.data.objects if o.name not in saved]
        assert new, "nothing imported"
        res = "%d bytes, +%d objs (%s)" % (size, len(new), ",".join(sorted(o.type for o in new)))
        for o in new:
            bpy.data.objects.remove(o)
        return res
    return run

def import_model(name, b64):
    def run():
        clear()
        path = os.path.join(TMP, name)
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
        with ctx():
            assert bpy.ops.import_scene.gltf(filepath=path) == {"FINISHED"}
        s = summary()
        assert bpy.data.objects, "nothing imported"
        out = os.path.join(TMP, "re_" + name)
        with ctx():
            assert bpy.ops.export_scene.gltf(filepath=out) == {"FINISHED"}
        return s + " | re-export %d bytes" % os.path.getsize(out)
    return run

def clocks():
    import time
    t0 = time.process_time(); sum(range(100000)); t1 = time.process_time()
    assert t1 >= t0, (t0, t1)
    return "process_time %.4fs/100k (%s)" % (t1 - t0, time.get_clock_info("process_time").implementation)

ONLY = ${JSON.stringify(process.env.ONLY || "")}
_check = check
def check(name, fn):
    if not ONLY or any(k in name for k in ONLY.split(",")):
        _check(name, fn)

def main():
    check("clocks", clocks)
    check("numpy_basics", numpy_basics)
    check("gltf_compression_probe", lambda: __import__("io_scene_gltf2").is_draco_available() or
          __import__("io_scene_gltf2").is_meshopt_available() or "draco/meshopt unavailable (expected)")
    gltf, fbx, wm = bpy.ops.export_scene, bpy.ops.import_scene, bpy.ops.wm
    check("gltf_glb_roundtrip", roundtrip("glb", gltf.gltf, fbx.gltf))
    check("gltf_separate_roundtrip", roundtrip("gltf", gltf.gltf, fbx.gltf, export_format="GLTF_SEPARATE"))
    check("fbx_roundtrip", roundtrip("fbx", gltf.fbx, fbx.fbx))
    check("obj_roundtrip", roundtrip("obj", wm.obj_export, wm.obj_import))
    check("ply_roundtrip", roundtrip("ply", wm.ply_export, wm.ply_import))
    check("stl_roundtrip", roundtrip("stl", wm.stl_export, wm.stl_import))
    for name in sorted(MODELS, key=lambda n: n == "DamagedHelmet.glb"):
        check("import_" + name, import_model(name, MODELS[name]))
    with ctx():
        bpy.ops.view3d.view_all()
    next(a for a in bpy.context.window_manager.windows[0].screen.areas
         if a.type == "VIEW_3D").spaces.active.shading.type = "MATERIAL"
    print("IOTEST DONE"); sys.stdout.flush()

bpy.app.timers.register(lambda: main() and None, first_interval=2.0)
`;

const srv = spawn("node", ["scripts/serve.mjs", dist, port], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  headless: false,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
         "--ignore-gpu-blocklist", "--window-size=1700,1000"],
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const log = createWriteStream(`${OUT}/numpy_io.log`);
let done = false, fails = 0, oks = 0;
page.on("console", (m) => {
  const t = m.text(); log.write(t + "\n");
  if (t.startsWith("IOTEST")) {
    console.log(t.length > 300 ? t.slice(0, 300) + "…" : t);
    if (t.includes("IOTEST ok")) oks++;
    if (t.includes("IOTEST FAIL")) fails++;
    if (t.includes("IOTEST DONE")) done = true;
  } else if (/Traceback|Error|error:/.test(t)) console.log("  " + t.slice(0, 400));
});
page.on("pageerror", (e) => { log.write("PAGEERROR " + (e.stack || e.message) + "\n"); console.log("PAGEERROR " + e.message); });
await page.addInitScript((code) => { window.__BARGS = ["--python-expr", code]; }, py);
await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
for (let i = 0; i < 300; i++) {
  if (await page.evaluate(() => { const b = document.getElementById("start-btn"); return b && !b.disabled; })) break;
  await new Promise((r) => setTimeout(r, 500));
}
await page.click("#start-btn");
for (let i = 0; i < 2400 && !done; i++) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 8000));  // material preview compiles
await page.locator("#canvas").screenshot({ path: `${OUT}/final.png` });
console.log(`${done ? "finished" : "TIMEOUT"}: ${oks} ok, ${fails} failed  (log ${OUT}/numpy_io.log)`);
await browser.close(); srv.kill();
process.exit(done && !fails ? 0 : 1);
