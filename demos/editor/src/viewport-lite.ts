import * as LITE from "@babylonjs/lite";
import { LiteSide, isMesh } from "@knervous/blender-web/lite";
import type { GizmoMode, Viewport } from "./viewport.ts";

type SceneNode = LITE.SceneNode;

/**
 * Babylon Lite (WebGPU). No gizmos here: Lite's gizmos are a toolkit of their
 * own, and this viewport keeps to what the editor needs to exercise the
 * adapter (pick, add, delete, materials, adopt).
 */
export async function createLiteViewport(canvas: HTMLCanvasElement): Promise<Viewport<SceneNode>> {
  const engine = await LITE.createEngine(canvas);
  const scene = LITE.createSceneContext(engine);
  scene.clearColor = { r: 0.16, g: 0.16, b: 0.17, a: 1 };
  LITE.addToScene(scene, LITE.createHemisphericLight([0, 1, 0], 0.8));
  LITE.addToScene(scene, LITE.createDirectionalLight([-0.5, -1, -0.3], 0.9));
  const camera = LITE.createArcRotateCamera(-Math.PI / 3, Math.PI / 3, 14, LITE.vec3(0, 0, 0));
  LITE.addToScene(scene, camera);
  LITE.attachControl(camera, canvas, scene);

  // The adapter uses this app's Lite.
  const side = new LiteSide(LITE, engine, scene);
  let untracked: SceneNode[] = [];
  const created = new Map<string, LITE.Material>();
  const picker = LITE.createGpuPicker(scene);

  const pick: ((node: SceneNode | null) => void)[] = [];
  const editEnd: (() => void)[] = [];
  let down: [number, number] | null = null;
  canvas.addEventListener("pointerdown", (event) => { down = [event.clientX, event.clientY]; });
  canvas.addEventListener("pointerup", async (event) => {
    const start = down;
    down = null;
    if (!start || event.button !== 0) return;
    if (Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 4) {
      for (const listener of editEnd) listener();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const info = await LITE.pickAsync(picker, event.clientX - rect.left, event.clientY - rect.top);
    const mesh = info.hit && isMesh(info.pickedMesh) ? info.pickedMesh : null;
    let node: SceneNode | null = side.entityOf(mesh);
    if (!node && mesh) {
      for (let n: unknown = mesh; n && typeof n === "object" && "children" in n; n = Reflect.get(n, "parent")) {
        const found = untracked.find((u) => u === n);
        if (found) { node = found; break; }
      }
    }
    for (const listener of pick) listener(node);
  });

  const meshesUnder = (node: SceneNode): number => {
    let count = 0;
    const walk = (n: SceneNode): void => {
      if (isMesh(n)) count++;
      for (const child of n.children) walk(child);
    };
    walk(node);
    return count;
  };

  const remove = (node: SceneNode): void => {
    const parent = node.parent;
    if (parent && "children" in parent && Array.isArray(parent.children)) {
      const at = parent.children.indexOf(node);
      if (at >= 0) parent.children.splice(at, 1);
    }
    LITE.removeFromScene(scene, node);
    node.parent = null;
  };

  return {
    engine: "Babylon Lite",
    side,
    formats: ["glb", "gltf"],
    async start() {
      await LITE.registerScene(scene);
      // The render loop: its promise settles only when the engine stops.
      void LITE.startEngine(engine);
    },
    onPick: (listener) => { pick.push(listener); },
    onEditEnd: (listener) => { editEnd.push(listener); },
    attachGizmo() {},
    setGizmoMode(_mode: GizmoMode) {},
    nameOf: (node) => node.name,
    async openUntracked(file) {
      const container = await LITE.loadGltf(engine, file);
      LITE.addToScene(scene, container);
      const roots = container.entities.filter((e): e is SceneNode => "children" in e && "position" in e);
      untracked.push(...roots);
      return `opened ${file.name} in Babylon Lite, outside the project (${roots.reduce((n, r) => n + meshesUnder(r), 0)} meshes)`;
    },
    untracked() {
      untracked = untracked.filter((n) => n.parent !== null || n.name === "__root__");
      return untracked;
    },
    adoptUntracked() {
      const ids = side.track(untracked);
      untracked = [];
      return ids;
    },
    disposeUntracked(node) {
      remove(node);
      untracked = untracked.filter((n) => n !== node);
    },
    addPrimitive(kind, color) {
      const mesh = kind === "box" ? LITE.createBox(engine, 1) : LITE.createSphere(engine, { diameter: 1, segments: 16 });
      mesh.name = `${kind}_${Math.random().toString(16).slice(2, 6)}`;
      const material = LITE.createPbrMaterial({ name: `${mesh.name}_material` });
      side.materialAdapter.write(material, { color, metallic: 0, roughness: 0.6 });
      mesh.material = material;
      LITE.addToScene(scene, mesh);
      side.track([mesh]);
      return side.entityOf(mesh) ?? mesh;
    },
    deleteNode(node) {
      remove(node);
      untracked = untracked.filter((n) => n !== node);
    },
    assignMaterial(node, name) {
      const slot = side.slotMeshes(node)[0];
      if (!slot) return;
      slot.material = (name && (side.material(name) ?? created.get(name))) || side.emptySlot;
    },
    createMaterial(name, state) {
      const material = LITE.createPbrMaterial({ name });
      side.materialAdapter.write(material, state);
      created.set(name, material);
      return name;
    },
    editMaterial(name, state) {
      const material = side.material(name);
      if (material) side.materialAdapter.write(material, state);
    },
    decorate() {
      for (const [id, entity] of Object.entries(side.read())) {
        if (entity.kind !== "light" && entity.kind !== "camera") continue;
        const node = side.node(id);
        if (!node || node.children.some((c) => c.name.endsWith("_marker"))) continue;
        const light = entity.kind === "light";
        const marker = light ? LITE.createSphere(engine, { diameter: 0.3, segments: 8 }) : LITE.createBox(engine, 0.4);
        marker.name = `${entity.name}_marker`;
        marker.material = LITE.createPbrMaterial({
          baseColorFactor: light ? [1, 0.85, 0.3, 1] : [0.6, 0.6, 0.65, 1], metallicFactor: 0, roughnessFactor: 1,
        });
        node.children.push(marker);
        marker.parent = node;
        LITE.addToScene(scene, marker);
      }
    },
  };
}
