import {
  BoxGeometry, BufferAttribute, BufferGeometry, Camera, Color, Group, Light, LinearSRGBColorSpace, Material, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Object3D, SphereGeometry,
} from "three";
import type {
  Change, EngineSide, EntityKind, EntityState, Field, MaterialAssignment, MaterialState, MeshData, Primitive, Rgba,
  Transform,
} from "../project/index.ts";

/**
 * three.js side of a project (`@knervous/blender-wasm/three`).
 *
 * three.js is Y up, right handed and counter-clockwise, as glTF is, so the
 * project root is an identity Group and node values are the shared
 * description's values unchanged. Meshes keep glTF's UV origin (top left),
 * as GLTFLoader leaves them; textures on them want `flipY = false`.
 *
 * Field adapters translate each field between an Object3D and the shared
 * description; pass replacements to customise one.
 */
export interface FieldAdapter<V> {
  read(node: Object3D, side: ThreeSide): V;
  write(node: Object3D, value: V, side: ThreeSide): void;
}

export type FieldAdapters = { [F in Field]: FieldAdapter<EntityState[F]> };

interface EntityData {
  bwId?: string;
  bwKind?: EntityKind;
  bwMaterials?: (string | null)[];
  markerFor?: string;
}

const dataOf = (node: Object3D): EntityData => node.userData;

export const defaultAdapters: FieldAdapters = {
  name: {
    read: (node) => node.name,
    write: (node, value) => { node.name = value; },
  },
  parent: {
    read: (node, side) => side.idOf(node.parent),
    write: (node, value, side) => { ((value && side.node(value)) || side.root).add(node); },
  },
  transform: {
    read: (node) => ({
      t: [node.position.x, node.position.y, node.position.z],
      r: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
      s: [node.scale.x, node.scale.y, node.scale.z],
    } satisfies Transform),
    write: (node, value) => {
      node.position.set(...value.t);
      node.quaternion.set(...value.r);
      node.scale.set(...value.s);
    },
  },
  visible: {
    read: (node) => node.visible,
    write: (node, value) => { node.visible = value; },
  },
  materials: {
    read: (node) => dataOf(node).bwMaterials ?? [],
    write: (node, value, side) => side.assignMaterials(node, value),
  },
};

export class ThreeSide implements EngineSide<Object3D> {
  readonly root = new Group();
  private readonly entities = new Map<string, Object3D>();
  private readonly materials = new Map<string, MeshStandardMaterial>();
  private readonly materialStates = new Map<string, MaterialState>();
  private readonly adapters: FieldAdapters;
  /** What an empty slot renders with. */
  private readonly fallback = new MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5 });

  /** Adds the project root to `scene` (any Object3D). */
  constructor(readonly scene: Object3D, options: { adapters?: Partial<FieldAdapters> } = {}) {
    this.adapters = { ...defaultAdapters, ...options.adapters };
    this.root.name = "project-root";
    scene.add(this.root);
  }

  // --- lookups ------------------------------------------------------------------
  node(id: string): Object3D | undefined {
    return this.entities.get(id);
  }

  idOf(node: Object3D | null): string | null {
    const id = node ? dataOf(node).bwId : undefined;
    return id && this.entities.has(id) ? id : null;
  }

  entityOf(node: Object3D | null): Object3D | null {
    for (let n = node; n && n !== this.root; n = n.parent) {
      const data = dataOf(n);
      const id = data.markerFor ?? data.bwId;
      if (id && this.entities.has(id)) return this.entities.get(id) ?? null;
    }
    return null;
  }

  ids(): string[] {
    return [...this.entities.keys()];
  }

  // --- SceneSide ------------------------------------------------------------------
  read(): Record<string, EntityState> {
    const out: Record<string, EntityState> = {};
    for (const [id, node] of this.entities) {
      out[id] = {
        id,
        kind: dataOf(node).bwKind ?? "empty",
        name: this.adapters.name.read(node, this),
        parent: this.adapters.parent.read(node, this),
        transform: this.adapters.transform.read(node, this),
        visible: this.adapters.visible.read(node, this),
        materials: this.adapters.materials.read(node, this),
      };
    }
    return out;
  }

  readMaterials(): Record<string, MaterialState> {
    return Object.fromEntries(this.materialStates);
  }

  meshData(id: string): MeshData | null {
    const node = this.entities.get(id);
    return node instanceof Mesh ? readGeometry(node.geometry) : null;
  }

  materialsOf(id: string): MaterialAssignment[] {
    const node = this.entities.get(id);
    return (node ? this.adapters.materials.read(node, this) : [])
      .filter((name): name is string => Boolean(name))
      .map((name) => ({ name, props: this.materialStates.get(name) }));
  }

  apply(changes: Change[]): void {
    for (const change of changes) if (change.op === "material") this.upsertMaterial(change.name, change.value);
    const created: [Object3D, EntityState][] = [];
    for (const change of changes) {
      if (change.op === "create") created.push([this.create(change.entity, change.mesh), change.entity]);
    }
    // Parents after every create, so order within a report does not matter.
    for (const [node, entity] of created) {
      this.adapters.parent.write(node, entity.parent, this);
      this.adapters.materials.write(node, entity.materials, this);
    }
    for (const change of changes) {
      if (change.op === "update") {
        const node = this.entities.get(change.id);
        if (node) this.writeField(node, change.field, change.value);
      } else if (change.op === "geometry") {
        this.replaceGeometry(change.id, change.mesh);
      } else if (change.op === "delete") {
        this.remove(change.id);
      }
    }
  }

  // --- editing from three.js -------------------------------------------------------
  createPrimitive(kind: Primitive, options: { name?: string; color?: Rgba } = {}): Mesh {
    const source = kind === "box" ? new BoxGeometry(1, 1, 1) : new SphereGeometry(0.5, 32, 16);
    const data = readGeometry(source, { flipV: true });
    source.dispose();
    if (!data) throw new Error(`three.js built no ${kind}`);
    const id = newId();
    const mesh = new Mesh(buildGeometry(data), this.fallback);
    mesh.name = options.name ?? `${kind}_${id.slice(0, 4)}`;
    this.register(mesh, id, "mesh");
    this.root.add(mesh);
    const color = options.color ?? [0.31, 0.64, 0.88, 1];
    const name = `material_${new Color().setRGB(color[0], color[1], color[2], LinearSRGBColorSpace).getHexString()}`;
    this.upsertMaterial(name, { color, metallic: 0, roughness: 0.6 });
    this.assignMaterials(mesh, [name]);
    return mesh;
  }

  /**
   * Brings untracked three.js content (a GLTFLoader scene, OBJ, ...) into the
   * project: reparented under the root keeping its world placement, meshes
   * rewritten as unindexed glTF-space data, materials turned into project
   * materials.
   */
  adopt(nodes: Object3D[]): string[] {
    const ids: string[] = [];
    const visit = (node: Object3D): void => {
      const id = newId();
      if (node instanceof Mesh && node.geometry instanceof BufferGeometry && node.geometry.getAttribute("position")) {
        const data = readGeometry(node.geometry);
        if (data) {
          node.geometry.dispose();
          node.geometry = buildGeometry(data);
        }
        const sources: Material[] = Array.isArray(node.material) ? node.material : [node.material];
        const names = sources.map((source, slot) => {
          const name = source.name || `adopted_${id.slice(0, 4)}${sources.length > 1 ? `_${slot}` : ""}`;
          this.upsertMaterial(name, materialStateOf(source));
          return name;
        });
        this.register(node, id, "mesh");
        this.assignMaterials(node, names);
      } else {
        this.register(node, id, node instanceof Light ? "light" : node instanceof Camera ? "camera" : "empty");
      }
      ids.push(id);
      for (const child of [...node.children]) visit(child);
    };
    for (const node of nodes) {
      this.root.attach(node);
      visit(node);
    }
    return ids;
  }

  remove(id: string): void {
    const node = this.entities.get(id);
    if (!node) return;
    for (const [otherId, other] of this.entities) {
      if (other === node || isDescendant(other, node)) this.entities.delete(otherId);
    }
    node.removeFromParent();
    node.traverse((n) => { if (n instanceof Mesh) n.geometry.dispose(); });
  }

  assignMaterials(node: Object3D, names: (string | null)[]): void {
    dataOf(node).bwMaterials = [...names];
    if (!(node instanceof Mesh)) return;
    const materials = names.map((name) => (name && this.materials.get(name)) || this.fallback);
    node.material = materials.length <= 1 ? materials[0] ?? this.fallback : materials;
  }

  setMaterial(name: string, state: MaterialState): void {
    this.upsertMaterial(name, state);
  }

  materialNames(): string[] {
    return [...this.materialStates.keys()].sort();
  }

  materialState(name: string): MaterialState | undefined {
    return this.materialStates.get(name);
  }

  // --- internals ------------------------------------------------------------------
  private writeField(node: Object3D, field: Field, value: unknown): void {
    switch (field) {
      case "name": return this.adapters.name.write(node, String(value), this);
      case "parent": return this.adapters.parent.write(node, typeof value === "string" ? value : null, this);
      case "transform": if (isTransform(value)) this.adapters.transform.write(node, value, this); return;
      case "visible": return this.adapters.visible.write(node, Boolean(value), this);
      case "materials": if (isSlotList(value)) this.adapters.materials.write(node, value, this); return;
    }
  }

  private register(node: Object3D, id: string, kind: EntityKind): void {
    const data = dataOf(node);
    data.bwId = id;
    data.bwKind = kind;
    data.bwMaterials ??= [];
    this.entities.set(id, node);
  }

  private create(entity: EntityState, mesh: MeshData | undefined): Object3D {
    const node = entity.kind === "mesh" && mesh ? new Mesh(buildGeometry(mesh), this.fallback) : new Group();
    this.register(node, entity.id, entity.kind);
    if (entity.kind === "light" || entity.kind === "camera") this.addMarker(node, entity);
    this.adapters.name.write(node, entity.name, this);
    this.adapters.transform.write(node, entity.transform, this);
    this.adapters.visible.write(node, entity.visible, this);
    this.root.add(node);
    return node;
  }

  private replaceGeometry(id: string, mesh: MeshData): void {
    const node = this.entities.get(id);
    if (!node) return;
    if (node instanceof Mesh) {
      node.geometry.dispose();
      node.geometry = buildGeometry(mesh);
      this.assignMaterials(node, dataOf(node).bwMaterials ?? []);
      return;
    }
    // An empty that became a mesh: swap the node, keep children and fields.
    const replacement = new Mesh(buildGeometry(mesh), this.fallback);
    replacement.name = node.name;
    replacement.userData = node.userData;
    replacement.position.copy(node.position);
    replacement.quaternion.copy(node.quaternion);
    replacement.scale.copy(node.scale);
    replacement.visible = node.visible;
    for (const child of [...node.children]) replacement.add(child);
    (node.parent ?? this.root).add(replacement);
    node.removeFromParent();
    this.entities.set(id, replacement);
    this.assignMaterials(replacement, dataOf(replacement).bwMaterials ?? []);
  }

  private upsertMaterial(name: string, state: MaterialState): void {
    let material = this.materials.get(name);
    if (!material) {
      material = new MeshStandardMaterial({ name });
      this.materials.set(name, material);
    }
    material.color.setRGB(state.color[0], state.color[1], state.color[2], LinearSRGBColorSpace);
    material.opacity = state.color[3];
    material.transparent = state.color[3] < 1;
    material.metalness = state.metallic;
    material.roughness = state.roughness;
    this.materialStates.set(name, state);
  }

  private addMarker(node: Object3D, entity: EntityState): void {
    const light = entity.kind === "light";
    const marker = new Mesh(
      light ? new SphereGeometry(0.15, 12, 8) : new BoxGeometry(0.5, 0.35, 0.25),
      new MeshBasicMaterial({ color: light ? 0xffd94d : 0x999aa6, wireframe: !light }),
    );
    marker.name = `${entity.name}_marker`;
    marker.userData = { markerFor: entity.id };
    node.add(marker);
  }
}

const isNumbers = (value: unknown, length: number): boolean =>
  Array.isArray(value) && value.length === length && value.every((v) => typeof v === "number");

function isTransform(value: unknown): value is Transform {
  if (typeof value !== "object" || value === null) return false;
  return isNumbers(Reflect.get(value, "t"), 3) && isNumbers(Reflect.get(value, "r"), 4)
    && isNumbers(Reflect.get(value, "s"), 3);
}

const isSlotList = (value: unknown): value is (string | null)[] =>
  Array.isArray(value) && value.every((v) => v === null || typeof v === "string");

const newId = (): string => crypto.randomUUID().replaceAll("-", "");

function isDescendant(node: Object3D, ancestor: Object3D): boolean {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/** glTF-space mesh data as an unindexed BufferGeometry, one group per material slot. */
function buildGeometry(mesh: MeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(mesh.normals, 3));
  if (mesh.uvs) geometry.setAttribute("uv", new BufferAttribute(mesh.uvs, 2));
  for (const [slot, start, count] of mesh.groups) geometry.addGroup(start, count, slot);
  if (mesh.groups.length === 0) geometry.addGroup(0, mesh.vertexCount, 0);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A geometry's triangles as glTF-space mesh data (unindexed). `flipV` turns
 * three.js's own bottom-left UVs (its primitives) into glTF's top-left ones.
 */
function readGeometry(geometry: BufferGeometry, options: { flipV?: boolean } = {}): MeshData | null {
  const position = geometry.getAttribute("position");
  if (!position) return null;
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const index = geometry.getIndex();
  const n = index ? index.count : position.count;
  const out: MeshData = {
    vertexCount: n,
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    uvs: uv ? new Float32Array(n * 2) : undefined,
    groups: geometry.groups.length
      ? geometry.groups.map((g) => [g.materialIndex ?? 0, g.start, Math.min(g.count, n - g.start)])
      : [[0, 0, n]],
  };
  for (let v = 0; v < n; v++) {
    const vertex = index ? index.getX(v) : v;
    out.positions[v * 3] = position.getX(vertex);
    out.positions[v * 3 + 1] = position.getY(vertex);
    out.positions[v * 3 + 2] = position.getZ(vertex);
    out.normals[v * 3] = normal.getX(vertex);
    out.normals[v * 3 + 1] = normal.getY(vertex);
    out.normals[v * 3 + 2] = normal.getZ(vertex);
    if (uv && out.uvs) {
      out.uvs[v * 2] = uv.getX(vertex);
      out.uvs[v * 2 + 1] = options.flipV ? 1 - uv.getY(vertex) : uv.getY(vertex);
    }
  }
  return out;
}

function materialStateOf(material: Material): MaterialState {
  const color = Reflect.get(material, "color");
  const c = color instanceof Color ? color : new Color(0.8, 0.8, 0.8);
  const metalness = Reflect.get(material, "metalness");
  const roughness = Reflect.get(material, "roughness");
  return {
    color: [c.r, c.g, c.b, material.opacity],
    metallic: typeof metalness === "number" ? metalness : 0,
    roughness: typeof roughness === "number" ? roughness : 0.5,
  };
}
