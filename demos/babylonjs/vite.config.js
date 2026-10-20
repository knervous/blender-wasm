import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const nodeRuntime = process.env.BLENDER_WASM_NODE_DIR ?? resolve(here, "../../dist/blender-wasm-node");
const browserRuntime = join(here, "public", "blender-runtime", "blender.js");

/* Blender's pthreads need SharedArrayBuffer, which needs cross-origin isolation. */
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * Dev-server Blender: runs the Node runtime (../../dist/blender-wasm-node) for
 * the page when the browser runtime is not installed, or when the page asks
 * for it. One Blender process per request, queued so runs never overlap.
 *
 *   GET  /api/blender/status  -> { node: boolean, browser: boolean }
 *   POST /api/blender/run     { code, blendFile?, files: { path: base64 } }
 *                          -> { output, files: { path: base64 } } | { error, output }
 */
function blenderDevServer() {
  let api;
  let queue = Promise.resolve();
  const load = async () => (api ??= await import(pathToFileURL(join(nodeRuntime, "index.mjs")).href));

  const readJson = (request) => new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
  const send = (response, status, body) => {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  };

  return {
    name: "blender-dev-server",
    configureServer(server) {
      server.middlewares.use("/api/blender/status", (_request, response) => {
        send(response, 200, {
          node: existsSync(join(nodeRuntime, "manifest.json")),
          browser: existsSync(browserRuntime),
        });
      });
      server.middlewares.use("/api/blender/run", async (request, response) => {
        if (request.method !== "POST") return send(response, 405, { error: "POST only" });
        let job;
        try { job = await readJson(request); } catch { return send(response, 400, { error: "bad JSON" }); }
        const run = queue.then(async () => {
          const { runPython } = await load();
          const files = {};
          for (const [path, base64] of Object.entries(job.files ?? {})) files[path] = Buffer.from(base64, "base64");
          return runPython(job.code, { files, collect: "/out", ...(job.blendFile ? { blendFile: job.blendFile } : {}) });
        });
        queue = run.catch(() => {});
        try {
          const result = await run;
          const files = {};
          for (const [path, bytes] of Object.entries(result.files)) files[path] = Buffer.from(bytes).toString("base64");
          send(response, 200, { output: result.output, files });
        } catch (error) {
          send(response, 200, { error: error.message, output: error.output ?? "" });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [blenderDevServer()],
  server: { port: 5321, headers: isolation },
  preview: { headers: isolation },
  build: { target: "esnext" },
  worker: { format: "es" },
});
