// Startup time and input-to-photon latency of a built demo site.
//   node scripts/latency_bench.mjs <dist-dir> [runs=5] [port=4194]
//
// The canvas is mirrored into a <video> through canvas.captureStream(), and
// every presented frame is stamped by requestVideoFrameCallback and diffed
// against a probe region. An action's latency is the presentation time of the
// first frame whose probe region changed, minus the timeStamp of the DOM input
// event that started it (both on the page's performance.now() clock), so
// neither CDP nor Playwright's own latency is counted.
//
// Startup: Launch click -> splash on screen (Blender interactive), and
// Escape -> splash gone, cube scene on screen.
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const [dist, runs = "5", port = "4194"] = process.argv.slice(2);
const RUNS = Number(runs);
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
let errs = 0;
page.on("pageerror", () => errs++);
page.on("console", (m) => { const t = m.text(); if (t.includes("wgsl cache") || t.includes("wink: the GL thread") || t.includes("gex-wgpu: ")) console.log("LOG " + t); });

// COUNT_GPU=1: count WebGPU calls (and their main-thread time) per method,
// read out per action as GPUCOUNT lines.
if (process.env.COUNT_GPU) await page.addInitScript(() => {
  const C = (window.__gpucount = {});
  for (const cls of ["GPUDevice", "GPUQueue", "GPUCommandEncoder", "GPURenderPassEncoder", "GPUComputePassEncoder", "GPUBuffer", "GPUTexture", "GPUCanvasContext"]) {
    const P = window[cls]?.prototype; if (!P) continue;
    for (const k of Object.getOwnPropertyNames(P)) {
      const d = Object.getOwnPropertyDescriptor(P, k);
      if (typeof d.value !== "function" || k === "constructor") continue;
      const f = d.value, name = cls.replace("GPU", "") + "." + k;
      P[k] = function (...a) {
        if (name === "CommandEncoder.copyTextureToTexture" || name === "CommandEncoder.copyTextureToBuffer" || name === "CommandEncoder.copyBufferToTexture" || name === "Device.createComputePipeline" || name === "Device.createTexture") {
          const H = (window.__gpuhist = window.__gpuhist || {});
          const tx = (t) => t && t.texture ? `${t.texture.width}x${t.texture.height}x${t.texture.depthOrArrayLayers}/${t.texture.format}/m${t.mipLevel ?? 0}/o${t.origin ? "z" + (t.origin.z ?? 0) : ""}` : "buf";
          const sz = (e) => Array.isArray(e) ? e.join("x") : e ? `${e.width}x${e.height ?? 1}x${e.depthOrArrayLayers ?? 1}` : "";
          const key = name.split(".")[1] + " " + (name === "Device.createComputePipeline" ? (a[0]?.label || "") + (a[0]?.compute?.entryPoint || "") : name === "Device.createTexture" ? sz(a[0].size) + "/" + a[0].format + "/u" + a[0].usage : tx(a[0]) + " -> " + tx(a[1]) + " " + sz(a[2]));
          H[key] = (H[key] || 0) + 1;
        }
        const t = performance.now();
        try { return f.apply(this, a); }
        finally { const e = C[name] || (C[name] = [0, 0]); e[0]++; e[1] += performance.now() - t; }
      };
    }
  }
});
// Main-thread swap marks: when wink's swap runs on the page's thread (it takes
// the canvas texture) and when the frame's first submit before it happened.
await page.addInitScript(() => {
  const S = (window.__swaps = []);
  let first = null;
  const gct = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    S.push({ t: performance.now(), first }); first = null;
    if (S.length > 2000) S.splice(0, 1000);
    return gct.call(this);
  };
  const sub = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (b) { if (first === null) first = performance.now(); return sub.call(this, b); };
});
// BENCH_ENV='{"NAME":"value"}' sets environment variables inside the module.
if (process.env.BENCH_ENV) await page.addInitScript((env) => { window.__CAPENV = JSON.parse(env); }, process.env.BENCH_ENV);
// Frame monitor + input stamps, installed before the app runs.
await page.addInitScript(() => {
  const M = (window.__lat = { frames: [], inputs: [], started: false });
  for (const type of ["mousedown", "mousemove", "keydown", "wheel"])
    window.addEventListener(type, (e) => M.inputs.push({ type, t: e.timeStamp }), true);
  M.start = (canvas) => {
    if (M.started) return; M.started = true;
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    video.style.cssText = "position:fixed;left:-10000px;top:0;width:1600px;height:950px";
    video.srcObject = canvas.captureStream();
    document.body.appendChild(video); video.play();
    M.probes = [];   // [{x,y,w,h}]
    // The pixels are read in a worker: a readback here (drawImage of the
    // video) waits on the GPU, and in the GL build this is the thread the GL
    // driver runs on, so sampling on it delayed the very frames it measured.
    // Each presented frame goes over as a VideoFrame with its presentation
    // time; the worker answers with block-luma signatures.
    const src = `
      const c = new OffscreenCanvas(1600, 950), g = c.getContext("2d", { willReadFrequently: true });
      onmessage = ({ data: m }) => {
        const out = m.probes.map((p) => {
          g.drawImage(m.frame, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
          const d = g.getImageData(0, 0, p.w, p.h).data;
          if (m.chroma) {
            let s = 0; for (let i = 0; i < d.length; i += 4)
              s += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
            return s / (p.w * p.h);
          }
          // Luma means of a 4x4 grid of blocks: a change anywhere moves some
          // block, even one (an orbiting grid) that keeps the overall brightness.
          const blocks = new Array(16).fill(0);
          for (let y = 0; y < p.h; y++)
            for (let x = 0; x < p.w; x++) {
              const i = (y * p.w + x) * 4;
              blocks[((y * 4 / p.h) | 0) * 4 + ((x * 4 / p.w) | 0)] += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
            }
          const n = (p.w / 4) * (p.h / 4);
          return blocks.map((b) => b / n);
        });
        m.frame.close();
        postMessage({ id: m.id, out });
      };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    let nextId = 0; const pending = new Map();
    w.onmessage = ({ data }) => { const f = pending.get(data.id); pending.delete(data.id); f(data.out); };
    const ask = (probes, chroma) => new Promise((res) => {
      let frame; try { frame = new VideoFrame(video); } catch (e) { res(null); return; }
      const id = nextId++; pending.set(id, res);
      w.postMessage({ id, frame, probes, chroma }, [frame]);
    });
    // Mean chroma of a region: Blender's splash artwork is colourful, the
    // UI around it is grey.
    M.chroma = async (p) => ((await ask([p], true)) || [0])[0];
    // A frame's entry is added now and its signature filled in when the
    // worker answers; waitChange skips entries still waiting.
    const record = (t) => {
      if (!M.probes.length) return;
      const f = { t, sig: null }; M.frames.push(f);
      if (M.frames.length > 4000) M.frames.splice(0, 2000);
      return ask(M.probes, false).then((sig) => { f.sig = sig; });
    };
    // The stream only carries a frame when the canvas changes, so a quiet
    // screen has none to compare against: the baseline is the frame the
    // video is still showing, sampled now.
    M.snapshot = () => record(performance.now());
    const tick = (now, meta) => {
      record(meta.presentationTime ?? now);
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => page.evaluate(() => performance.now());
const setProbes = (probes) => page.evaluate((p) => { window.__lat.probes = p; window.__lat.frames = []; }, probes);
const snapshot = () => page.evaluate(async () => { await window.__lat.snapshot(); });
const lastInput = (type) => page.evaluate((t) => [...window.__lat.inputs].reverse().find((i) => i.type === t)?.t, type);
// First frame after `since` whose probe `idx` differs from the last frame
// before `since` by more than `thresh`.
async function waitChange(since, idx = 0, thresh = 2, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await page.evaluate(([since, idx, thresh]) => {
      const F = window.__lat.frames;
      let base = null;
      for (const f of F) { if (f.t <= since && f.sig) base = f.sig[idx]; }
      if (base === null) return null;
      const diff = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])));
      for (const f of F) {
        if (f.t <= since) continue;
        if (!f.sig) return null;   // answered in order: wait for this one
        if (diff(f.sig[idx], base) > thresh) return f.t;
      }
      return null;
    }, [since, idx, thresh]);
    if (r !== null) return r;
    await sleep(20);
  }
  return null;
}

// --- startup ---------------------------------------------------------------
const tNav = Date.now();
await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
for (let i = 0; i < 600; i++) {
  if (await page.evaluate(() => { const b = document.getElementById("start-btn"); return b && !b.disabled; })) break;
  await sleep(100);
}
const tReady = Date.now();
await page.evaluate(() => window.__lat.start(document.getElementById("canvas")));
await setProbes([]);
await page.click("#start-btn");
const tLaunch = await lastInput("mousedown");
// Splash visible: the demo reveals the canvas on Blender's first frame; wait
// for the probe to settle to the splash image (stable for 500 ms after change).
let splashAt = null, firstFrameAt = null;
{
  // The splash artwork sits at the top of the dialog (canvas ~555..1045 x 265..505).
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const [c, t, shown] = await page.evaluate(async () => {
      const shown = (window.__BGUI__ || {}).window;
      const t = performance.now();
      return [shown ? await window.__lat.chroma({ x: 700, y: 300, w: 200, h: 120 }) : 0, t, shown];
    });
    if (shown && firstFrameAt === null) firstFrameAt = t;
    if (c > 25) { splashAt = t; break; }
    await sleep(50);
  }
}
await sleep(500);
const box = await page.locator("#canvas").boundingBox();
const at = (x, y) => [box.x + x, box.y + y];
await page.mouse.move(...at(800, 470));
await sleep(300);
await setProbes([{ x: 600, y: 300, w: 400, h: 200 }]);
await sleep(200);
await snapshot();
await page.keyboard.press("Escape");
const tEsc = await lastInput("keydown");
const sceneAt = await waitChange(tEsc, 0, 2, 20000);
const startup = {
  page_ready_ms: tReady - tNav,
  launch_to_first_frame_ms: firstFrameAt && tLaunch ? Math.round(firstFrameAt - tLaunch) : null,
  launch_to_splash_ms: splashAt && tLaunch ? Math.round(splashAt - tLaunch) : null,
  esc_to_scene_ms: sceneAt ? Math.round(sceneAt - tEsc) : null,
  // Startup as a user sees it: until the splash can be dismissed, plus the
  // dismissal's own latency (the harness waits ~1 s in between).
  startup_ms: splashAt && sceneAt && tLaunch ? Math.round(splashAt - tLaunch + (sceneAt - tEsc)) : null,
};
console.log("STARTUP " + JSON.stringify(startup));
await sleep(2000);

// --- actions ---------------------------------------------------------------
const CUBE = { x: 560, y: 340, w: 200, h: 200 };
const actions = [
  { name: "file_menu_open", probe: { x: 20, y: 40, w: 160, h: 120 }, input: "mousedown",
    act: async () => page.mouse.click(...at(40, 12)), undo: async () => { await page.keyboard.press("Escape"); } },
  { name: "add_menu_shift_a", probe: { x: 820, y: 420, w: 160, h: 120 }, input: "keydown",
    pre: async () => page.mouse.move(...at(800, 470)),
    act: async () => page.keyboard.press("Shift+A"), undo: async () => { await page.keyboard.press("Escape"); } },
  { name: "select_all_a", probe: CUBE, input: "keydown", pre: async () => { await page.mouse.move(...at(800, 470)); await page.keyboard.press("Alt+A"); await sleep(600); },
    act: async () => page.keyboard.press("a"), undo: async () => {} },
  { name: "edit_mode_tab", probe: CUBE, input: "keydown", pre: async () => page.mouse.move(...at(800, 470)),
    act: async () => page.keyboard.press("Tab"), undo: async () => { await page.keyboard.press("Tab"); } },
  { name: "wireframe_toggle", probe: CUBE, input: "keydown", pre: async () => page.mouse.move(...at(800, 470)),
    act: async () => page.keyboard.press("Shift+Z"), undo: async () => { await page.keyboard.press("Shift+Z"); } },
  { name: "grab_move", probe: CUBE, input: "mousemove",
    pre: async () => { await page.mouse.move(...at(655, 450)); await page.keyboard.press("a"); await sleep(400); await page.keyboard.press("g"); await sleep(400); },
    act: async () => page.mouse.move(...at(715, 430)), undo: async () => { await page.keyboard.press("Escape"); } },
  { name: "orbit_mmb_drag", probe: { x: 450, y: 250, w: 500, h: 400 }, thresh: 0.5, input: "mousemove",
    pre: async () => { await page.mouse.move(...at(900, 600)); await page.mouse.down({ button: "middle" }); await sleep(300); },
    act: async () => page.mouse.move(...at(960, 600)),
    undo: async () => { await page.mouse.move(...at(900, 600), { steps: 4 }); await page.mouse.up({ button: "middle" }); } },
  { name: "zoom_wheel", probe: { x: 450, y: 250, w: 500, h: 400 }, thresh: 0.5, input: "wheel",
    pre: async () => page.mouse.move(...at(900, 600)),
    act: async () => page.mouse.wheel(0, -120), undo: async () => { await page.mouse.wheel(0, 120); } },
];
const results = {};
// PROFILE_ACTION=<name>: CPU-profile the page's main thread (wink's driver
// thread) across that action's runs and print its top self-time functions.
const cdp = await page.context().newCDPSession(page);
for (const a of actions) {
  const prof = process.env.PROFILE_ACTION === a.name;
  if (process.env.COUNT_GPU) await page.evaluate(() => { for (const k in window.__gpucount) delete window.__gpucount[k]; });
  if (prof) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start"); }
  const lat = [], stages = [];
  for (let r = 0; r < RUNS; r++) {
    await setProbes([a.probe]);
    if (a.pre) await a.pre();
    await sleep(700);                    // let the screen settle
    await snapshot();
    await page.evaluate(() => { window.__lat.inputs.length = 0; });
    await a.act();
    await sleep(50);
    const t0 = await lastInput(a.input);
    const t1 = t0 !== undefined ? await waitChange(t0, 0, a.thresh ?? 2, 5000) : null;
    lat.push(t1 !== null ? Math.round(t1 - t0) : null);
    // LATTRACE builds: where the time went, from the stage rings GHOST keeps.
    if (t1 !== null) {
      const st = await page.evaluate(([t0, t1]) => {
        const M = window.Module;
        if (!M || !M._blender_lat_rings) return null;
        const R = new Float64Array(M.HEAPU8.buffer, M._blender_lat_rings(), 4 * 64);
        const I = new Int32Array(M.HEAPU8.buffer, M._blender_lat_idxs(), 4);
        const o = performance.timeOrigin, e = o + t0, p = o + t1;
        const ring = (ch) => { const out = []; const n = I[ch]; for (let k = Math.max(0, n - 64); k < n; k++) out.push(R[ch * 64 + (k & 63)]); return out; };
        const after = (ch, t) => ring(ch).find((x) => x >= t);
        const recv = after(0, e - 1);
        const step = recv && after(1, recv);
        // The swap whose frame changed the screen: the last one entered before the photon.
        const sw = ring(2).filter((x) => x < p && x >= (step ?? e)).shift();
        const ret = sw && after(3, sw);
        const r = (x) => (x === undefined ? null : Math.round(x));
        // The swap on main for that frame: the first after the worker's swap.
        const ms = sw && window.__swaps.find((x) => x.t + o >= sw);
        return { recv: r(recv - e), step: r(step - recv), draw: r(sw - step),
                 main_first: ms && ms.first ? r(ms.first + o - sw) : null,
                 main_swap: ms ? r(ms.t + o - sw) : null, photon: ms ? r(p - (ms.t + o)) : null };
      }, [t0, t1]);
      if (st) stages.push(st);
    }
    await sleep(300);
    await a.undo();
    await sleep(800);
  }
  const ok = lat.filter((x) => x !== null).sort((x, y) => x - y);
  results[a.name] = { samples: lat, median: ok.length ? ok[Math.floor(ok.length / 2)] : null,
                      min: ok[0] ?? null, max: ok.at(-1) ?? null, missed: lat.length - ok.length };
  console.log("ACTION " + a.name + " " + JSON.stringify(results[a.name]));
  if (stages.length) console.log("  STAGES " + JSON.stringify(stages));
  if (process.env.COUNT_GPU) {
    const c = await page.evaluate(() => window.__gpucount);
    const h = await page.evaluate(() => { const h = window.__gpuhist || {}; window.__gpuhist = {}; return h; });
    for (const [k, n] of Object.entries(h).sort((x, y) => y[1] - x[1]).slice(0, 14)) console.log(`    HIST ${n} ${k}`);
    console.log("  GPUCOUNT " + Object.entries(c).sort((x, y) => y[1][1] - x[1][1]).slice(0, 25)
      .map(([k, [n, ms]]) => `${k} ${n}x ${ms.toFixed(1)}ms`).join(" | "));
  }
  if (prof) {
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const counts = new Map();
    profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (profile.timeDeltas[i] || 0)));
    let total = 0;
    for (const [id, us] of counts) {
      const f = byId.get(id).callFrame.functionName || "(anon)";
      if (f === "(idle)" || f === "(program)") continue;
      self.set(f, (self.get(f) || 0) + us); total += us;
    }
    console.log(`  PROFILE busy ${(total / 1000).toFixed(0)} ms`);
    for (const [f, us] of [...self].sort((x, y) => y[1] - x[1]).slice(0, 40))
      console.log(`    ${(us / 1000).toFixed(1).padStart(8)} ms  ${f}`);
  }
}
console.log(`DONE errs=${errs}`);
await browser.close();
srv.kill();
