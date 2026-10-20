import {
  BoxGeometry, Color, DirectionalLight, GridHelper, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Object3D, PerspectiveCamera, Raycaster, SRGBColorSpace, Scene, SphereGeometry, Vector2, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { ThreeSide, defaultMaterialAdapter } from "@knervous/blender-web/three";
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
  /** Materials made here and not yet on a tracked mesh (so not yet project materials). */
  const created = new Map<string, MeshStandardMaterial>();
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
      const ids = side.track(untracked);
      untracked = [];
      return ids;
    },
    disposeUntracked(node) {
      node.removeFromParent();
      node.traverse((n) => { if (n instanceof Mesh) n.geometry.dispose(); });
      untracked = untracked.filter((n) => n !== node);
    },
    addPrimitive(kind, color) {
      const name = `${kind}_${Math.random().toString(16).slice(2, 6)}`;
      const material = new MeshStandardMaterial({ name: `${name}_material` });
      defaultMaterialAdapter.write(material, { color, metallic: 0, roughness: 0.6 });
      const mesh = new Mesh(kind === "box" ? new BoxGeometry(1, 1, 1) : new SphereGeometry(0.5, 32, 16), material);
      mesh.name = name;
      scene.add(mesh);
      side.track([mesh]);
      return mesh;
    },
    deleteNode(node) {
      node.removeFromParent();
      node.traverse((n) => { if (n instanceof Mesh) n.geometry.dispose(); });
      untracked = untracked.filter((n) => n !== node);
    },
    assignMaterial(node, name) {
      if (!(node instanceof Mesh)) return;
      const material = (name && (side.material(name) ?? created.get(name))) || side.emptySlot;
      if (Array.isArray(node.material)) node.material = [material, ...node.material.slice(1)];
      else node.material = material;
    },
    createMaterial(name, state) {
      const material = new MeshStandardMaterial({ name });
      defaultMaterialAdapter.write(material, state);
      created.set(material.name, material);
      return material.name;
    },
    editMaterial(name, state) {
      const material = side.material(name);
      if (material) defaultMaterialAdapter.write(material, state);
    },
    decorate() {
      for (const [id, entity] of Object.entries(side.read())) {
        if (entity.kind !== "light" && entity.kind !== "camera") continue;
        const node = side.node(id);
        if (!node || node.children.some((c) => c.userData.marker)) continue;
        const light = entity.kind === "light";
        const marker = new Mesh(
          light ? new SphereGeometry(0.15, 12, 8) : new BoxGeometry(0.5, 0.35, 0.25),
          new MeshBasicMaterial({ color: light ? 0xffd94d : 0x999aa6, wireframe: !light }),
        );
        marker.name = `${entity.name}_marker`;
        marker.userData = { marker: true };
        node.add(marker);
      }
    },
    async exportNative() {
      const glb = await new GLTFExporter().parseAsync([side.root, ...untracked], { binary: true });
      if (glb instanceof ArrayBuffer) return glb;
      return JSON.stringify(glb);
    },
  };
}
