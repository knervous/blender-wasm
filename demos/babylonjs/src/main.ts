/// <reference types="vite/client" />
/* Babylon.js editor and headless Blender as one working project.
 *
 * sdk/project keeps the project: a stable id per object, the last state both
 * sides agreed on, and a sync that sends only Babylon's edits since then and
 * applies only what Blender changed (src/babylon-side.ts translates for
 * Babylon). The .blend stays the persistent truth. The full Blender UI can
 * edit the same .blend; saving it back is just another sync.
 */
import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, GizmoManager, HemisphericLight,
  LoadAssetContainerAsync, MeshBuilder, PointerEventTypes, Scene, SceneSerializer, TransformNode, Vector3,
  type Node,
} from "@babylonjs/core";
import "@babylonjs/loaders";
import protocol from "../../../sdk/project/protocol.py?raw";
import {
  BLENDER_IMPORTS, Project, type Change, type Conflict, type ProjectPlugin, type SyncResult,
} from "../../../sdk/project/index.ts";
import { BabylonSide } from "./babylon-side.ts";
import { BlenderPythonError, createBlender, runtimeInstalled } from "./blender.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} missing`);
  return element as T;
};

/* ---------------------------------------------------------------- Babylon */
const canvas = $<HTMLCanvasElement>("viewport");
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.16, 0.16, 0.17, 1);

const helper = <T extends Node>(node: T): T => { node.metadata = { ...node.metadata, editorHelper: true }; return node; };
const camera = helper(new ArcRotateCamera("editor-camera", -Math.PI / 3, Math.PI / 3, 14, Vector3.Zero(), scene));
camera.attachControl(canvas, true);
camera.wheelPrecision = 30;
camera.minZ = 0.05;
helper(new HemisphericLight("editor-sky", new Vector3(0, 1, 0), scene)).intensity = 0.8;
helper(new DirectionalLight("editor-sun", new Vector3(-0.5, -1, -0.3), scene)).intensity = 0.9;
const gridLines: Vector3[][] = [];
for (let i = -10; i <= 10; i++) gridLines.push([new Vector3(i, 0, -10), new Vector3(i, 0, 10)], [new Vector3(-10, 0, i), new Vector3(10, 0, i)]);
const grid = helper(MeshBuilder.CreateLineSystem("editor-grid", { lines: gridLines }, scene));
grid.color = new Color3(0.32, 0.32, 0.35);
grid.isPickable = false;

const side = new BabylonSide(scene);
/** Content loaded into Babylon outside the project (until adopted). */
let untracked: TransformNode[] = [];

/* ---------------------------------------------------------------- project */
const ui = { status: $("status"), log: $("log"), outliner: $("outliner"), pending: $("pending"), python: $<HTMLTextAreaElement>("python") };

function log(line: string): void {
  ui.log.textContent += line + "\n";
  if ((ui.log.textContent ?? "").length > 200_000) ui.log.textContent = (ui.log.textContent ?? "").slice(-150_000);
  ui.log.scrollTop = ui.log.scrollHeight;
}
function setStatus(text: string, kind = ""): void {
  ui.status.textContent = text;
  ui.status.className = kind;
}

/* Hooks in use: a readable trace of what crosses, and conflicts surfaced. */
const tracePlugin: ProjectPlugin = {
  name: "editor-trace",
  hooks: {
    onConflict: (conflict: Conflict) => log(conflict.field === "material"
      ? `[conflict] material ${conflict.id}: kept ${conflict.kept}`
      : `[conflict] ${nameOf(conflict.id)}.${conflict.field}: kept ${conflict.kept}`),
    afterRun: (report) => { if (report.log.length) log(`[blender] ${report.log.join("; ")}`); },
  },
};

let project: Project | null = null;

/** Names as of the last agreed state too, so a deleted entity still logs by name. */
let knownNames = new Map<string, string>();
const nameOf = (id: string): string =>
  side.node(id)?.name ?? project?.agreed.entities[id]?.name ?? knownNames.get(id) ?? id.slice(0, 6);

function describe(change: Change): string {
  switch (change.op) {
    case "create": return `+ ${change.entity.name}`;
    case "delete": return `− ${nameOf(change.id)}`;
    case "update": return `~ ${nameOf(change.id)}.${change.field}`;
    case "geometry": return `~ ${nameOf(change.id)} mesh (${change.mesh.vertexCount} verts)`;
    case "material": return `~ material ${change.name}`;
  }
}

const actionButtons = (): NodeListOf<HTMLButtonElement> => document.querySelectorAll("aside button");
let busy = false;
async function blenderTask(label: string, task: (p: Project) => Promise<SyncResult>): Promise<void> {
  if (!project) { setStatus("Blender's browser runtime is not installed (npm run blender)", "error"); return; }
  const started = performance.now();
  knownNames = new Map(Object.values(project.agreed.entities).map((e) => [e.id, e.name]));
  busy = true;
  setStatus(`${label}…`, "busy");
  actionButtons().forEach((b) => { b.disabled = true; });
  try {
    const { sent, received } = await task(project);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    setStatus(`${label}: done in ${seconds} s · sent ${sent.length}, received ${received.length}`);
    log(`[sync] sent ${sent.length ? sent.map(describe).join(", ") : "nothing"} · received ${received.length ? received.map(describe).join(", ") : "nothing"}`);
  } catch (error) {
    if (error instanceof BlenderPythonError) log(error.traceback);
    setStatus(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    console.error(error);
  } finally {
    busy = false;
    actionButtons().forEach((b) => { b.disabled = b.title.startsWith("Not installed"); });
    refresh();
  }
}

/* -------------------------------------------------------------- selection */
const gizmos = new GizmoManager(scene);
gizmos.usePointerToAttachGizmos = false;
gizmos.positionGizmoEnabled = true;
let selected: TransformNode | null = null;

function setGizmoMode(mode: string): void {
  gizmos.positionGizmoEnabled = mode === "position";
  gizmos.rotationGizmoEnabled = mode === "rotation";
  gizmos.scaleGizmoEnabled = mode === "scale";
  gizmos.attachToNode(selected);
  for (const b of $("gizmo-modes").children) b.classList.toggle("on", (b as HTMLElement).dataset.mode === mode);
}
function select(node: TransformNode | null): void {
  selected = node;
  gizmos.attachToNode(node);
  refresh();
}
const untrackedRootOf = (node: Node | null): TransformNode | null => {
  for (let n = node; n; n = n.parent) if (n instanceof TransformNode && untracked.includes(n)) return n;
  return null;
};
scene.onPointerObservable.add((info) => {
  if (info.type === PointerEventTypes.POINTERTAP && info.event.button === 0) {
    const mesh = info.pickInfo?.hit ? info.pickInfo.pickedMesh : null;
    select(side.entityOf(mesh) ?? untrackedRootOf(mesh));
  } else if (info.type === PointerEventTypes.POINTERUP) {
    refresh();
    scheduleAutoSync();
  }
});

function refresh(): void {
  const pending = project ? project.pending() : [];
  const states = new Map<string, string>();
  for (const change of pending) {
    if (change.op === "update") states.set(change.id, [states.get(change.id), change.field].filter(Boolean).join(", "));
    if (change.op === "create") states.set(change.id, "new");
  }

  ui.outliner.replaceChildren();
  const entities = side.read();
  const depth = (id: string): number => { let d = 0; for (let p = entities[id]?.parent; p; p = entities[p]?.parent) d++; return d; };
  const ordered = Object.values(entities).sort((a, b) => a.name.localeCompare(b.name));
  const roots = ordered.filter((e) => !e.parent || !entities[e.parent]);
  const visit = (id: string): void => {
    const entity = entities[id];
    const li = document.createElement("li");
    li.style.paddingLeft = `${6 + depth(id) * 14}px`;
    li.append(entity.name);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = entity.kind;
    li.append(kind);
    if (states.has(id)) {
      const state = document.createElement("span");
      state.className = "state";
      state.textContent = `· ${states.get(id)}`;
      li.append(state);
    }
    if (side.node(id) === selected) li.classList.add("selected");
    li.onclick = () => select(side.node(id) ?? null);
    ui.outliner.append(li);
    for (const child of ordered) if (child.parent === id) visit(child.id);
  };
  for (const root of roots) visit(root.id);
  untracked = untracked.filter((n) => !n.isDisposed());
  for (const node of untracked) {
    const li = document.createElement("li");
    li.className = "untracked";
    li.textContent = node.name;
    if (node === selected) li.classList.add("selected");
    li.onclick = () => select(node);
    ui.outliner.append(li);
  }

  ui.pending.replaceChildren();
  for (const change of pending) {
    const li = document.createElement("li");
    li.textContent = describe(change);
    ui.pending.append(li);
  }
  if (!pending.length) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = project ? "In sync with Blender." : "";
    ui.pending.append(li);
  }
  $("sync").textContent = pending.length ? `Sync with Blender (${pending.length})` : "Sync with Blender";
  showMaterial();
}

/* -------------------------------------------------------------- materials */
/* Slot 0 of the selected mesh: which material it uses (assignment) and that
 * material's properties. Both are pending changes until the next sync.
 * Colours are linear, as in glTF and Principled BSDF; the picker shows sRGB. */
const matPanel = $("material-panel");
const matName = $<HTMLSelectElement>("mat-name");
const matColor = $<HTMLInputElement>("mat-color");
const matMetallic = $<HTMLInputElement>("mat-metallic");
const matRoughness = $<HTMLInputElement>("mat-roughness");
let newMaterialCount = 0;

const selectedEntity = () => {
  const id = selected ? side.idOf(selected) : null;
  return id ? side.read()[id] ?? null : null;
};

function showMaterial(): void {
  const entity = selectedEntity();
  matPanel.hidden = !entity || entity.kind !== "mesh";
  if (!entity || matPanel.hidden) return;
  const current = entity.materials[0] ?? "";
  matName.replaceChildren(new Option("(none)", ""), ...side.materialNames().map((n) => new Option(n, n)));
  matName.value = current;
  const state = current ? side.materialState(current) : undefined;
  for (const input of [matColor, matMetallic, matRoughness]) input.disabled = !state;
  if (!state) return;
  matColor.value = new Color3(state.color[0], state.color[1], state.color[2]).toGammaSpace().toHexString().toLowerCase();
  matMetallic.value = String(state.metallic);
  matRoughness.value = String(state.roughness);
}

function assignSlot0(name: string | null): void {
  const entity = selectedEntity();
  if (!entity || !selected) return;
  const slots = entity.materials.length ? [...entity.materials] : [null];
  slots[0] = name;
  side.assignMaterials(selected, slots);
  refresh();
  scheduleAutoSync();
}

function editMaterial(): void {
  const name = matName.value;
  const state = name ? side.materialState(name) : undefined;
  if (!state) return;
  const linear = Color3.FromHexString(matColor.value).toLinearSpace();
  side.setMaterial(name, {
    color: [linear.r, linear.g, linear.b, state.color[3]],
    metallic: Number(matMetallic.value),
    roughness: Number(matRoughness.value),
  });
  refresh();
}

matName.onchange = () => assignSlot0(matName.value || null);
$("mat-new").onclick = () => {
  const name = `material_${++newMaterialCount}`;
  side.setMaterial(name, { color: [0.6, 0.6, 0.6, 1], metallic: 0, roughness: 0.5 });
  assignSlot0(name);
};
for (const input of [matColor, matMetallic, matRoughness]) {
  input.addEventListener("input", editMaterial);
  input.addEventListener("change", scheduleAutoSync);
}

let autoSyncTimer = 0;
function scheduleAutoSync(): void {
  if (!$<HTMLInputElement>("auto-sync").checked || busy || !project?.pending().length) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = window.setTimeout(() => void blenderTask("Auto-sync", (p) => p.sync()), 700);
}

/* ---------------------------------------------------------------- files */
const BABYLON_FORMATS = ["glb", "gltf", "obj", "stl", "babylon", "usdz", "usda", "usdc", "usd"];

async function openInBabylon(file: File): Promise<void> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  // A File, not its bytes: the text formats refuse an ArrayBufferView source.
  const container = await LoadAssetContainerAsync(file, scene, { pluginExtension: `.${ext}`, name: file.name });
  container.addAllToScene();
  scene.activeCamera = camera;
  const roots = [...container.transformNodes, ...container.meshes].filter((n) => !n.parent);
  untracked.push(...roots);
  log(`opened ${file.name} in Babylon, outside the project (${container.meshes.length} meshes)`);
  refresh();
}

async function openFile(file: File, { babylonOnly = false } = {}): Promise<void> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const blenderCan = BLENDER_IMPORTS.includes(ext);
  const babylonCan = BABYLON_FORMATS.includes(ext);
  if (blenderCan && !(babylonOnly && babylonCan)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await blenderTask(`Open ${file.name}`, (p) => p.open(file.name, bytes));
  } else if (babylonCan) {
    await openInBabylon(file).catch((error) => setStatus(`Open failed: ${error.message}`, "error"));
  } else {
    setStatus(`Neither side opens .${ext}`, "error");
  }
}

/* -------------------------------------------------------------- Blender UI */
/* The full Blender interface (headed WebGPU build) in a same-origin iframe on
 * the embed protocol. It opens the project's .blend; "Save back" hands the
 * edited file to project.adoptBlend, an ordinary sync. */
const uiPanel = $("ui-panel");
const uiFrame = $<HTMLIFrameElement>("ui-frame");
const uiStatus = $("ui-status");
let uiSessionUrl: string | null = null;

function openBlenderUi(): void {
  // index.html explicitly: static servers do not all map a public/ directory to its index.
  const url = new URL("blender-ui/index.html", document.baseURI);
  url.searchParams.set("embed", "1");
  url.searchParams.set("id", "babylon-demo");
  if (uiSessionUrl) URL.revokeObjectURL(uiSessionUrl);
  const blend = project?.blend;
  uiSessionUrl = blend ? URL.createObjectURL(new Blob([ownBytes(blend)], { type: "application/x-blender" })) : null;
  if (uiSessionUrl) url.searchParams.set("session", uiSessionUrl);
  $<HTMLButtonElement>("ui-save").disabled = !uiSessionUrl;
  uiStatus.textContent = blend ? "starting…" : "starting with Blender's startup scene";
  uiFrame.src = url.href;
  uiPanel.hidden = false;
}
function closeBlenderUi(): void {
  uiPanel.hidden = true;
  uiFrame.src = "about:blank";
  if (uiSessionUrl) URL.revokeObjectURL(uiSessionUrl);
  uiSessionUrl = null;
}
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.source !== uiFrame.contentWindow) return;
  const { type, ...data } = event.data ?? {};
  if (type === "blender-embed-progress") {
    uiStatus.textContent = `${data.phase ?? "loading"}${typeof data.percent === "number" ? ` ${data.percent}%` : ""}`;
  } else if (type === "blender-embed-ready") {
    uiStatus.textContent = "ready";
  } else if (type === "blender-embed-error") {
    uiStatus.textContent = `error: ${data.message}`;
  } else if (type === "blender-embed-snapshot" && data.session) {
    const bytes = new Uint8Array(data.session);
    closeBlenderUi();
    void blenderTask("Bring the Blender UI edits back", (p) => p.adoptBlend(bytes));
  }
});

/* ------------------------------------------------------------------ wiring */
/** A copy backed by a plain ArrayBuffer (Blob refuses views of shared memory). */
const ownBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

function download(name: string, bytes: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let shiftHeld = false;
window.addEventListener("keydown", (event) => {
  shiftHeld = event.shiftKey;
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
    if (event.target === ui.python && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $("run-python").click();
    }
    return;
  }
  const mode = ({ w: "position", e: "rotation", r: "scale" } as Record<string, string>)[event.key.toLowerCase()];
  if (mode) setGizmoMode(mode);
  if ((event.key === "Delete" || event.key === "Backspace") && selected) $("delete").click();
});
window.addEventListener("keyup", (event) => { shiftHeld = event.shiftKey; });

$<HTMLInputElement>("open").addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) await openFile(file, { babylonOnly: shiftHeld });
});
const main = document.querySelector("main") as HTMLElement;
main.addEventListener("dragover", (event) => { event.preventDefault(); main.classList.add("dragging"); });
main.addEventListener("dragleave", () => main.classList.remove("dragging"));
main.addEventListener("drop", async (event) => {
  event.preventDefault();
  main.classList.remove("dragging");
  for (const file of event.dataTransfer?.files ?? []) await openFile(file, { babylonOnly: event.shiftKey });
});

$("new-blender").onclick = () => void blenderTask("New Blender scene", (p) => p.newScene());
$("sync").onclick = () => void blenderTask("Sync", (p) => p.sync());
$("run-python").onclick = () => void blenderTask("Run Python", (p) => p.sync({ script: ui.python.value }));
for (const button of $("gizmo-modes").children) (button as HTMLElement).onclick = () => setGizmoMode((button as HTMLElement).dataset.mode ?? "position");
$("add-box").onclick = () => { select(side.createPrimitive("box", { color: new Color3(0.31, 0.64, 0.88) })); scheduleAutoSync(); };
$("add-sphere").onclick = () => { select(side.createPrimitive("sphere", { color: new Color3(0.85, 0.3, 0.35) })); scheduleAutoSync(); };
$("delete").onclick = () => {
  if (!selected) return;
  const node = selected;
  select(null);
  const id = side.idOf(node);
  if (id) side.remove(id);
  else node.dispose(false, true);
  refresh();
  scheduleAutoSync();
};
$("adopt").onclick = () => {
  if (!untracked.length) { setStatus("Nothing outside the project to adopt"); return; }
  const ids = side.adopt(untracked);
  untracked = [];
  setStatus(`Adopted ${ids.length} node(s); they reach Blender on the next sync`);
  refresh();
  scheduleAutoSync();
};
$("ui-open").onclick = openBlenderUi;
$("ui-close").onclick = closeBlenderUi;
$("ui-save").onclick = () => {
  uiStatus.textContent = "saving…";
  uiFrame.contentWindow?.postMessage({ type: "blender-embed-save" }, window.location.origin);
};
$("blender-lights").onchange = () => setStatus("Blender's lights show as markers; editor lights light the scene");

$("dl-blend").onclick = () => project?.blend ? download("scene.blend", ownBytes(project.blend), "application/x-blender") : setStatus("No .blend yet");
$("dl-glb").onclick = () => void blenderTask("Export .glb", async (p) => {
  const result = await p.sync({ script: 'import bpy\nbpy.ops.export_scene.gltf(filepath="/out/export.glb", export_format="GLB", export_apply=True)' });
  const glb = result.report.files["/out/export.glb"];
  if (glb) download("scene.glb", ownBytes(glb), "model/gltf-binary");
  return result;
});
$("dl-babylon").onclick = async () => download("scene.babylon", JSON.stringify(await SceneSerializer.SerializeAsync(scene)), "application/json");

async function boot(): Promise<void> {
  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
  if (!crossOriginIsolated) {
    setStatus("This page is not cross-origin isolated (COOP/COEP); Blender's threads cannot start.", "error");
    return;
  }
  const uiInstalled = await fetch("blender-ui/manifest.json", { cache: "no-store" })
    .then((r) => r.ok && (r.headers.get("content-type") ?? "").includes("json"), () => false);
  $<HTMLButtonElement>("ui-open").disabled = !uiInstalled;
  if (!uiInstalled) $("ui-open").title = "Not installed: npm run blender:ui";
  const manifest = await runtimeInstalled();
  if (!manifest) {
    $("runtime").textContent = "not installed";
    setStatus("Blender's browser runtime is not installed: run `npm run blender` (see README). Babylon-only editing still works.", "error");
    refresh();
    return;
  }
  $("runtime").textContent = `WebAssembly in this tab · build ${manifest.forkRevision}`;
  project = new Project({
    blender: createBlender({ onProgress: (text: string) => setStatus(text, "busy") }),
    scene: side,
    protocol,
    plugins: [tracePlugin],
    onLine: (line) => { if (line.trim() && !line.startsWith("<<<")) log(line); },
  });
  await blenderTask("New Blender scene", (p) => p.newScene());
}

void boot();
Object.assign(window, { editor: { scene, engine, side, openFile, get project() { return project; } } });
