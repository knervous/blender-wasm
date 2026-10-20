/* Headless Blender, compiled to WebAssembly, running in this tab. One call runs
 * a Python script against an optional .blend and returns what it printed and
 * every file it wrote under /out.
 *
 * The runtime is public/blender-runtime/ (`npm run blender`). The page compiles
 * blender.wasm and fetches the data package once; each run gets a fresh worker
 * fed that compiled module, because Blender's main() never returns and an
 * instance is good for one run.
 */
import type { BlenderJob, BlenderRunner, BlenderSession } from "../../../sdk/project/index.ts";

export const COMPLETION_MARKER = "<<<BLENDER_RUN_COMPLETE>>>";
const ERROR_MARKER = "<<<BLENDER_PYTHON_ERROR>>>";

/* Same wrapper as the Node API's runPython: the user script runs from a file,
 * a traceback is fenced by ERROR_MARKER, and the marker always ends the run. */
const WRAPPER = [
  "import sys, traceback",
  "try:",
  "    exec(compile(open('/job/user.py').read(), '<editor>', 'exec'), {'__name__': '__main__'})",
  "except BaseException:",
  `    print(${JSON.stringify(ERROR_MARKER)})`,
  "    traceback.print_exc(file=sys.stdout)",
  "finally:",
  `    print(${JSON.stringify(COMPLETION_MARKER)}, flush=True)`,
  "",
].join("\n");

const encoder = new TextEncoder();

export class BlenderPythonError extends Error {
  readonly traceback: string;
  readonly output: string;

  constructor(traceback: string, output: string) {
    super(traceback.trim().split("\n").at(-1) ?? "Blender Python error");
    this.traceback = traceback;
    this.output = output;
  }
}

function checkOutput(output: string): void {
  const at = output.indexOf(ERROR_MARKER);
  if (at >= 0) {
    throw new BlenderPythonError(output.slice(at + ERROR_MARKER.length, output.indexOf(COMPLETION_MARKER, at)), output);
  }
}

/** The installed runtime's manifest, or null when none is installed. */
export interface RuntimeManifest {
  forkRevision: string;
  wasmOpt: string;
}

export async function runtimeInstalled(): Promise<RuntimeManifest | null> {
  try {
    const response = await fetch("blender-runtime/manifest.json", { cache: "no-store" });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** `run({ code, blendFile, files, onLine })`; `onLine` receives Blender's output as it prints. */
export function createBlender({ onProgress = (_text: string) => {} } = {}): BlenderRunner {
  const runtimeUrl = new URL("blender-runtime/", document.baseURI).href;
  let assets: Promise<{ wasmModule: WebAssembly.Module; dataPackage: ArrayBuffer }> | undefined;
  const load = () => (assets ??= (async () => {
    onProgress("compiling blender.wasm (once per page)");
    const [wasmModule, dataPackage] = await Promise.all([
      WebAssembly.compileStreaming(fetch(runtimeUrl + "blender.wasm")),
      fetch(runtimeUrl + "blender.data").then((r) => r.arrayBuffer()),
    ]);
    return { wasmModule, dataPackage };
  })());

  return {
    async run({ code, blendFile, files, onLine = () => {} }) {
      const { wasmModule, dataPackage } = await load();
      const staged = { ...files, "/job/main.py": encoder.encode(WRAPPER), "/job/user.py": encoder.encode(code) };
      const worker = new Worker(new URL("blender-worker.js", document.baseURI));
      try {
        const result = await new Promise<{ output: string; files: Record<string, Uint8Array> }>((resolve, reject) => {
          worker.onerror = (event) => reject(new Error(event.message || "Blender worker failed"));
          worker.onmessage = ({ data }) => {
            if (data.type === "line") onLine(data.text);
            else if (data.type === "done") resolve(data);
            else if (data.type === "error") reject(Object.assign(new Error(data.message), { output: data.output }));
          };
          worker.postMessage({
            runtimeUrl,
            wasmModule,
            // The worker's module consumes its copy; the page keeps the original.
            dataPackage: dataPackage.slice(0),
            args: ["--background", "--factory-startup", ...(blendFile ? [blendFile] : []), "--python", "/job/main.py"],
            files: staged,
            collect: "/out",
            marker: COMPLETION_MARKER,
          });
        });
        checkOutput(result.output);
        return { output: result.output, files: result.files };
      } finally {
        // main() never returns; terminating reclaims the module and its pthreads.
        worker.terminate();
      }
    },
  };
}

/**
 * A persistent Blender in one worker (public/blender-session-worker.js), booted
 * once with protocol.py in server mode. Requests then cost only their own work.
 * If the worker dies (an abort), the next request boots a new one; the session
 * scene is lost with it, so callers should reopen their .blend.
 */
export function createBlenderSession({
  server,
  onProgress = (_text: string) => {},
}: { server: string; onProgress?: (text: string) => void }): BlenderSession & {
  boot(): Promise<void>;
  /** Boot phases in ms: fetch + compile of the module and data, then Blender's own start. */
  bootMs: number;
  compileMs: number;
  startMs: number;
} {
  const runtimeUrl = new URL("blender-runtime/", document.baseURI).href;
  type Pending = { resolve: (r: { output: string; files: Record<string, Uint8Array> }) => void; reject: (e: Error) => void; onLine?: (line: string) => void };
  let worker: Worker | null = null;
  let booting: Promise<void> | null = null;
  const pending = new Map<string, Pending>();
  let nextId = 0;
  let current: string | null = null;

  const session = {
    bootMs: 0,
    compileMs: 0,
    startMs: 0,
    boot(): Promise<void> {
      booting ??= (async () => {
        const started = performance.now();
        onProgress("compiling blender.wasm and starting Blender (once)");
        const [wasmModule, dataPackage] = await Promise.all([
          WebAssembly.compileStreaming(fetch(runtimeUrl + "blender.wasm")),
          fetch(runtimeUrl + "blender.data").then((r) => r.arrayBuffer()),
        ]);
        session.compileMs = performance.now() - started;
        const w = new Worker(new URL("blender-session-worker.js", document.baseURI));
        worker = w;
        await new Promise<void>((resolve, reject) => {
          w.onmessage = ({ data }) => {
            if (data.type === "ready") {
              session.bootMs = performance.now() - started;
              session.startMs = session.bootMs - session.compileMs;
              resolve();
            }
            else if (data.type === "line") { if (current) pending.get(current)?.onLine?.(data.text); }
            else if (data.type === "response") {
              const entry = pending.get(data.id);
              pending.delete(data.id);
              current = pending.keys().next().value ?? null;
              entry?.resolve({ output: data.output, files: data.files });
            } else if (data.type === "fatal") {
              const error = new Error(data.message);
              for (const entry of pending.values()) entry.reject(error);
              pending.clear();
              w.terminate();
              worker = null;
              booting = null;
              reject(error);
            }
          };
          w.postMessage({ type: "boot", runtimeUrl, wasmModule, dataPackage, server }, [dataPackage]);
        });
      })();
      return booting;
    },
    async request(request: {
      job: BlenderJob;
      files: Record<string, Uint8Array>;
      load?: { kind: "factory" | "empty" } | { kind: "blend"; bytes: Uint8Array };
      save?: boolean;
      onLine?: (line: string) => void;
    }): Promise<{ output: string; files: Record<string, Uint8Array> }> {
      await session.boot();
      const id = String(++nextId);
      const blend = request.load?.kind === "blend" ? request.load.bytes : undefined;
      const load = request.load && request.load.kind !== "blend" ? request.load : undefined;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onLine: request.onLine });
        current ??= id;
        worker?.postMessage({
          type: "request",
          id,
          request: { job: request.job, save: Boolean(request.save), ...(load ? { load } : {}) },
          files: request.files,
          blend,
        });
      });
    },
  };
  return session;
}
