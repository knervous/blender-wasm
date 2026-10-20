#!/usr/bin/env node
/**
 * Installs the core blender-wasm browser runtime into public/blender-runtime/.
 *
 *   node scripts/prepare-blender.mjs            # npm run blender
 *   node scripts/prepare-blender.mjs --rebuild  # force ../../build.sh browser
 *
 * Reuses ../../dist/blender-wasm-browser/ when present, otherwise runs
 * ../../build.sh browser (a from-scratch build takes hours; later runs only redo
 * what changed). blender.wasm and blender.data are inflated from their .zst
 * copies so the page can stream-compile the module without a JS zstd decoder.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const demo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(demo, "../..");
const rebuild = process.argv.includes("--rebuild");
const dir = process.env.BLENDER_WASM_BROWSER_DIR ?? join(repo, "dist", "blender-wasm-browser");

if (rebuild || !existsSync(join(dir, "manifest.json"))) {
  console.log(`[blender] building the browser runtime: ${repo}/build.sh browser`);
  const result = spawnSync(join(repo, "build.sh"), ["browser"], {
    stdio: "inherit",
    env: rebuild ? { ...process.env, FORCE: "1" } : process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const out = join(demo, "public", "blender-runtime");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(dir, "blender.js"), join(out, "blender.js"));
for (const name of ["blender.wasm", "blender.data"]) {
  writeFileSync(join(out, name), zstdDecompressSync(readFileSync(join(dir, `${name}.zst`))));
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`[blender] browser runtime ${manifest.forkRevision} (wasm-opt ${manifest.wasmOpt}) installed in ${out}`);
