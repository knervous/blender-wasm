import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, GizmoManager, HemisphericLight, LoadAssetContainerAsync,
  MeshBuilder, PointerEventTypes, Scene, SceneSerializer, TransformNode, Vector3,
  type Node,
} from "@babylonjs/core";
import "@babylonjs/loaders";
import { BabylonSide } from "@knervous/blender-wasm/babylon";
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

  const side = new BabylonSide(scene);
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
      const ids = side.adopt(untracked);
      untracked = [];
      return ids;
    },
    disposeUntracked(node) {
      node.dispose(false, true);
      untracked = untracked.filter((n) => n !== node);
    },
    exportNative: async () => JSON.stringify(await SceneSerializer.SerializeAsync(scene)),
  };
}
