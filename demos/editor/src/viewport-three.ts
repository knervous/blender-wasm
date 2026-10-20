import {
  Color, DirectionalLight, GridHelper, HemisphereLight, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera,
  Raycaster, SRGBColorSpace, Scene, Vector2, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { ThreeSide } from "@knervous/blender-wasm/three";
import type { GizmoMode, Viewport } from "./viewport.ts";

export function createThreeViewport(canvas: HTMLCanvasElement): Viewport<Object3D> & { scene: Scene } {
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const scene = new Scene();
  scene.background = new Color().setRGB(0.16, 0.16, 0.17, SRGBColorSpace);

  const camera = new PerspectiveCamera(50, 1, 0.05, 1000);
  camera.position.set(6, 7, 10);
  const orbit = new OrbitControls(camera, canvas);
  orbit.enableDamping = true;
  scene.add(new HemisphereLight(0xffffff, 0x444448, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(5, 10, 3);
  scene.add(sun);
  const grid = new GridHelper(20, 20, 0x525259, 0x3a3a3f);
  scene.add(grid);

  const side = new ThreeSide(scene);
  /** Content loaded into three.js outside the project (until adopted). */
  let untracked: Object3D[] = [];
  const untrackedRootOf = (node: Object3D | null): Object3D | null => {
    for (let n = node; n; n = n.parent) if (untracked.includes(n)) return n;
    return null;
  };

  const gizmo = new TransformControls(camera, canvas);
  scene.add(gizmo.getHelper());
  const pick: ((node: Object3D | null) => void)[] = [];
  const editEnd: (() => void)[] = [];
  gizmo.addEventListener("dragging-changed", (event) => {
    orbit.enabled = !event.value;
    if (!event.value) for (const listener of editEnd) listener();
  });

  // A tap is a pointer down and up without much movement in between.
  const raycaster = new Raycaster();
  let down: Vector2 | null = null;
  canvas.addEventListener("pointerdown", (event) => { down = new Vector2(event.clientX, event.clientY); });
  canvas.addEventListener("pointerup", (event) => {
    const start = down;
    down = null;
    if (!start || event.button !== 0 || gizmo.dragging) return;
    if (start.distanceTo(new Vector2(event.clientX, event.clientY)) > 4) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    ), camera);
    const hit = raycaster.intersectObjects([side.root, ...untracked], true).find((h) => h.object.visible);
    const object = hit?.object ?? null;
    const node = side.entityOf(object) ?? untrackedRootOf(object);
    for (const listener of pick) listener(node);
  });

  const resize = (): void => {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const load = async (file: File): Promise<Object3D> => {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "glb" || ext === "gltf") {
      const url = URL.createObjectURL(file);
      try { return (await new GLTFLoader().loadAsync(url)).scene; } finally { URL.revokeObjectURL(url); }
    }
    if (ext === "obj") return new OBJLoader().parse(await file.text());
    if (ext === "stl") {
      const mesh = new Mesh(new STLLoader().parse(await file.arrayBuffer()), new MeshStandardMaterial({ name: file.name }));
      mesh.name = file.name;
      return mesh;
    }
    throw new Error(`three.js does not open .${ext} here`);
  };

  return {
    engine: "three.js",
    scene,
    side,
    formats: ["glb", "gltf", "obj", "stl"],
    nativeExport: { label: "three .glb", file: "scene-three.glb" },
    start() {
      new ResizeObserver(resize).observe(canvas);
      resize();
      renderer.setAnimationLoop(() => {
        orbit.update();
        renderer.render(scene, camera);
      });
    },
    onPick: (listener) => { pick.push(listener); },
    onEditEnd: (listener) => { editEnd.push(listener); },
    attachGizmo(node) {
      if (node) gizmo.attach(node);
      else gizmo.detach();
    },
    setGizmoMode(mode: GizmoMode) {
      gizmo.setMode(mode === "position" ? "translate" : mode === "rotation" ? "rotate" : "scale");
    },
    nameOf: (node) => node.name || node.type,
    async openUntracked(file) {
      const root = await load(file);
      if (!root.name) root.name = file.name;
      scene.add(root);
      untracked.push(root);
      let meshes = 0;
      root.traverse((n) => { if (n instanceof Mesh) meshes++; });
      return `opened ${file.name} in three.js, outside the project (${meshes} meshes)`;
    },
    untracked() {
      untracked = untracked.filter((n) => n.parent !== null);
      return untracked;
    },
    adoptUntracked() {
      const ids = side.adopt(untracked);
      untracked = [];
      return ids;
    },
    disposeUntracked(node) {
      node.removeFromParent();
      node.traverse((n) => { if (n instanceof Mesh) n.geometry.dispose(); });
      untracked = untracked.filter((n) => n !== node);
    },
    async exportNative() {
      const glb = await new GLTFExporter().parseAsync([side.root, ...untracked], { binary: true });
      if (glb instanceof ArrayBuffer) return glb;
      return JSON.stringify(glb);
    },
  };
}
