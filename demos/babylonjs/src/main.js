/* Babylon.js editor with headless Blender on the other end.
 *
 * The Blender session (.blend) is the source of truth for everything that came
 * from Blender. Babylon shows a GLB of it; moving or deleting those nodes in
 * Babylon and pressing "Push" writes the change back onto the Blender objects
 * (by name), and Blender re-exports. Anything made or loaded on the Babylon side
 * stays Babylon-only until "Send Babylon scene" exports the whole scene and
 * makes it the new Blender session.
 */
import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, GizmoManager, HemisphericLight,
  LoadAssetContainerAsync, Matrix, MeshBuilder, PointerEventTypes, Quaternion, Scene,
  SceneSerializer, StandardMaterial, TransformNode, Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders";
import { GLTF2Export } from "@babylonjs/serializers";
import { BlenderPythonError, createBlender, runtimeInstalled } from "./blender.js";
import { BLENDER_FORMATS, createSession } from "./session.js";

const $ = (id) => document.getElementById(id);
const ui = {
  runtime: $("runtime"), status: $("status"), log: $("log"), outliner: $("outliner"),
  linkState: $("link-state"), python: $("python"),
};

/* ---------------------------------------------------------------- Babylon */
const canvas = $("viewport");
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.16, 0.16, 0.17, 1);

const helper = (node) => { node.metadata = { ...node.metadata, editorHelper: true }; return node; };
const camera = helper(new ArcRotateCamera("editor-camera", -Math.PI / 3, Math.PI / 3, 12, Vector3.Zero(), scene));
camera.attachControl(canvas, true);
camera.wheelPrecision = 30;
camera.minZ = 0.05;
helper(new HemisphericLight("editor-sky", new Vector3(0, 1, 0), scene)).intensity = 0.7;
const sun = helper(new DirectionalLight("editor-sun", new Vector3(-0.5, -1, -0.3), scene));
sun.intensity = 0.8;

const gridLines = [];
for (let i = -10; i <= 10; i++) {
  gridLines.push([new Vector3(i, 0, -10), new Vector3(i, 0, 10)], [new Vector3(-10, 0, i), new Vector3(10, 0, i)]);
}
const grid = helper(MeshBuilder.CreateLineSystem("editor-grid", { lines: gridLines }, scene));
grid.color = new Color3(0.32, 0.32, 0.35);
grid.isPickable = false;

const isHelper = (node) => {
  for (let n = node; n; n = n.parent) if (n.metadata?.editorHelper) return true;
  return false;
};

/* What came from Blender: the container of the last GLB plus each node's
 * transform as loaded, to tell what moved. */
let blenderContent = null;
let loadedTransforms = new Map();
const deletedFromBlender = new Set();
let lastGlb = null;

const localMatrix = (node) => Matrix.Compose(
  node.scaling,
  node.rotationQuaternion ?? Quaternion.FromEulerVector(node.rotation),
  node.position,
);
const sameMatrix = (a, b) => a.asArray().every((v, i) => Math.abs(v - b.asArray()[i]) < 1e-5);

/* A glTF node becomes a Babylon TransformNode (or Mesh) of the same name. A
 * mesh with several primitives adds children named <node>_primitive<i>, and a
 * camera or light node holds a Babylon Camera/Light child of the same name;
 * those, and the loader's __root__ (which converts glTF's right-handed space),
 * are not objects. */
const isObjectNode = (node) => node instanceof TransformNode && !isHelper(node)
  && node.name !== "__root__" && !/_primitive\d+$/.test(node.name);
const objectNodeFor = (node) => {
  let n = node;
  while (n && !isObjectNode(n)) n = n.parent;
  return n && !isHelper(n) ? n : null;
};
const isFromBlender = (node) => blenderContent && loadedTransforms.has(node.uniqueId);
const contentNodes = () => scene.getNodes().filter((n) => isObjectNode(n) && n.getScene() === scene && !n.isDisposed());

/* ------------------------------------------------------------ selection */
const gizmos = new GizmoManager(scene);
gizmos.usePointerToAttachGizmos = false;
gizmos.positionGizmoEnabled = true;
let selected = null;
let gizmoMode = "position";

function setGizmoMode(mode) {
  gizmoMode = mode;
  gizmos.positionGizmoEnabled = mode === "position";
  gizmos.rotationGizmoEnabled = mode === "rotation";
  gizmos.scaleGizmoEnabled = mode === "scale";
  gizmos.attachToNode(selected);
  for (const b of $("gizmo-modes").children) b.classList.toggle("on", b.dataset.mode === mode);
}
function select(node) {
  selected = node;
  gizmos.attachToNode(node);
  renderOutliner();
}
scene.onPointerObservable.add((info) => {
  if (info.type !== PointerEventTypes.POINTERTAP || info.event.button !== 0) return;
  const hit = info.pickInfo?.hit ? objectNodeFor(info.pickInfo.pickedMesh) : null;
  select(hit);
});
// Gizmo drags change transforms; refresh the "moved" markers when one ends.
scene.onPointerObservable.add((info) => { if (info.type === PointerEventTypes.POINTERUP) renderOutliner(); });

function renderOutliner() {
  ui.outliner.replaceChildren();
  const depth = (node) => { let d = 0; for (let n = node.parent; n; n = n.parent) if (isObjectNode(n)) d++; return d; };
  for (const node of contentNodes()) {
    const li = document.createElement("li");
    li.style.paddingLeft = `${6 + depth(node) * 14}px`;
    li.textContent = node.name;
    const kind = document.createElement("span");
    kind.className = "kind";
    const moved = isFromBlender(node) && !sameMatrix(localMatrix(node), loadedTransforms.get(node.uniqueId));
    kind.textContent = `${node.getClassName()}${moved ? " · moved" : ""}`;
    li.append(kind);
    if (!isFromBlender(node)) li.classList.add("babylon-only");
    if (node === selected) li.classList.add("selected");
    li.onclick = () => select(node);
    ui.outliner.append(li);
  }
  const babylonOnly = contentNodes().filter((n) => !isFromBlender(n) && !(n.parent && isObjectNode(n.parent))).length;
  ui.linkState.textContent = blenderContent
    ? `${loadedTransforms.size} node(s) mirror the Blender session${babylonOnly ? `; ${babylonOnly} Babylon-only (Send to include them)` : ""}.`
    : "Nothing from Blender yet.";
}

/* -------------------------------------------------------------- loading */
async function showBlenderScene(glb) {
  const keep = selected && isFromBlender(selected) ? selected.name : null;
  const container = await LoadAssetContainerAsync(glb, scene, { pluginExtension: ".glb", name: "blender.glb" });
  blenderContent?.dispose();
  blenderContent = container;
  container.addAllToScene();
  scene.activeCamera = camera; // the scene's own cameras stay available, the editor keeps its view
  for (const light of container.lights) light.setEnabled($("blender-lights").checked);
  lastGlb = glb;
  deletedFromBlender.clear();
  loadedTransforms = new Map();
  for (const node of [...container.transformNodes, ...container.meshes]) {
    if (isObjectNode(node)) loadedTransforms.set(node.uniqueId, localMatrix(node));
  }
  select(keep ? contentNodes().find((n) => n.name === keep && isFromBlender(n)) ?? null : null);
}

async function openInBabylon(file) {
  const name = file.name;
  const ext = name.split(".").pop().toLowerCase();
  // A File, not its bytes: the text formats (.babylon, .gltf, .obj, .usda)
  // refuse an ArrayBufferView source.
  const container = await LoadAssetContainerAsync(file, scene, { pluginExtension: `.${ext}`, name });
  container.addAllToScene();
  scene.activeCamera = camera;
  log(`opened ${name} in Babylon (${container.meshes.length} meshes)`);
  renderOutliner();
}

/* ------------------------------------------------------------- Blender */
let session = null;

function log(line) {
  ui.log.textContent += line + "\n";
  if (ui.log.textContent.length > 200_000) ui.log.textContent = ui.log.textContent.slice(-150_000);
  ui.log.scrollTop = ui.log.scrollHeight;
}
function setStatus(text, kind = "") {
  ui.status.textContent = text;
  ui.status.className = kind;
}

const actionButtons = () => document.querySelectorAll("aside button, aside .button");
async function blenderTask(label, task) {
  if (!session) { setStatus("No Blender runtime — see the README", "error"); return; }
  const started = performance.now();
  setStatus(`${label}…`, "busy");
  actionButtons().forEach((b) => { b.disabled = true; });
  try {
    const result = await task();
    if (result?.glb) await showBlenderScene(result.glb);
    setStatus(`${label}: done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    if (result?.report) log(`[scene] ${result.report.objects.map((o) => o.name).join(", ") || "(empty)"}`);
  } catch (error) {
    if (error instanceof BlenderPythonError) log(error.traceback);
    setStatus(`${label} failed: ${error.message}`, "error");
    console.error(error);
  } finally {
    actionButtons().forEach((b) => { b.disabled = false; });
    renderOutliner();
  }
}

function pushTransforms() {
  const transforms = {};
  for (const node of contentNodes()) {
    if (!isFromBlender(node)) continue;
    const now = localMatrix(node);
    if (!sameMatrix(now, loadedTransforms.get(node.uniqueId))) transforms[node.name] = Array.from(now.asArray());
  }
  const deleted = [...deletedFromBlender];
  if (Object.keys(transforms).length === 0 && deleted.length === 0) {
    setStatus("Nothing moved or deleted since the last Blender sync");
    return;
  }
  return blenderTask(`Push ${Object.keys(transforms).length} transform(s), ${deleted.length} deletion(s)`,
    () => session.pushTransforms(transforms, deleted));
}

async function sendBabylonScene() {
  await blenderTask("Send Babylon scene to Blender", async () => {
    const exported = await GLTF2Export.GLBAsync(scene, "babylon", { shouldExportNode: (node) => !isHelper(node) });
    const blob = Object.values(exported.files ?? exported.glTFFiles)[0];
    const glb = new Uint8Array(await blob.arrayBuffer());
    // It all lives in Blender now; drop the Babylon-only copies before the reload.
    for (const node of contentNodes()) if (!isFromBlender(node) && !node.isDisposed()) node.dispose();
    return session.replaceWithGlb(glb);
  });
}

async function openFile(file, { babylonOnly = false } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.split(".").pop().toLowerCase();
  const blenderCan = BLENDER_FORMATS.includes(ext);
  const babylonCan = ["glb", "gltf", "obj", "stl", "babylon", "usdz", "usda", "usdc", "usd"].includes(ext);
  if (blenderCan && !(babylonOnly && babylonCan)) {
    await blenderTask(`Open ${file.name} in Blender`, () => session.open(file.name, bytes));
  } else if (babylonCan) {
    await openInBabylon(file).catch((error) => setStatus(`Open failed: ${error.message}`, "error"));
  } else {
    setStatus(`Neither side opens .${ext}`, "error");
  }
}

/* ------------------------------------------------------------------ UI */
function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let shiftHeld = false;
window.addEventListener("keydown", (event) => {
  shiftHeld = event.shiftKey;
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
    if (event.target === ui.python && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $("run-python").click();
    }
    return;
  }
  const mode = { w: "position", e: "rotation", r: "scale" }[event.key.toLowerCase()];
  if (mode) setGizmoMode(mode);
  if ((event.key === "Delete" || event.key === "Backspace") && selected) $("delete").click();
});
window.addEventListener("keyup", (event) => { shiftHeld = event.shiftKey; });

$("open").addEventListener("click", (event) => { shiftHeld = event.shiftKey; });
$("open").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (file) await openFile(file, { babylonOnly: shiftHeld });
});
const main = document.querySelector("main");
main.addEventListener("dragover", (event) => { event.preventDefault(); main.classList.add("dragging"); });
main.addEventListener("dragleave", () => main.classList.remove("dragging"));
main.addEventListener("drop", async (event) => {
  event.preventDefault();
  main.classList.remove("dragging");
  for (const file of event.dataTransfer.files) await openFile(file, { babylonOnly: event.shiftKey });
});

$("new-blender").onclick = () => blenderTask("New Blender scene", () => session.newScene());
$("push").onclick = pushTransforms;
$("send").onclick = sendBabylonScene;
$("reload").onclick = () => blenderTask("Reload from Blender", () => session.runPython(""));
$("run-python").onclick = () => blenderTask("Run Python", () => session.runPython(ui.python.value));
for (const button of $("gizmo-modes").children) button.onclick = () => setGizmoMode(button.dataset.mode);

const primitiveMaterial = new StandardMaterial("babylon-primitive", scene);
primitiveMaterial.diffuseColor = new Color3(0.31, 0.64, 0.88);
let primitiveCount = 0;
function addPrimitive(kind) {
  const name = `babylon_${kind}_${++primitiveCount}`;
  const mesh = kind === "box" ? MeshBuilder.CreateBox(name, { size: 1 }, scene) : MeshBuilder.CreateSphere(name, { diameter: 1 }, scene);
  mesh.position = new Vector3((Math.random() - 0.5) * 4, 0.5, (Math.random() - 0.5) * 4);
  mesh.material = primitiveMaterial;
  select(mesh);
}
$("blender-lights").onchange = (event) => {
  for (const light of blenderContent?.lights ?? []) light.setEnabled(event.target.checked);
};
$("add-box").onclick = () => addPrimitive("box");
$("add-sphere").onclick = () => addPrimitive("sphere");
$("delete").onclick = () => {
  if (!selected) return;
  // Babylon disposes the whole subtree, so Blender deletes every object in it.
  for (const node of [selected, ...selected.getDescendants(false)]) {
    if (isObjectNode(node) && isFromBlender(node)) deletedFromBlender.add(node.name);
  }
  const node = selected;
  select(null);
  node.dispose();
  renderOutliner();
};

$("dl-blend").onclick = () => session?.blend ? download("scene.blend", session.blend, "application/x-blender") : setStatus("No Blender session yet");
$("dl-glb").onclick = () => lastGlb ? download("scene.glb", lastGlb, "model/gltf-binary") : setStatus("No Blender export yet");
$("dl-babylon").onclick = async () => download("scene.babylon", JSON.stringify(await SceneSerializer.SerializeAsync(scene)), "application/json");

async function boot() {
  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
  renderOutliner();
  if (!crossOriginIsolated) {
    setStatus("This page is not cross-origin isolated (COOP/COEP); Blender's threads cannot start.", "error");
    return;
  }
  const manifest = await runtimeInstalled();
  if (!manifest) {
    ui.runtime.textContent = "not installed";
    setStatus("Blender's browser runtime is not installed: run `npm run blender` (see README). Babylon-only editing still works.", "error");
    return;
  }
  ui.runtime.textContent = `WebAssembly in this tab · build ${manifest.forkRevision}`;
  session = createSession(createBlender({ onProgress: (text) => setStatus(text, "busy") }), {
    onLine: (line) => { if (line.trim()) log(line); },
  });
  await blenderTask("New Blender scene", () => session.newScene());
}

void boot();
// For poking at the editor from the console.
Object.assign(window, {
  editor: { scene, engine, openFile, serialize: () => SceneSerializer.SerializeAsync(scene), get lastGlb() { return lastGlb; }, get session() { return session; } },
});
