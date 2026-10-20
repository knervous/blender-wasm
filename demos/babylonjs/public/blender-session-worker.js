/* A persistent headless Blender in a dedicated worker (classic: the emscripten
 * glue is loaded with importScripts).
 *
 * Booted once with sdk/project/protocol.py in server mode; afterwards each
 * request is a file handed through the module FS and costs only its own work:
 * no module instantiation, no Python start, no .blend load or save unless the
 * request asks.
 *
 * in:  { type: "boot", runtimeUrl, wasmModule, dataPackage, server }
 *      { type: "request", id, request, files, blend? }
 * out: { type: "ready" } | { type: "line", text }
 *      { type: "response", id, files, output } | { type: "fatal", message }
 *
 * Response files are keyed as a one-shot run writes them (/out/report.json,
 * /out/geo/<id>.bin, /out/session.blend), so the page decodes both the same way.
 */
let FS = null;
let ready = false;
const queue = [];
let current = null; // { id, lines }

function mkdirp(dir) {
  let path = "";
  for (const part of dir.split("/").filter(Boolean)) {
    path += "/" + part;
    try { FS.mkdir(path); } catch { /* exists */ }
  }
}

function collect(dir, prefix, out) {
  let names = [];
  try { names = FS.readdir(dir).filter((n) => n !== "." && n !== ".."); } catch { return; }
  for (const name of names) {
    const full = `${dir}/${name}`;
    if (FS.isDir(FS.stat(full).mode)) {
      collect(full, `${prefix}/${name}`, out);
      FS.rmdir(full);
    } else {
      out[`${prefix}/${name}`] = FS.readFile(full);
      FS.unlink(full);
    }
  }
}

function removeTree(dir) {
  let names = [];
  try { names = FS.readdir(dir).filter((n) => n !== "." && n !== ".."); } catch { return; }
  for (const name of names) {
    const full = `${dir}/${name}`;
    if (FS.isDir(FS.stat(full).mode)) { removeTree(full); FS.rmdir(full); } else FS.unlink(full);
  }
}

function next() {
  if (!ready || current || queue.length === 0) return;
  const { id, request, files, blend } = queue.shift();
  current = { id, lines: [] };
  for (const [path, bytes] of Object.entries(files)) {
    mkdirp(path.slice(0, path.lastIndexOf("/")));
    FS.writeFile(path, bytes);
  }
  if (blend) {
    FS.writeFile("/ipc/in.blend", blend);
    request.load = { kind: "blend", path: "/ipc/in.blend" };
  }
  // Written then renamed, so the server never reads a half-written request.
  FS.writeFile("/ipc/request.tmp", JSON.stringify({ id, ...request }));
  FS.rename("/ipc/request.tmp", "/ipc/request.json");
}

function finish(id) {
  if (!current || current.id !== id) return;
  const out = {};
  collect(`/ipc/out/${id}`, "/out", out);
  try { FS.rmdir(`/ipc/out/${id}`); } catch { /* already gone */ }
  removeTree("/job");
  const output = current.lines.join("\n");
  current = null;
  self.postMessage({ type: "response", id, files: out, output }, Object.values(out).map((b) => b.buffer));
  next();
}

function print(text) {
  if (text.includes("<<<BW_READY>>>")) {
    ready = true;
    self.postMessage({ type: "ready" });
    next();
    return;
  }
  const done = text.match(/<<<BW_DONE (\S+)>>>/);
  if (done) {
    finish(done[1]);
    return;
  }
  if (current) current.lines.push(text);
  self.postMessage({ type: "line", text });
}

self.onmessage = ({ data }) => {
  if (data.type === "request") {
    queue.push(data);
    next();
    return;
  }
  if (data.type !== "boot") return;
  const { runtimeUrl, wasmModule, dataPackage, server } = data;
  const fatal = (message) => self.postMessage({ type: "fatal", message: String(message) });
  try {
    importScripts(runtimeUrl + "blender.js");
    // eslint-disable-next-line no-undef
    createBlenderModule({
      arguments: ["--background", "--factory-startup", "--python", "/ipc/server.py"],
      mainScriptUrlOrBlob: runtimeUrl + "blender.js",
      locateFile: (path) => runtimeUrl + path,
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(wasmModule, imports).then((instance) => done(instance, wasmModule), fatal);
        return {};
      },
      getPreloadedPackage: () => dataPackage,
      print,
      printErr: print,
      preRun: [(module) => {
        FS = module.FS;
        module.ENV.BLENDER_SYSTEM_RESOURCES = "/5.3";
        module.ENV.HOME = "/tmp";
        mkdirp("/ipc/out");
        FS.writeFile("/ipc/server.py", "BW_SERVER = True\n" + server);
      }],
      onAbort: (what) => fatal(`Blender aborted: ${what}`),
    }).catch(fatal);
  } catch (error) {
    fatal(error && error.stack || error);
  }
};
