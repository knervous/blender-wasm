// CPU-profile every thread (page + all workers) of a running demo build while
// gpu_bench's viewport spin is going, and print the top self-time functions of
// the busiest threads.
//   node scripts/gpu_profile.mjs <dist-dir> <mode> [heavy] [profile-seconds=8]
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const [dist, mode = "solid", heavy = "0", psecs = "8"] = process.argv.slice(2);
const PORT = 4191, DBG = 9339;
const py = `
import bpy, math, mathutils, bmesh
scn = bpy.context.scene
if ${heavy === "1" ? "True" : "False"}:
    me = bpy.data.meshes.new("S"); bm = bmesh.new(); bmesh.ops.create_monkey(bm); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new("S", me); scn.collection.objects.link(ob); ob.location=(0,0,2.2)
    m = ob.modifiers.new("s","SUBSURF"); m.levels = 4
if ${JSON.stringify(mode)} in ("rendered","material"): scn.render.engine = "BLENDER_EEVEE"
if ${JSON.stringify(mode)} == "cycles": scn.render.engine = "CYCLES"; scn.cycles.preview_samples = 16
def go():
    for w in bpy.context.window_manager.windows:
        for a in w.screen.areas:
            if a.type == "VIEW_3D":
                sp = a.spaces.active
                sp.shading.type = {"solid":"SOLID","material":"MATERIAL","rendered":"RENDERED","cycles":"RENDERED"}[${JSON.stringify(mode)}]
                def step():
                    sp.region_3d.view_rotation.rotate(mathutils.Euler((0,0,0.02))); a.tag_redraw(); return 0.0
                bpy.app.timers.register(step)
                print("PROFILE_READY")
                return None
bpy.app.timers.register(go, first_interval=4.0)
`;
const srv = spawn("node", ["scripts/serve.mjs", dist, String(PORT)], { stdio: "ignore" });
const chrome = spawn(`${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, [
  `--remote-debugging-port=${DBG}`, "--user-data-dir=/tmp/gpu_profile_chrome", "--no-first-run",
  "--ozone-platform=x11", "--enable-unsafe-webgpu", "--enable-features=Vulkan",
  "--ignore-gpu-blocklist", "--window-size=1700,1000", "about:blank"],
  { env: { ...process.env, DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
           VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/radeon_icd.json" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DBG}`);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();
await page.setViewportSize({ width: 1600, height: 950 });
let ready = false;
page.on("console", (m) => { const t = m.text(); if (t.includes("PROFILE_READY")) ready = true; if (/Error|error|ABORT|Traceback/.test(t)) console.log("CONSOLE " + t.slice(0, 300)); });
page.on("pageerror", (e) => console.log("PAGEERROR " + e.message));
await page.addInitScript((code) => { window.__BARGS = ["--python-expr", code]; }, py);
await page.goto(`http://localhost:${PORT}/`);
for (let i = 0; i < 300; i++) {
  if (await page.evaluate(() => { const b = document.getElementById("start-btn"); return b && !b.disabled; })) break;
  await new Promise((r) => setTimeout(r, 500));
}
await page.click("#start-btn");
for (let i = 0; i < 600 && !ready; i++) await new Promise((r) => setTimeout(r, 250));
console.log("ready=" + ready);
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 4000));

// Raw CDP over the browser websocket: attach to every target (flattened).
const ver = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pend = new Map(); const sessions = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
  if (msg.method === "Target.attachedToTarget") {
    const { sessionId, targetInfo } = msg.params;
    sessions.set(sessionId, targetInfo);
    send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  }
});
const send = (method, params = {}, sessionId) => new Promise((r) => {
  const m = { id: ++id, method, params }; if (sessionId) m.sessionId = sessionId;
  pend.set(m.id, r); ws.send(JSON.stringify(m));
});
const targets = (await send("Target.getTargets")).result.targetInfos;
for (const t of targets) if (t.type === "page" && t.url.includes(`:${PORT}`))
  await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
await new Promise((r) => setTimeout(r, 1500));
const sids = [...sessions.keys()];
for (const s of sids) { await send("Profiler.enable", {}, s); await send("Profiler.setSamplingInterval", { interval: 200 }, s); await send("Profiler.start", {}, s); }
await new Promise((r) => setTimeout(r, Number(psecs) * 1000));
const results = [];
for (const s of sids) {
  const r = await send("Profiler.stop", {}, s);
  if (!r.result) continue;
  const prof = r.result.profile;
  const self = new Map(); let total = 0, idle = 0;
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const counts = new Map();
  for (const sid of prof.samples) counts.set(sid, (counts.get(sid) || 0) + 1);
  for (const [nid, c] of counts) {
    const n = byId.get(nid); const name = n.callFrame.functionName || `(${n.callFrame.url.split("/").pop()})`;
    total += c; if (/^\(idle\)$|futex_wait|^wait$|Atomics/.test(name)) idle += c;
    self.set(name, (self.get(name) || 0) + c);
  }
  // Caller chains of the waits.
  const parent = new Map();
  for (const n of prof.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
  const chains = new Map();
  for (const [nid, c] of counts) {
    const n = byId.get(nid);
    if (!/futex_wait/.test(n.callFrame.functionName)) continue;
    const ch = []; let p = parent.get(nid);
    while (p && ch.length < 9) { const f = byId.get(p).callFrame.functionName; if (f && !/futex|^wait$|emscripten_futex/.test(f)) ch.push(f.replace(/\(.*$/, "").slice(0, 60)); p = parent.get(p); }
    const k = ch.join(" < "); chains.set(k, (chains.get(k) || 0) + c);
  }
  results.push({ t: sessions.get(s), total, idle, self, chains });
}
results.sort((a, b) => (b.total - b.idle) - (a.total - a.idle));
for (const r of results.slice(0, 2)) {
  const busy = r.total - r.idle;
  console.log(`\n=== ${r.t.type} ${r.t.url.split("/").pop()} busy=${(100 * busy / Math.max(1, r.total)).toFixed(1)}% samples=${r.total}`);
  [...r.self.entries()].filter(([k]) => !/^\(idle\)$|futex_wait|^wait$|Atomics/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 28)
    .forEach(([k, v]) => console.log(`  ${(100 * v / r.total).toFixed(1).padStart(5)}%  ${k}`));
  [...r.chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([k, v]) => console.log(`  WAIT ${(100 * v / r.total).toFixed(1).padStart(5)}%  ${k}`));
}
ws.close(); await browser.close().catch(() => {}); chrome.kill(); srv.kill();
process.exit(0);
