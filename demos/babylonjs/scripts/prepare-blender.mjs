#!/usr/bin/env node
/**
 * Installs the two Blender runtimes this demo uses, both WebAssembly in the tab:
 *
 *   headless  public/blender-runtime/  the library Babylon drives (bpy, glTF in/out)
 *             from ../../dist/blender-wasm-browser   (../../build.sh browser)
 *   ui        public/blender-ui/       the full Blender UI on WebGPU, embedded
 *             from ../../demo/dist                    (../../build.sh web)
 *
 *   node scripts/prepare-blender.mjs                 # both (npm run blender)
 *   node scripts/prepare-blender.mjs ui              # just one
 *   node scripts/prepare-blender.mjs --rebuild       # force the builds
 *
 * Each part reuses its build output when present and otherwise runs the
 * matching ../../build.sh flavour (a from-scratch build takes hours; later runs
 * only redo what changed).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const demo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(demo, "../..");
const args = process.argv.slice(2);
const rebuild = args.includes("--rebuild");
const parts = args.filter((a) => !a.startsWith("--"));
const wanted = parts.length ? parts : ["headless", "ui"];
if (wanted.some((p) => p !== "headless" && p !== "ui")) {
  console.error("usage: prepare-blender.mjs [headless] [ui] [--rebuild]");
  process.exit(2);
}

function build(flavour) {
  console.log(`[blender] building: ${repo}/build.sh ${flavour}`);
  const result = spawnSync(join(repo, "build.sh"), [flavour], {
    stdio: "inherit",
    env: rebuild ? { ...process.env, FORCE: "1" } : process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (wanted.includes("headless")) {
  const dir = process.env.BLENDER_WASM_BROWSER_DIR ?? join(repo, "dist", "blender-wasm-browser");
  if (rebuild || !existsSync(join(dir, "manifest.json"))) build("browser");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const out = join(demo, "public", "blender-runtime");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(join(dir, "blender.js"), join(out, "blender.js"));
  // Inflated so the page can stream-compile the module without a JS zstd decoder.
  for (const name of ["blender.wasm", "blender.data"]) {
    writeFileSync(join(out, name), zstdDecompressSync(readFileSync(join(dir, `${name}.zst`))));
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[blender] headless runtime ${manifest.forkRevision} (wasm-opt ${manifest.wasmOpt}) -> ${out}`);
}

if (wanted.includes("ui")) {
  const dir = process.env.BLENDER_WASM_UI_DIR ?? join(repo, "demo", "dist");
  if (rebuild || !existsSync(join(dir, "blender.wasm.zst"))) build("web");
  // The UI loads its own compressed runtime; link the site rather than copy ~120 MB.
  const out = join(demo, "public", "blender-ui");
  rmSync(out, { recursive: true, force: true });
  symlinkSync(relative(dirname(out), dir), out, "dir");
  console.log(`[blender] Blender UI -> ${out} (links ${dir})`);
}
