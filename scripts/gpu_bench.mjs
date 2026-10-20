// GPU stack benchmark / compatibility probe for a built demo site (dist dir).
// Same measurement for the WebGPU-backend build and the GL-on-wink build:
// Blender boots with a --python-expr that builds a scene, picks a viewport
// shading mode, spins the view from a bpy timer and counts real 3D-view draw
// callbacks per second (printed as "BENCH ..." lines).
//
//   node scripts/gpu_bench.mjs <dist-dir> <mode> [heavy=0|1] [seconds=12] [port=4190]
//   mode: solid | wire | material | rendered | cycles | f12_eevee | f12_cycles | idle
// Screenshot → $OUT/<tag>.png, console → $OUT/<tag>.log  (OUT default /tmp/gpu_bench)
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const [dist, mode = "solid", heavy = "0", secs = "12", port = "4190"] = process.argv.slice(2);
const OUT = process.env.OUT || "/tmp/gpu_bench";
mkdirSync(OUT, { recursive: true });
const tag = (process.env.TAG ? process.env.TAG + "_" : "") + `${mode}${heavy !== "0" ? "_heavy" + heavy : ""}`;

const py = `
import bpy, bmesh, time, math, sys
MODE = ${JSON.stringify(mode.replace(/_still$/, ""))}
STILL = ${mode.endsWith("_still") ? "True" : "False"}
HEAVY = ${Number(heavy) || 0}
SECS = ${Number(secs)}
def log(*a):
    print("BENCH", *a); sys.stdout.flush()
scn = bpy.context.scene
if HEAVY:
    me = bpy.data.meshes.new("Suzanne")
    bm = bmesh.new(); bmesh.ops.create_monkey(bm); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    ob = bpy.data.objects.new("Suzanne", me); scn.collection.objects.link(ob)
    ob.location = (0, 0, 2.2)
    mod = ob.modifiers.new("Subsurf", "SUBSURF"); mod.levels = 4; mod.render_levels = 4
    n = 6 if HEAVY == 1 else 60
    for i in range(n):
        o2 = bpy.data.objects.new("Suz%d" % i, me); scn.collection.objects.link(o2)
        r = 4 + (i // 12) * 3
        o2.location = (math.cos(i * 0.52) * r, math.sin(i * 0.52) * r, 1)
        m2 = o2.modifiers.new("Subsurf", "SUBSURF"); m2.levels = 2 if HEAVY == 1 else 3
log("scene objects=%d" % len(scn.objects))
try:
    import gpu
    log("backend", gpu.platform.backend_type_get(), gpu.platform.renderer_get(), gpu.platform.version_get())
except Exception as e:
    log("gpu module err", e)
if MODE in ("cycles", "f12_cycles"):
    scn.render.engine = "CYCLES"
    scn.cycles.samples = 16; scn.cycles.preview_samples = 16
    scn.cycles.device = "CPU"
elif MODE in ("rendered", "f12_eevee", "material"):
    scn.render.engine = "BLENDER_EEVEE"
scn.render.resolution_x = 640; scn.render.resolution_y = 360; scn.render.resolution_percentage = 100
exec(${JSON.stringify(process.env.BENCH_PY || "")})

def view3d():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                return win, area
    return None, None

draws = [0]
def on_draw():
    draws[0] += 1

def start():
    win, area = view3d()
    if area is None:
        log("no 3d view"); return None
    sp = area.spaces.active
    shading = {"solid": "SOLID", "wire": "WIREFRAME", "material": "MATERIAL",
               "rendered": "RENDERED", "cycles": "RENDERED", "idle": "SOLID"}.get(MODE, "SOLID")
    sp.shading.type = shading
    sp.overlay.show_stats = True
    if MODE.startswith("f12"):
        bpy.app.timers.register(lambda: f12(), first_interval=1.0)
        return None
    bpy.types.SpaceView3D.draw_handler_add(on_draw, (), "WINDOW", "POST_PIXEL")
    rv3d = sp.region_3d
    st = {"t0": time.time(), "last": time.time(), "n0": 0, "rates": []}
    def step():
        now = time.time()
        if MODE != "idle" and not STILL:
            rv3d.view_rotation.rotate(__import__("mathutils").Euler((0, 0, 0.02)))
            area.tag_redraw()
        if now - st["last"] >= 2.0:
            rate = (draws[0] - st["n0"]) / (now - st["last"])
            st["rates"].append(rate)
            log("fps=%.1f draws=%d t=%.1f" % (rate, draws[0], now - st["t0"]))
            st["last"] = now; st["n0"] = draws[0]
        if now - st["t0"] >= SECS:
            r = st["rates"][1:] or st["rates"]
            log("DONE mean_fps=%.2f samples=%s" % (sum(r) / max(1, len(r)), ",".join("%.1f" % x for x in r)))
            return None
        return 0.0
    bpy.app.timers.register(step, first_interval=0.5)
    return None

def f12():
    t = time.time()
    scn.render.filepath = "/tmp/bench_render.png"
    scn.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    dt = time.time() - t
    try:
        im = bpy.data.images.load("/tmp/bench_render.png")
        px = list(im.pixels)
        n = len(px) // 4
        avg = [sum(px[c::4]) / max(1, n) for c in range(3)]
        nonbg = sum(1 for i in range(0, len(px), 4) if abs(px[i] - px[0]) + abs(px[i+1] - px[1]) + abs(px[i+2] - px[2]) > 0.02)
        import base64
        print("F12PNG " + base64.b64encode(open("/tmp/bench_render.png", "rb").read()).decode()); sys.stdout.flush()
        log("F12 image %dx%d avg=(%.3f %.3f %.3f) pixels_differing_from_corner=%d" % (im.size[0], im.size[1], avg[0], avg[1], avg[2], nonbg))
    except Exception as e:
        log("F12 image read failed", e)
    img = bpy.data.images.get("Render Result")
    log("F12 engine=%s time=%.2fs" % (scn.render.engine, dt))
    # Pixel sanity from the render result's Combined pass.
    try:
        import numpy  # noqa
    except Exception:
        pass
    log("DONE f12_time=%.2f" % dt)
    return None

bpy.app.timers.register(start, first_interval=4.0)
`;

const srv = spawn("node", ["scripts/serve.mjs", dist, port], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  // BENCH_SWIFTSHADER=1: headless chromium, which only offers SwiftShader.
  headless: !!process.env.BENCH_SWIFTSHADER,
  env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
         VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" },
  args: ["--ozone-platform=x11", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
         "--ignore-gpu-blocklist", "--window-size=1700,1000"],
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const full = createWriteStream(`${OUT}/${tag}.log`);
let done = null, errs = 0;
const t0 = Date.now();
let bootMs = null;
page.on("console", (m) => {
  const t = m.text();
  full.write(t + "\n");
  if (t.startsWith("F12PNG ")) { import("node:fs").then((fs) => fs.writeFileSync(`${OUT}/${tag}_render.png`, Buffer.from(t.slice(7), "base64"))); return; }
  if (t.includes("BENCH")) console.log(t.replace(/^.*BENCH/, "BENCH"));
  if (t.includes("BENCH DONE")) done = t;
});
page.on("pageerror", (e) => { errs++; full.write("PAGEERROR:\n" + (e.stack || e.message) + "\n"); console.log("PAGEERROR " + e.message); });
// BENCH_STRIP_FEATURES=a,b hides WebGPU adapter features from the page.
if (process.env.BENCH_STRIP_FEATURES) await page.addInitScript((list) => {
  const strip = new Set(list.split(","));
  const has = GPUSupportedFeatures.prototype.has;
  GPUSupportedFeatures.prototype.has = function (f) { return !strip.has(f) && has.call(this, f); };
  const rd = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function (d = {}) {
    if (d.requiredFeatures) d = { ...d, requiredFeatures: [...d.requiredFeatures].filter((f) => !strip.has(f)) };
    return rd.call(this, d);
  };
}, process.env.BENCH_STRIP_FEATURES);
// BENCH_ENV='{"NAME":"value"}' sets environment variables inside the module.
await page.addInitScript(([code, env]) => {
  window.__BARGS = ["--python-expr", code];
  if (env) window.__CAPENV = JSON.parse(env);
}, [py, process.env.BENCH_ENV || ""]);
await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
// Launch button enables once downloads finish.
for (let i = 0; i < 300; i++) {
  const ok = await page.evaluate(() => { const b = document.getElementById("start-btn"); return b && !b.disabled; });
  if (ok) break;
  await new Promise((r) => setTimeout(r, 500));
}
// A software adapter needs the acknowledgement box.
await page.evaluate(() => { const a = document.getElementById("gpu-ack"); if (a && !a.checked && a.offsetParent) a.click(); });
const tLaunch = Date.now();
await page.click("#start-btn");
for (let i = 0; i < 600; i++) {
  const s = await page.evaluate(() => window.__BGUI__ || {});
  if (s.window) { bootMs = Date.now() - tLaunch; break; }
  await new Promise((r) => setTimeout(r, 250));
}
await new Promise((r) => setTimeout(r, 1500));
await page.mouse.move(800, 500);
await page.keyboard.press("Escape"); /* splash */
console.log(`BOOT ${bootMs === null ? "TIMEOUT" : bootMs + "ms"} errs=${errs}`);
const limit = Date.now() + (Number(secs) + 60) * 1000 + (mode.startsWith("f12") ? 240000 : 0);
while (!done && Date.now() < limit) await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: `${OUT}/${tag}.png` });
console.log(done ? "RESULT " + done.replace(/^.*BENCH /, "") : "RESULT TIMEOUT", `errs=${errs}`, `total=${Date.now() - t0}ms`);
await browser.close();
srv.kill();
