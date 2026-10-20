/* Headless Blender, compiled to WebAssembly, running in this tab. One call runs
 * a Python script against an optional .blend and returns what it printed and
 * every file it wrote under /out.
 *
 * The runtime is public/blender-runtime/ (`npm run blender`). The page compiles
 * blender.wasm and fetches the data package once; each run gets a fresh worker
 * fed that compiled module, because Blender's main() never returns and an
 * instance is good for one run.
 */
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
  constructor(traceback, output) {
    super(traceback.trim().split("\n").at(-1) ?? "Blender Python error");
    this.traceback = traceback;
    this.output = output;
  }
}

function checkOutput(output) {
  const at = output.indexOf(ERROR_MARKER);
  if (at >= 0) {
    throw new BlenderPythonError(output.slice(at + ERROR_MARKER.length, output.indexOf(COMPLETION_MARKER, at)), output);
  }
}

/** The installed runtime's manifest, or null when none is installed. */
export async function runtimeInstalled() {
  try {
    const response = await fetch("blender-runtime/manifest.json", { cache: "no-store" });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** `run({ code, blendFile, files, onLine })`; `onLine` receives Blender's output as it prints. */
export function createBlender({ onProgress = () => {} } = {}) {
  const runtimeUrl = new URL("blender-runtime/", document.baseURI).href;
  let assets;
  const load = () => (assets ??= (async () => {
    onProgress("compiling blender.wasm (once per page)");
    const [wasmModule, dataPackage] = await Promise.all([
      WebAssembly.compileStreaming(fetch(runtimeUrl + "blender.wasm")),
      fetch(runtimeUrl + "blender.data").then((r) => r.arrayBuffer()),
    ]);
    return { wasmModule, dataPackage };
  })());

  return {
    async run({ code, blendFile, files = {}, onLine = () => {} }) {
      const { wasmModule, dataPackage } = await load();
      const staged = { ...files, "/job/main.py": encoder.encode(WRAPPER), "/job/user.py": encoder.encode(code) };
      const worker = new Worker(new URL("blender-worker.js", document.baseURI));
      try {
        const result = await new Promise((resolve, reject) => {
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
