import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, GizmoManager, HemisphericLight, LoadAssetContainerAsync,
  Material, Mesh, MeshBuilder, MultiMaterial, PBRMaterial, PointerEventTypes, Quaternion, Scene, SceneSerializer,
  StandardMaterial, SubMesh, TransformNode, Vector3, VertexBuffer, VertexData,
  type Node,
} from "@babylonjs/core";
import "@babylonjs/loaders";
import { BabylonSide } from "@knervous/blender-web/babylon";
import type { GizmoMode, Viewport } from "./viewport.ts";

export function createBabylonViewport(canvas: HTMLCanvasElement): Viewport<TransformNode> & { scene: Scene } {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.16, 0.16, 0.17, 1);

  const camera = new ArcRotateCamera("editor-camera", -Math.PI / 3, Math.PI / 3, 14, Vector3.Zero(), scene);
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 30;
  camera.minZ = 0.05;
  new HemisphericLight("editor-sky", new Vector3(0, 1, 0), scene).intensity = 0.8;
  new DirectionalLight("editor-sun", new Vector3(-0.5, -1, -0.3), scene).intensity = 0.9;
  const gridLines: Vector3[][] = [];
  for (let i = -10; i <= 10; i++) gridLines.push([new Vector3(i, 0, -10), new Vector3(i, 0, 10)], [new Vector3(-10, 0, i), new Vector3(10, 0, i)]);
  const grid = MeshBuilder.CreateLineSystem("editor-grid", { lines: gridLines }, scene);
  grid.color = new Color3(0.32, 0.32, 0.35);
  grid.isPickable = false;

  // The adapter uses this app's Babylon classes (the whole namespace works too).
  const side = new BabylonSide({
    Color3, Material, Mesh, MultiMaterial, PBRMaterial, Quaternion, StandardMaterial, SubMesh, TransformNode,
    VertexBuffer, VertexData,
  }, scene);
  /** Materials made here and not yet on a tracked mesh (so not yet project materials). */
  const created = new Map<string, PBRMaterial>();
  /** Content loaded into Babylon outside the project (until adopted). */
  let untracked: TransformNode[] = [];
  const untrackedRootOf = (node: Node | null): TransformNode | null => {
    for (let n = node; n; n = n.parent) if (n instanceof TransformNode && untracked.includes(n)) return n;
    return null;
  };

  const gizmos = new GizmoManager(scene);
  gizmos.usePointerToAttachGizmos = false;
  gizmos.positionGizmoEnabled = true;
  let attached: TransformNode | null = null;

  const pick: ((node: TransformNode | null) => void)[] = [];
  const editEnd: (() => void)[] = [];
  scene.onPointerObservable.add((info) => {
    if (info.type === PointerEventTypes.POINTERTAP && info.event.button === 0) {
      const mesh = info.pickInfo?.hit ? info.pickInfo.pickedMesh : null;
      const node = side.entityOf(mesh) ?? untrackedRootOf(mesh);
      for (const listener of pick) listener(node);
    } else if (info.type === PointerEventTypes.POINTERUP) {
      for (const listener of editEnd) listener();
    }
  });

  return {
    engine: "Babylon.js",
    scene,
    side,
    gizmos: true,
    formats: ["glb", "gltf", "obj", "stl", "babylon", "usdz", "usda", "usdc", "usd"],
    nativeExport: { label: ".babylon", file: "scene.babylon" },
    start() {
      engine.runRenderLoop(() => scene.render());
      window.addEventListener("resize", () => engine.resize());
    },
    onPick: (listener) => { pick.push(listener); },
    onEditEnd: (listener) => { editEnd.push(listener); },
    attachGizmo(node) {
      attached = node;
      gizmos.attachToNode(node);
    },
    setGizmoMode(mode: GizmoMode) {
      gizmos.positionGizmoEnabled = mode === "position";
      gizmos.rotationGizmoEnabled = mode === "rotation";
      gizmos.scaleGizmoEnabled = mode === "scale";
      gizmos.attachToNode(attached);
    },
    nameOf: (node) => node.name,
    async openUntracked(file) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      // A File, not its bytes: the text formats refuse an ArrayBufferView source.
      const container = await LoadAssetContainerAsync(file, scene, { pluginExtension: `.${ext}`, name: file.name });
      container.addAllToScene();
      scene.activeCamera = camera;
      untracked.push(...[...container.transformNodes, ...container.meshes].filter((n) => !n.parent));
      return `opened ${file.name} in Babylon, outside the project (${container.meshes.length} meshes)`;
    },
    untracked() {
      untracked = untracked.filter((n) => !n.isDisposed());
      return untracked;
    },
    adoptUntracked() {
      const ids = side.track(untracked);
      untracked = [];
      return ids;
    },
    disposeUntracked(node) {
      node.dispose(false, true);
      untracked = untracked.filter((n) => n !== node);
    },
    exportNative: async () => JSON.stringify(await SceneSerializer.SerializeAsync(scene)),
    addPrimitive(kind, color) {
      const name = `${kind}_${Math.random().toString(16).slice(2, 6)}`;
      const mesh = kind === "box"
        ? MeshBuilder.CreateBox(name, { size: 1 }, scene)
        : MeshBuilder.CreateSphere(name, { diameter: 1, segments: 16 }, scene);
      const material = new PBRMaterial(`${name}_material`, scene);
      side.materialAdapter.write(material, { color, metallic: 0, roughness: 0.6 });
      mesh.material = material;
      side.track([mesh]);
      return mesh;
    },
    deleteNode(node) {
      node.dispose(false, false);
      untracked = untracked.filter((n) => n !== node);
    },
    assignMaterial(node, name) {
      if (!(node instanceof Mesh)) return;
      const material = name ? side.material(name) ?? created.get(name) ?? null : null;
      if (node.material instanceof MultiMaterial) node.material.subMaterials[0] = material;
      else node.material = material;
    },
    createMaterial(name, state) {
      const material = new PBRMaterial(name, scene);
      side.materialAdapter.write(material, state);
      created.set(material.name, material);
      return material.name;
    },
    editMaterial(name, state) {
      const material = side.material(name);
      if (material) side.materialAdapter.write(material, state);
    },
    decorate() {
      for (const [id, entity] of Object.entries(side.read())) {
        if (entity.kind !== "light" && entity.kind !== "camera") continue;
        const node = side.node(id);
        if (!node || node.getChildMeshes(true).some((m) => m.metadata?.marker)) continue;
        const light = entity.kind === "light";
        const marker = light
          ? MeshBuilder.CreateSphere(`${entity.name}_marker`, { diameter: 0.3, segments: 8 }, scene)
          : MeshBuilder.CreateBox(`${entity.name}_marker`, { width: 0.5, height: 0.35, depth: 0.25 }, scene);
        const material = new StandardMaterial(`${entity.name}_marker`, scene);
        material.emissiveColor = light ? new Color3(1, 0.85, 0.3) : new Color3(0.6, 0.6, 0.65);
        material.disableLighting = true;
        material.wireframe = !light;
        marker.material = material;
        marker.parent = node;
        marker.metadata = { marker: true };
      }
    },
  };
}
