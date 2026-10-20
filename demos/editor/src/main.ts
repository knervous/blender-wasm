/// <reference types="vite/client" />
/* A Babylon.js or three.js editor and Blender (WebAssembly, in this tab) as one
 * working project.
 *
 * @knervous/blender-web keeps the project: a stable id per object, the last
 * state both sides agreed on, and a sync that sends only the engine's edits
 * since then and applies only what Blender changed. Its engine adapters
 * (`/babylon`, `/three`) translate for each engine; this file is the editor UI,
 * the same for both (see viewport.ts). The full Blender UI can edit the same
 * .blend; saving it back is just another sync.
 *
 * ?engine=three picks three.js; Babylon.js is the default. Only the chosen
 * engine is loaded.
 */
import {
  BLENDER_IMPORTS, Project, ProjectRunError, type Change, type Conflict, type ProjectPlugin, type Rgba, type SyncResult,
} from "@knervous/blender-web";
import { createBlenderSession, runtimeInstalled, type BootProgress } from "@knervous/blender-web/browser";
import { hexToLinear, linearToHex, type GizmoMode, type Viewport } from "./viewport.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string, type?: new () => T): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} missing`);
  if (type && !(element instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
  return element as T;
};

const ENGINES = { babylon: "Babylon.js", lite: "Babylon Lite", three: "three.js" } as const;
type EngineKey = keyof typeof ENGINES;
const isEngine = (value: string | null): value is EngineKey => value !== null && value in ENGINES;

function editor<N extends object>(view: Viewport<N>): void {
  const side = view.side;
  const ui = {
    status: $("status"), log: $("log"), outliner: $("outliner"), pending: $("pending"),
    python: $("python", HTMLTextAreaElement),
  };

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
  const nameOf = (id: string): string => {
    const node = side.node(id);
    return (node && view.nameOf(node)) ?? project?.agreed.entities[id]?.name ?? knownNames.get(id) ?? id.slice(0, 6);
  };

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
    if (!project) { setStatus("Blender's runtime is not available", "error"); return; }
    const started = performance.now();
    knownNames = new Map(Object.values(project.agreed.entities).map((e) => [e.id, e.name]));
    busy = true;
    setStatus(`${label}…`, "busy");
    actionButtons().forEach((b) => { b.disabled = true; });
    try {
      const { sent, received } = await task(project);
      const ms = Math.round(performance.now() - started);
      setStatus(`${label}: done in ${ms} ms · sent ${sent.length}, received ${received.length}`);
      log(`[sync] sent ${sent.length ? sent.map(describe).join(", ") : "nothing"} · received ${received.length ? received.map(describe).join(", ") : "nothing"}`);
    } catch (error) {
      if (error instanceof ProjectRunError) log(error.traceback);
      setStatus(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      console.error(error);
    } finally {
      busy = false;
      view.decorate();
      actionButtons().forEach((b) => { b.disabled = b.title.startsWith("Not installed"); });
      refresh();
    }
  }

  /* ------------------------------------------------------------ selection */
  let selected: N | null = null;

  function setGizmoMode(mode: GizmoMode): void {
    view.setGizmoMode(mode);
    for (const b of $("gizmo-modes").children) b.classList.toggle("on", b instanceof HTMLElement && b.dataset.mode === mode);
  }
  function select(node: N | null): void {
    selected = node;
    view.attachGizmo(node);
    refresh();
  }
  view.onPick((node) => select(node));
  view.onEditEnd(() => { refresh(); scheduleAutoSync(); });

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
    for (const node of view.untracked()) {
      const li = document.createElement("li");
      li.className = "untracked";
      li.textContent = view.nameOf(node);
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

  /* ------------------------------------------------------------ materials */
  /* Slot 0 of the selected mesh: which material it uses (assignment) and that
   * material's properties. Both are pending changes until the next sync.
   * Colours are linear, as in glTF and Principled BSDF; the picker shows sRGB. */
  const matPanel = $("material-panel");
  const matName = $("mat-name", HTMLSelectElement);
  const matColor = $("mat-color", HTMLInputElement);
  const matMetallic = $("mat-metallic", HTMLInputElement);
  const matRoughness = $("mat-roughness", HTMLInputElement);
  let newMaterialCount = 0;

  const selectedEntity = () => {
    const id = side.idOf(selected);
    return id ? side.read()[id] ?? null : null;
  };

  function showMaterial(): void {
    const entity = selectedEntity();
    matPanel.hidden = !entity || entity.kind !== "mesh";
    if (!entity || matPanel.hidden) return;
    const current = entity.materials[0] ?? "";
    const materials = side.readMaterials();
    matName.replaceChildren(new Option("(none)", ""), ...Object.keys(materials).sort().map((n) => new Option(n, n)));
    matName.value = current;
    const state = current ? materials[current] : undefined;
    for (const input of [matColor, matMetallic, matRoughness]) input.disabled = !state;
    if (!state) return;
    matColor.value = linearToHex(state.color);
    matMetallic.value = String(state.metallic);
    matRoughness.value = String(state.roughness);
  }

  function assignSlot0(name: string | null): void {
    const entity = selectedEntity();
    if (!entity || !selected) return;
    view.assignMaterial(selected, name);
    refresh();
    scheduleAutoSync();
  }

  function editMaterial(): void {
    const name = matName.value;
    const state = name ? side.readMaterials()[name] : undefined;
    if (!state) return;
    view.editMaterial(name, {
      color: [...hexToLinear(matColor.value), state.color[3]],
      metallic: Number(matMetallic.value),
      roughness: Number(matRoughness.value),
    });
    refresh();
  }

  matName.onchange = () => assignSlot0(matName.value || null);
  $("mat-new").onclick = () => {
    const name = `material_${++newMaterialCount}`;
    assignSlot0(view.createMaterial(name, { color: [0.6, 0.6, 0.6, 1], metallic: 0, roughness: 0.5 }));
  };
  for (const input of [matColor, matMetallic, matRoughness]) {
    input.addEventListener("input", editMaterial);
    input.addEventListener("change", scheduleAutoSync);
  }

  let autoSyncTimer = 0;
  function scheduleAutoSync(): void {
    if (!$("auto-sync", HTMLInputElement).checked || busy || !project?.pending().length) return;
    clearTimeout(autoSyncTimer);
    autoSyncTimer = window.setTimeout(() => void blenderTask("Auto-sync", (p) => p.sync()), 700);
  }

  /* ---------------------------------------------------------------- files */
  async function openFile(file: File, { engineOnly = false } = {}): Promise<void> {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const blenderCan = BLENDER_IMPORTS.includes(ext);
    const engineCan = view.formats.includes(ext);
    if (blenderCan && !(engineOnly && engineCan)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await blenderTask(`Open ${file.name}`, (p) => p.open(file.name, bytes));
    } else if (engineCan) {
      try {
        log(await view.openUntracked(file));
        refresh();
      } catch (error) {
        setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    } else {
      setStatus(`Neither side opens .${ext}`, "error");
    }
  }

  /* ----------------------------------------------------------- Blender UI */
  /* The full Blender interface (headed WebGPU build) in a same-origin iframe on
   * the embed protocol. It opens the project's .blend; "Save back" hands the
   * edited file to project.adoptBlend, an ordinary sync. */
  const uiPanel = $("ui-panel");
  const uiFrame = $("ui-frame", HTMLIFrameElement);
  const uiStatus = $("ui-status");
  let uiSessionUrl: string | null = null;

  async function openBlenderUi(): Promise<void> {
    // index.html explicitly: static servers do not all map a public/ directory to its index.
    const url = new URL("blender-ui/index.html", document.baseURI);
    url.searchParams.set("embed", "1");
    url.searchParams.set("id", "editor-demo");
    if (uiSessionUrl) URL.revokeObjectURL(uiSessionUrl);
    // The session lives in Blender's memory; write it out with any pending edits.
    uiStatus.textContent = "saving the session for the UI…";
    uiPanel.hidden = false;
    const blend = project ? await project.exportBlend().catch(() => null) : null;
    uiSessionUrl = blend ? URL.createObjectURL(new Blob([ownBytes(blend)], { type: "application/x-blender" })) : null;
    if (uiSessionUrl) url.searchParams.set("session", uiSessionUrl);
    $("ui-save", HTMLButtonElement).disabled = !uiSessionUrl;
    uiStatus.textContent = blend ? "starting…" : "starting with Blender's startup scene";
    uiFrame.src = url.href;
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

  /* --------------------------------------------------------------- wiring */
  /** A copy backed by a plain ArrayBuffer (Blob refuses views of shared memory). */
  const ownBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

  function download(name: string, bytes: BlobPart, type: string): void {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const GIZMO_KEYS: Record<string, GizmoMode> = { w: "position", e: "rotation", r: "scale" };
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
    const mode = GIZMO_KEYS[event.key.toLowerCase()];
    if (mode) setGizmoMode(mode);
    if ((event.key === "Delete" || event.key === "Backspace") && selected) $("delete").click();
  });
  window.addEventListener("keyup", (event) => { shiftHeld = event.shiftKey; });

  const opener = $("open", HTMLInputElement);
  opener.addEventListener("change", async () => {
    const file = opener.files?.[0];
    opener.value = "";
    if (file) await openFile(file, { engineOnly: shiftHeld });
  });
  const main = $("stage");
  main.addEventListener("dragover", (event) => { event.preventDefault(); main.classList.add("dragging"); });
  main.addEventListener("dragleave", () => main.classList.remove("dragging"));
  main.addEventListener("drop", async (event) => {
    event.preventDefault();
    main.classList.remove("dragging");
    for (const file of event.dataTransfer?.files ?? []) await openFile(file, { engineOnly: event.shiftKey });
  });

  const addPrimitive = (kind: "box" | "sphere", color: Rgba): void => {
    select(view.addPrimitive(kind, color));
    scheduleAutoSync();
  };

  $("new-blender").onclick = () => void blenderTask("New Blender scene", (p) => p.newScene());
  $("sync").onclick = () => void blenderTask("Sync", (p) => p.sync());
  $("run-python").onclick = () => void blenderTask("Run Python", (p) => p.sync({ script: ui.python.value }));
  for (const button of $("gizmo-modes").children) {
    if (button instanceof HTMLElement) button.onclick = () => setGizmoMode(GIZMO_KEYS[button.dataset.key ?? "w"]);
  }
  $("add-box").onclick = () => addPrimitive("box", [0.08, 0.37, 0.75, 1]);
  $("add-sphere").onclick = () => addPrimitive("sphere", [0.69, 0.07, 0.1, 1]);
  $("delete").onclick = () => {
    if (!selected) return;
    const node = selected;
    select(null);
    const id = side.idOf(node);
    if (id) view.deleteNode(node);
    else view.disposeUntracked(node);
    refresh();
    scheduleAutoSync();
  };
  $("adopt").onclick = () => {
    if (!view.untracked().length) { setStatus(`Nothing outside the project to adopt`); return; }
    const ids = view.adoptUntracked();
    setStatus(`Adopted ${ids.length} node(s); they reach Blender on the next sync`);
    refresh();
    scheduleAutoSync();
  };
  $("ui-open").onclick = () => void openBlenderUi();
  $("ui-close").onclick = closeBlenderUi;
  $("ui-save").onclick = () => {
    uiStatus.textContent = "saving…";
    uiFrame.contentWindow?.postMessage({ type: "blender-embed-save" }, window.location.origin);
  };

  $("dl-blend").onclick = async () => {
    if (!project) { setStatus("No Blender yet"); return; }
    download("scene.blend", ownBytes(await project.exportBlend()), "application/x-blender");
  };
  $("dl-glb").onclick = () => void blenderTask("Export .glb", async (p) => {
    const result = await p.sync({ script: 'import bpy\nbpy.ops.export_scene.gltf(filepath="/out/export.glb", export_format="GLB", export_apply=True)' });
    const glb = result.report.files["/out/export.glb"];
    if (glb) download("scene.glb", ownBytes(glb), "model/gltf-binary");
    return result;
  });
  const nativeExport = view.nativeExport;
  $("dl-native").hidden = !nativeExport || !view.exportNative;
  if (nativeExport) {
    $("dl-native").textContent = nativeExport.label;
    $("dl-native").onclick = async () => {
      if (view.exportNative) download(nativeExport.file, await view.exportNative(), "application/octet-stream");
    };
  }
  $("gizmo-modes").hidden = !view.gizmos;

  /* Boot progress: bytes while downloading, then Blender's start phases. */
  function showBootProgress(progress: BootProgress): void {
    $("boot-progress").hidden = progress.phase === "ready";
    $("boot-fill").style.width = `${Math.round(progress.fraction * 100)}%`;
    const mb = (n: number) => (n / 1048576).toFixed(0);
    setStatus(progress.phase === "download" && progress.total
      ? `${progress.detail} · ${mb(progress.loaded)} / ${mb(progress.total)} MB`
      : `${progress.detail}…`, progress.phase === "ready" ? "" : "busy");
  }

  async function boot(): Promise<void> {
    await view.start();
    const uiInstalled = await fetch("blender-ui/manifest.json", { cache: "no-store" })
      .then((r) => r.ok && (r.headers.get("content-type") ?? "").includes("json"), () => false);
    $("ui-open", HTMLButtonElement).disabled = !uiInstalled;
    if (!uiInstalled) $("ui-open").title = "Not installed: npm run blender:ui";
    // The Vite plugin serves the runtime package at blender-runtime/ (the default).
    const manifest = await runtimeInstalled();
    if (!manifest) {
      $("runtime").textContent = "not found";
      setStatus(`Blender's runtime is not served at blender-runtime/. ${view.engine}-only editing still works.`, "error");
      refresh();
      return;
    }
    // ?threads=1|0 forces the pthread or single-threaded build; "auto" picks by isolation.
    const forced = new URLSearchParams(location.search).get("threads");
    const threads = forced === "1" ? true : forced === "0" ? false : "auto";
    const session = createBlenderSession({ threads, onProgress: showBootProgress });
    project = new Project({
      session,
      scene: side,
      plugins: [tracePlugin],
      onLine: (line) => { if (line.trim() && !line.startsWith("<<<")) log(line); },
    });
    await blenderTask("New Blender scene", (p) => p.newScene());
    const flavor = session.flavor === "mt" ? "pthreads" : "single-threaded (JSPI)";
    $("runtime").textContent = `WebAssembly in this tab · ${flavor} · build ${manifest.forkRevision}`;
    log(`[session] Blender (${flavor}) booted once in ${(session.bootMs / 1000).toFixed(1)} s; requests reuse it`);
  }

  void boot();
  Object.assign(window, { editor: { view, side, openFile, get project() { return project; } } });
}

/* ------------------------------------------------------------------ engine */
const requested = new URLSearchParams(location.search).get("engine");
const engineKey: EngineKey = isEngine(requested) ? requested : "babylon";
const engineName = ENGINES[engineKey];
document.title = `Blender ⇄ ${engineName}`;
$("title").textContent = `Blender ⇄ ${engineName}`;
for (const [key, name] of Object.entries(ENGINES)) {
  const link = document.createElement("a");
  link.href = `?engine=${key}`;
  link.textContent = name;
  if (key === engineKey) link.className = "on";
  $("engines").append(link);
}
for (const element of document.querySelectorAll("[data-engine-name]")) element.textContent = engineName;

const canvas = $("viewport", HTMLCanvasElement);
if (engineKey === "three") {
  const { createThreeViewport } = await import("./viewport-three.ts");
  editor(createThreeViewport(canvas));
} else if (engineKey === "lite") {
  const { createLiteViewport } = await import("./viewport-lite.ts");
  editor(await createLiteViewport(canvas));
} else {
  const { createBabylonViewport } = await import("./viewport-babylon.ts");
  editor(createBabylonViewport(canvas));
}
