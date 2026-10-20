/* Headless Blender, from the page's point of view: one call runs a Python
 * script against an optional .blend and returns what it printed and every file
 * it wrote under /out.
 *
 * Two backends answer the same call:
 *   browser  the browser runtime (public/blender-runtime/, `npm run blender:browser`)
 *            in a worker per run; the wasm is compiled and the data package
 *            fetched once per page.
 *   server   the Node runtime (`npm run blender:node`) behind the dev server's
 *            /api/blender/run.
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

export async function availableBackends() {
  try {
    const status = await (await fetch("/api/blender/status")).json();
    return { browser: status.browser, server: status.node };
  } catch {
    // Static hosting (vite build): only the browser runtime can exist.
    const browser = (await fetch("blender-runtime/blender.js", { method: "HEAD" })).ok;
    return { browser, server: false };
  }
}

/** In-browser backend. `onLine` receives Blender's output as it prints. */
export function browserBackend({ onProgress = () => {} } = {}) {
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
    name: "browser",
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

const toBase64 = (bytes) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Dev-server backend: the Node runtime, one process per run. */
export function serverBackend() {
  return {
    name: "server",
    async run({ code, blendFile, files = {}, onLine = () => {} }) {
      const body = { code, blendFile, files: {} };
      for (const [path, bytes] of Object.entries(files)) body.files[path] = toBase64(bytes);
      const response = await fetch("/api/blender/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      for (const line of (result.output ?? "").split("\n")) onLine(line);
      if (result.error) {
        const at = result.error.indexOf("Blender Python error:");
        if (at >= 0) throw new BlenderPythonError(result.error.slice(at + 21), result.output);
        throw Object.assign(new Error(result.error), { output: result.output });
      }
      const out = {};
      for (const [path, base64] of Object.entries(result.files)) out[path] = fromBase64(base64);
      return { output: result.output, files: out };
    },
  };
}
