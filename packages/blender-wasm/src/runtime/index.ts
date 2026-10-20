/**
 * Puts the browser runtime where pages are served (Node, build time).
 *
 * The binaries ship in @knervous/blender-wasm-runtime (a peer dependency),
 * brotli-compressed. A served runtime directory holds:
 *
 *   blender.js            emscripten glue, unmodified (pthread workers load it)
 *   blender.wasm          inflated, for servers that do not negotiate encodings
 *   blender.data          inflated
 *   blender.wasm.br       the same bytes for `Content-Encoding: br` (optional)
 *   blender.data.br
 *   session-worker.js     this package's workers (classic: they importScripts
 *   run-worker.js         the glue)
 *   manifest.json         written last: its presence means the copy is complete
 *
 * Every file is checked against the runtime manifest's sha256.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

export const RUNTIME_PACKAGE = "@knervous/blender-wasm-runtime";
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKERS = ["session-worker.js", "run-worker.js"];

interface FileDigest { bytes: number; sha256: string }
export interface RuntimePackageManifest {
  flavor: string;
  forkRevision: string;
  blenderRevision?: string;
  emsdk?: string;
  wasmOpt: string;
  files: Record<string, FileDigest>;
  raw: Record<string, FileDigest>;
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/**
 * The installed runtime package's directory. Looks from `from` (a project
 * root; the app's own node_modules first), then from this package.
 */
export function resolveRuntimeDir(options: { from?: string; runtimeDir?: string } = {}): string {
  if (options.runtimeDir) return resolve(options.runtimeDir);
  const bases = [options.from && join(resolve(options.from), "package.json"), import.meta.url].filter(Boolean);
  for (const base of bases) {
    try {
      return dirname(createRequire(String(base)).resolve(`${RUNTIME_PACKAGE}/manifest.json`));
    } catch { /* next */ }
  }
  throw new Error(`${RUNTIME_PACKAGE} is not installed (npm install ${RUNTIME_PACKAGE}), or pass runtimeDir`);
}

export function readRuntimeManifest(runtimeDir: string): RuntimePackageManifest {
  return JSON.parse(readFileSync(join(runtimeDir, "manifest.json"), "utf8"));
}

export interface InstallOptions {
  /** The directory to fill (e.g. public/blender-runtime). */
  dest: string;
  /** The runtime package's directory; resolved from `from` when omitted. */
  runtimeDir?: string;
  from?: string;
  /** Also write the .br files, for servers that send them with Content-Encoding (default true). */
  compressed?: boolean;
  log?: (line: string) => void;
}

/** Fills `dest` with a servable runtime; skips when it already holds this one. */
export function installRuntime(options: InstallOptions): { dest: string; manifest: RuntimePackageManifest; skipped: boolean } {
  const runtimeDir = resolveRuntimeDir(options);
  const manifest = readRuntimeManifest(runtimeDir);
  const dest = resolve(options.dest);
  const compressed = options.compressed ?? true;
  const workerSources = WORKERS.map((name) => join(HERE, "../browser", name));
  const stamp = JSON.stringify({ ...manifest, workers: workerSources.map((p) => sha256(readFileSync(p))), compressed });
  const stampPath = join(dest, ".blender-wasm-stamp");
  const complete = existsSync(join(dest, "manifest.json")) && existsSync(stampPath)
    && readFileSync(stampPath, "utf8") === stamp
    && Object.entries(manifest.raw).every(([name, d]) => existsSync(join(dest, name)) && statSync(join(dest, name)).size === d.bytes);
  if (complete) return { dest, manifest, skipped: true };

  mkdirSync(dest, { recursive: true });
  const write = (name: string, data: Uint8Array): void => {
    // Written aside then renamed, so a server never sends a half-written file.
    writeFileSync(join(dest, `${name}.tmp`), data);
    renameSync(join(dest, `${name}.tmp`), join(dest, name));
  };
  const read = (name: string): Buffer => {
    const data = readFileSync(join(runtimeDir, name));
    const expected = manifest.files[name];
    if (expected && sha256(data) !== expected.sha256) throw new Error(`${name} in ${runtimeDir} does not match its manifest`);
    return data;
  };
  for (const [name, expected] of Object.entries(manifest.raw)) {
    const packed = read(`${name}.br`);
    const data = brotliDecompressSync(packed);
    if (sha256(data) !== expected.sha256) throw new Error(`${name}.br inflates to the wrong bytes`);
    write(name, data);
    if (compressed) write(`${name}.br`, packed);
    options.log?.(`${name}: ${(data.byteLength / 1048576).toFixed(1)} MB${compressed ? ` (+ .br ${(packed.byteLength / 1048576).toFixed(1)} MB)` : ""}`);
  }
  write("blender.js", read("blender.js"));
  WORKERS.forEach((name, i) => write(name, readFileSync(workerSources[i])));
  write("LICENSE", read("LICENSE"));
  write("manifest.json", readFileSync(join(runtimeDir, "manifest.json")));
  writeFileSync(stampPath, stamp);
  return { dest, manifest, skipped: false };
}

/** Content types a runtime directory needs (compileStreaming insists on application/wasm). */
export const RUNTIME_CONTENT_TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".js": "text/javascript",
  ".json": "application/json",
};

/** Headers that make a page cross-origin isolated (SharedArrayBuffer, so pthreads). */
export const CROSS_ORIGIN_ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;
