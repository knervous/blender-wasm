/**
 * Node API for the headless Blender wasm runtime.
 *
 *   import { runPython } from "./index.mjs";
 *
 *   const { output, files } = await runPython(`
 *   import bpy
 *   bpy.ops.mesh.primitive_monkey_add()
 *   bpy.ops.export_scene.gltf(filepath="/out/monkey.glb")
 *   `, { collect: "/out" });
 *   // files["/out/monkey.glb"] is a Uint8Array
 *
 * Every call is one Blender process (see run-once.cjs for why). Scene state
 * does not survive between calls unless the script saves a .blend into
 * `collect` and the next call stages it back in through `files`.
 *
 * The runtime directory holds blender.js plus blender.wasm / blender.data, or
 * their .zst copies; ensureRuntime() inflates those once (Node 22.15+ has zstd
 * in node:zlib).
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

export const COMPLETION_MARKER = "<<<BLENDER_RUN_COMPLETE>>>";
export const ERROR_MARKER = "<<<BLENDER_PYTHON_ERROR>>>";

/** Directory holding blender.js and friends: BLENDER_WASM_RUNTIME_DIR or this one. */
export function defaultRuntimeDir() {
  return process.env.BLENDER_WASM_RUNTIME_DIR || HERE;
}

/**
 * Makes sure blender.wasm and blender.data exist uncompressed in `runtimeDir`,
 * inflating the .zst copies when the plain file is missing or older.
 */
export async function ensureRuntime(runtimeDir = defaultRuntimeDir()) {
  if (!existsSync(join(runtimeDir, "blender.js"))) {
    throw new Error(`blender.js not found in ${runtimeDir}`);
  }
  for (const name of ["blender.wasm", "blender.data"]) {
    const plain = join(runtimeDir, name);
    const packed = `${plain}.zst`;
    const stale = existsSync(packed)
      && (!existsSync(plain) || statSync(plain).mtimeMs < statSync(packed).mtimeMs);
    if (stale) {
      if (typeof zlib.zstdDecompressSync !== "function") {
        throw new Error(`${packed} needs Node 22.15+ (node:zlib zstd) or a manual \`zstd -d\``);
      }
      await writeFile(plain, zlib.zstdDecompressSync(await readFile(packed)));
    }
    if (!existsSync(plain)) throw new Error(`${name} not found in ${runtimeDir}`);
  }
  return runtimeDir;
}

/**
 * One Blender run with raw CLI arguments.
 *
 * @param {object} job
 * @param {string[]} job.args             Blender CLI arguments.
 * @param {Record<string, Uint8Array|string>} [job.files]  Staged into the module FS before start.
 * @param {string} [job.collect="/tmp"]   Directory harvested after the run.
 * @param {string} [job.completionMarker] Output line that ends the run.
 * @param {number} [job.initialMemoryMb]  256..2048.
 * @param {number} [job.timeoutMs=600000]
 * @param {string} [job.runtimeDir]
 * @returns {Promise<{output: string, files: Record<string, Uint8Array>}>}
 */
export async function runBlender(job) {
  const runtimeDir = await ensureRuntime(job.runtimeDir);
  const scratch = await mkdtemp(join(tmpdir(), "blender-wasm-"));
  try {
    const jobPath = join(scratch, "job.json");
    const resultPath = join(scratch, "result.json");
    const files = {};
    for (const [target, bytes] of Object.entries(job.files ?? {})) {
      files[target] = Buffer.from(bytes).toString("base64");
    }
    await writeFile(jobPath, JSON.stringify({
      args: job.args,
      files,
      collect: job.collect ?? "/tmp",
      resultPath,
      completionMarker: job.completionMarker ?? COMPLETION_MARKER,
      ...(job.initialMemoryMb ? { initialMemoryMb: job.initialMemoryMb } : {}),
    }));
    try {
      await run(process.execPath, [join(HERE, "run-once.cjs"), jobPath], {
        env: { ...process.env, BLENDER_WASM_RUNTIME_DIR: runtimeDir },
        timeout: job.timeoutMs ?? 600_000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      // run-once records its own failure in the result; fall through to read it.
      if (!existsSync(resultPath)) throw error;
    }
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    if (result.error) {
      throw Object.assign(new Error(result.error), { output: result.output });
    }
    const out = {};
    for (const [path, base64] of Object.entries(result.files)) out[path] = Buffer.from(base64, "base64");
    return { output: result.output, files: out };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Runs a Python script inside headless Blender (`--background --factory-startup`).
 * A Python exception rejects with the traceback; output and harvested files
 * come back otherwise.
 *
 * @param {string} code
 * @param {Omit<Parameters<typeof runBlender>[0], "args"> & { blendFile?: string }} [options]
 *        blendFile: a staged .blend to open before the script runs.
 */
export async function runPython(code, options = {}) {
  const wrapper = [
    "import sys, traceback",
    "try:",
    "    exec(compile(open('/job/user.py').read(), '<blender-wasm>', 'exec'), {'__name__': '__main__'})",
    "except BaseException:",
    `    print(${JSON.stringify(ERROR_MARKER)})`,
    "    traceback.print_exc(file=sys.stdout)",
    "finally:",
    `    print(${JSON.stringify(COMPLETION_MARKER)}, flush=True)`,
    "",
  ].join("\n");
  const { output, files } = await runBlender({
    ...options,
    // Blender processes arguments in order: background and factory settings
    // first, then the file to open, then the script that runs against it.
    args: [
      "--background", "--factory-startup",
      ...(options.blendFile ? [options.blendFile] : []),
      "--python", "/job/main.py",
    ],
    files: { ...options.files, "/job/main.py": wrapper, "/job/user.py": code },
  });
  const failure = output.indexOf(ERROR_MARKER);
  if (failure >= 0) {
    const traceback = output.slice(failure + ERROR_MARKER.length, output.indexOf(COMPLETION_MARKER, failure));
    throw Object.assign(new Error(`Blender Python error:${traceback}`), { output });
  }
  return { output, files };
}
