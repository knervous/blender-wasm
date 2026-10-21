// Interactive compatibility pass over a built demo site: selection, transform,
// shading modes, edit mode, hidden geometry, interactive F12 (EEVEE + Cycles).
// Screenshots → $OUT/<tag>_NN_name.png; console → $OUT/<tag>.log.
//   TAG=gl node scripts/compat_suite.mjs <dist-dir> [port=4192]
// Mode changes go through a command channel that needs nothing from the page
// but a key press: the commands are baked into the startup script, and each
// Right-arrow press (frame + 1) makes a bpy timer run the next one and print
// CMD_DONE. (Writing into the wasm FS from the page would malloc on the
// browser main thread, which the GL build's driver runner owns.)
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const [dist, port = "4192"] = process.argv.slice(2);
const OUT = process.env.OUT || "/tmp/compat";
const TAG = process.env.TAG || "run";
mkdirSync(OUT, { recursive: true });

const COMMANDS = [];  // filled below, before boot
const V3D = `
import bpy
def v3d():
    for w in bpy.context.window_manager.windows:
        for a in w.screen.areas:
            if a.type == "VIEW_3D":
                return a, a.spaces.active
a, sp = v3d()
`;

// The commands, in call order, read straight out of this file's cmd() calls.
const self = (await import("node:fs")).readFileSync(new URL(import.meta.url), "utf8");
for (const m of self.matchAll(/await cmd\(`([^`]*)`/g)) COMMANDS.push(m[1]);
const py = `
import bpy, sys, traceback
CMDS = ${JSON.stringify(COMMANDS.map((c) => V3D + c))}
state = {"frame": None, "next": 0}
def poll():
    f = bpy.context.scene.frame_current
    if state["frame"] is None:
        state["frame"] = f
    elif f != state["frame"]:
        state["frame"] = f
        i = state["next"]; state["next"] += 1
        try:
            exec(CMDS[i], {"bpy": bpy})
            print("CMD_DONE ok %d" % i)
        except Exception:
            traceback.print_exc(); print("CMD_DONE error %d" % i)
        sys.stdout.flush()
    return 0.15
bpy.app.timers.register(poll, first_interval=2.0)
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
const log = createWriteStream(`${OUT}/${TAG}.log`);
let errs = 0, cmdDone = 0, cmdErr = 0;
page.on("console", (m) => {
  const t = m.text(); log.write(t + "\n");
  if (t.includes("CMD_DONE")) { cmdDone++; if (t.includes("error")) cmdErr++; }
});
page.on("pageerror", (e) => { errs++; log.write("PAGEERROR " + (e.stack || e.message) + "\n"); });
await page.addInitScript(([code, env]) => {
  window.__BARGS = ["--python-expr", code];
  if (env) window.__CAPENV = JSON.parse(env);
}, [py, process.env.BENCH_ENV || ""]);
// STOP_AFTER=n ends the run after n screenshots.
const STOP_AFTER = Number(process.env.STOP_AFTER || 1e9);
await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
for (let i = 0; i < 300; i++) {
  if (await page.evaluate(() => { const b = document.getElementById("start-btn"); return b && !b.disabled; })) break;
  await new Promise((r) => setTimeout(r, 500));
}
await page.click("#start-btn");
for (let i = 0; i < 600; i++) {
  if ((await page.evaluate(() => window.__BGUI__ || {})).window) break;
  await new Promise((r) => setTimeout(r, 250));
}
const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));
await settle(3000);
const box = await page.locator("#canvas").boundingBox();
const at = (x, y) => [box.x + x, box.y + y];
let n = 0;
const shot = async (name) => {
  const p = `${OUT}/${TAG}_${String(++n).padStart(2, "0")}_${name}.png`;
  await page.locator("#canvas").screenshot({ path: p });
  console.log(`shot ${p} errs=${errs}`);
  if (n >= STOP_AFTER) { console.log("stopping early"); await browser.close(); srv.kill(); process.exit(0); }
};
let cmdIndex = 0;
const cmd = async (code, wait = 1500) => {
  if (COMMANDS[cmdIndex] !== code) throw new Error("command order mismatch at " + cmdIndex);
  cmdIndex++;
  const before = cmdDone;
  await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 200 && cmdDone === before; i++) await settle(100);
  if (cmdDone === before) console.log("cmd timeout: " + code.slice(0, 60));
  await settle(wait);
};
const key = async (k, wait = 900) => { await page.keyboard.press(k); await settle(wait); };

await page.mouse.move(...at(800, 470));
await key("Escape", 1500);                                   // splash
await cmd(`sp.shading.type = "SOLID"; sp.overlay.show_stats = True`);
await shot("solid");
// Selection through the GPU select buffer: empty space deselects, cube selects.
await page.mouse.click(...at(300, 700)); await settle();
await shot("click_empty_deselect");
await page.mouse.click(...at(655, 450)); await settle();
await shot("click_cube_select");
// Grab + move with the mouse, confirm.
await key("g", 400);
for (let i = 1; i <= 10; i++) { await page.mouse.move(...at(655 + i * 15, 450 - i * 4)); await settle(60); }
await page.mouse.click(...at(805, 410)); await settle();
await shot("grab_moved");
await key("Control+z", 1200);
// Shading modes.
await cmd(`sp.shading.type = "WIREFRAME"`); await shot("wireframe");
await cmd(`sp.shading.type = "SOLID"; sp.shading.show_xray = True`); await shot("xray");
await cmd(`sp.shading.show_xray = False; sp.shading.type = "MATERIAL"`, 9000); await shot("material_preview");
await cmd(`bpy.context.scene.render.engine = "BLENDER_EEVEE"; sp.shading.type = "RENDERED"`, 9000); await shot("rendered_eevee");
await cmd(`bpy.context.scene.render.engine = "CYCLES"; bpy.context.scene.cycles.preview_samples = 32; sp.shading.type = "RENDERED"`, 15000);
await shot("rendered_cycles");
await cmd(`bpy.context.scene.render.engine = "BLENDER_EEVEE"; sp.shading.type = "SOLID"`);
// Edit mode: vertices, click-select, box-select, hide (restart indices).
await page.mouse.move(...at(655, 450));
await key("Tab", 2500); await shot("editmode");
await key("Alt+a"); await page.mouse.click(...at(719, 397)); await settle(); await shot("edit_vertex_click");
await key("1"); await key("3", 600);                            // face select
await key("b", 400);
await page.mouse.move(...at(560, 330)); await page.mouse.down();
await page.mouse.move(...at(760, 420), { steps: 8 }); await page.mouse.up(); await settle();
await shot("edit_face_boxselect");
await key("h", 1500); await shot("edit_hidden");
await key("Alt+h", 1200);
await key("2", 600); await cmd(`sp.shading.type = "WIREFRAME"`); await key("a"); await key("h", 1500);
await shot("edit_wire_all_hidden");
await key("Alt+h", 1000); await cmd(`sp.shading.type = "SOLID"`);
await key("Tab", 1500);
// Interactive F12: render job on a thread, result in the image editor.
await cmd(`s = bpy.context.scene; s.render.resolution_x = 480; s.render.resolution_y = 270; s.render.resolution_percentage = 100; s.eevee.taa_render_samples = 8`);
await page.mouse.move(...at(655, 450));
await key("F12", 20000); await shot("f12_eevee");
await key("Escape", 2000);
await cmd(`bpy.context.scene.render.engine = "CYCLES"; bpy.context.scene.cycles.samples = 16`);
await page.mouse.move(...at(655, 450));
await key("F12", 20000); await shot("f12_cycles");
await key("Escape", 2000);
// DUMP_WGSL=<file>: write wink's SPIR-V -> WGSL translation cache, as
// gex_wgsl_cache_dump makes it, for shipping with the site.
if (process.env.DUMP_WGSL) {
  await settle(1500);
  const b64 = await page.evaluate(() => {
    if (!Module._gex_wgsl_cache_dump) return null;
    const lenp = Module._malloc(4);
    const p = Module._gex_wgsl_cache_dump(0, lenp);
    const H = Module.HEAPU8;
    const len = H[lenp] | (H[lenp + 1] << 8) | (H[lenp + 2] << 16) | (H[lenp + 3] << 24);
    const bytes = H.slice(p, p + len);
    Module._free(p); Module._free(lenp);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  if (b64) {
    (await import("node:fs")).writeFileSync(process.env.DUMP_WGSL, Buffer.from(b64, "base64"));
    console.log(`WGSL cache dumped: ${Buffer.from(b64, "base64").length} bytes -> ${process.env.DUMP_WGSL}`);
  } else console.log("WGSL cache: no dump export");
}
console.log(`DONE errs=${errs} cmds=${cmdDone} cmd_errors=${cmdErr}`);
await browser.close();
srv.kill();
