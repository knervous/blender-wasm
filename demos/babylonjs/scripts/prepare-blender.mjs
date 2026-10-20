#!/usr/bin/env node
/**
 * Makes the core blender-wasm runtimes available to this demo.
 *
 *   node scripts/prepare-blender.mjs browser node   # both (npm run blender)
 *   node scripts/prepare-blender.mjs node --rebuild # force ../../build.sh node
 *
 * For each flavour it reuses ../../dist/blender-wasm-<flavour>/ when present and
 * otherwise runs ../../build.sh <flavour> (a from-scratch build takes hours;
 * later runs only redo what changed).
 *
 * browser: copied to public/blender-runtime/ with blender.wasm and blender.data
 *          inflated, so the page can stream-compile the module and hand the
 *          data package to each run without a JS zstd decoder.
 * node:    used in place by the dev server (vite.config.js) — nothing to copy.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const demo = resolve(here, "..");
const repo = resolve(demo, "../..");
const args = process.argv.slice(2);
const rebuild = args.includes("--rebuild");
const flavours = args.filter((arg) => !arg.startsWith("--"));
if (flavours.length === 0 || flavours.some((f) => f !== "browser" && f !== "node")) {
  console.error("usage: prepare-blender.mjs <browser|node>... [--rebuild]");
  process.exit(2);
}

const packageDir = (flavour) => process.env[`BLENDER_WASM_${flavour.toUpperCase()}_DIR`]
  ?? join(repo, "dist", `blender-wasm-${flavour}`);

for (const flavour of flavours) {
  const dir = packageDir(flavour);
  if (rebuild || !existsSync(join(dir, "manifest.json"))) {
    console.log(`[blender] building the ${flavour} runtime: ${repo}/build.sh ${flavour}`);
    const result = spawnSync(join(repo, "build.sh"), [flavour], {
      stdio: "inherit",
      env: rebuild ? { ...process.env, FORCE: "1" } : process.env,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  console.log(`[blender] ${flavour}: ${dir} (fork ${manifest.forkRevision}, wasm-opt ${manifest.wasmOpt})`);

  if (flavour === "browser") {
    const out = join(demo, "public", "blender-runtime");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    copyFileSync(join(dir, "blender.js"), join(out, "blender.js"));
    for (const name of ["blender.wasm", "blender.data"]) {
      writeFileSync(join(out, name), zstdDecompressSync(readFileSync(join(dir, `${name}.zst`))));
    }
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(`[blender] browser runtime installed in ${out}`);
  }
}
