import {
  Color3, Material, Mesh, MeshBuilder, MultiMaterial, PBRMaterial, Quaternion, StandardMaterial, SubMesh,
  TransformNode, VertexBuffer, VertexData,
  type Node, type Scene,
} from "@babylonjs/core";
import type {
  Change, EntityKind, EntityState, Field, MaterialAssignment, MaterialState, MeshData, SceneSide, Transform,
} from "../../../sdk/project/index.ts";

/**
 * Babylon's side of a project.
 *
 * Every project entity lives under one root that turns Y 180° and mirrors Z, so node values are
 * the shared description's glTF-space values unchanged (the same trick as
 * Babylon's glTF loader). Project meshes keep glTF's counter-clockwise winding
 * and are oriented the way that loader orients them, so a mesh crosses as-is.
 *
 * Field adapters translate each field between a node and the shared
 * description; pass replacements to customise one.
 */
export interface FieldAdapter<V> {
  read(node: TransformNode, side: BabylonSide): V;
  write(node: TransformNode, value: V, side: BabylonSide): void;
}

export type FieldAdapters = { [F in Field]: FieldAdapter<EntityState[F]> };

interface EntityMetadata {
  bwId: string;
  bwKind: EntityKind;
  bwMaterials: (string | null)[];
}

const metadataOf = (node: Node): Partial<EntityMetadata> & { markerFor?: string } => node.metadata ?? {};

export const defaultAdapters: FieldAdapters = {
  name: {
    read: (node) => node.name,
    write: (node, value) => { node.name = value; },
  },
  parent: {
    read: (node, side) => side.idOf(node.parent),
    write: (node, value, side) => { node.parent = (value && side.node(value)) || side.root; },
  },
  transform: {
    read: (node) => {
      const r = node.rotationQuaternion ?? Quaternion.FromEulerVector(node.rotation);
      return {
        t: [node.position.x, node.position.y, node.position.z],
        r: [r.x, r.y, r.z, r.w],
        s: [node.scaling.x, node.scaling.y, node.scaling.z],
      } satisfies Transform;
    },
    write: (node, value) => {
      node.position.set(...value.t);
      node.rotationQuaternion = new Quaternion(...value.r);
      node.scaling.set(...value.s);
    },
  },
  visible: {
    read: (node) => node.isEnabled(false),
    write: (node, value) => node.setEnabled(value),
  },
  materials: {
    read: (node) => metadataOf(node).bwMaterials ?? [],
    write: (node, value, side) => side.assignMaterials(node, value),
  },
};

export class BabylonSide implements SceneSide {
  readonly root: TransformNode;
  private readonly entities = new Map<string, TransformNode>();
  private readonly materials = new Map<string, PBRMaterial>();
  private readonly materialStates = new Map<string, MaterialState>();
  private readonly adapters: FieldAdapters;

  constructor(readonly scene: Scene, options: { adapters?: Partial<FieldAdapters> } = {}) {
    this.adapters = { ...defaultAdapters, ...options.adapters };
    // Exactly the root Babylon's glTF loader builds in a left-handed scene, so a
    // project looks as the same file would through that loader, and adopted
    // glTF content keeps its own coordinates.
    this.root = new TransformNode("project-root", scene);
    this.root.rotationQuaternion = new Quaternion(0, 1, 0, 0);
    this.root.scaling.z = -1;
  }

  // --- lookups ------------------------------------------------------------------
  node(id: string): TransformNode | undefined {
    return this.entities.get(id);
  }

  idOf(node: Node | null): string | null {
    const id = node ? metadataOf(node).bwId : undefined;
    return id && this.entities.has(id) ? id : null;
  }

  /** The entity a picked mesh belongs to (through markers and sub-nodes), if any. */
  entityOf(node: Node | null): TransformNode | null {
    for (let n = node; n && n !== this.root; n = n.parent) {
      const meta = metadataOf(n);
      const id = meta.markerFor ?? meta.bwId;
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
        kind: metadataOf(node).bwKind ?? "empty",
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
    return node instanceof Mesh ? readMesh(node) : null;
  }

  materialsOf(id: string): MaterialAssignment[] {
    const node = this.entities.get(id);
    return (node ? this.adapters.materials.read(node, this) : [])
      .filter((name): name is string => Boolean(name))
      .map((name) => ({ name, props: this.materialStates.get(name) }));
  }

  apply(changes: Change[]): void {
    for (const change of changes) if (change.op === "material") this.upsertMaterial(change.name, change.value);
    const created: [TransformNode, EntityState][] = [];
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

  // --- editing from Babylon --------------------------------------------------------
  /** A new mesh entity made on the Babylon side; it reaches Blender on the next sync. */
  createPrimitive(kind: "box" | "sphere", options: { name?: string; color?: Color3 } = {}): Mesh {
    const data = kind === "box" ? VertexData.CreateBox({ size: 1 }) : VertexData.CreateSphere({ diameter: 1, segments: 16 });
    const id = newId();
    const mesh = this.buildMesh(options.name ?? `${kind}_${id.slice(0, 4)}`, canonicalFromVertexData(data));
    this.register(mesh, id, "mesh");
    mesh.parent = this.root;
    const color = options.color ?? new Color3(0.31, 0.64, 0.88);
    const name = `babylon_${color.toHexString().slice(1).toLowerCase()}`;
    this.upsertMaterial(name, { color: [color.r, color.g, color.b, 1], metallic: 0, roughness: 0.6 });
    this.assignMaterials(mesh, [name]);
    return mesh;
  }

  /**
   * Brings untracked Babylon content (a loaded .babylon, USD, ...) into the
   * project: reparented under the root keeping its world placement, meshes
   * rewritten to glTF winding, materials turned into project materials.
   */
  adopt(nodes: TransformNode[]): string[] {
    const ids: string[] = [];
    const visit = (node: TransformNode): void => {
      const id = newId();
      if (node instanceof Mesh && node.getTotalVertices() > 0) {
        const data = VertexData.ExtractFromMesh(node);
        const canonical = canonicalFromVertexData(data);
        applyMesh(node, canonical);
        const source = node.material;
        const name = source?.name || `adopted_${id.slice(0, 4)}`;
        this.upsertMaterial(name, materialStateOf(source));
        this.register(node, id, "mesh");
        this.assignMaterials(node, [name]);
      } else {
        this.register(node, id, "empty");
      }
      ids.push(id);
      for (const child of node.getChildren((c): c is TransformNode => c instanceof TransformNode, true)) visit(child);
    };
    // Loader handedness roots (glTF's __root__) are not content: adopt through them.
    const content = nodes.flatMap((node) => node.name === "__root__"
      ? node.getChildren((c): c is TransformNode => c instanceof TransformNode, true)
      : [node]);
    for (const node of content) {
      node.setParent(this.root);
      visit(node);
    }
    for (const node of nodes) if (node.name === "__root__" && node.getChildren().length === 0) node.dispose();
    return ids;
  }

  /** Removes an entity and every entity under it; the next sync deletes them in Blender. */
  remove(id: string): void {
    const node = this.entities.get(id);
    if (!node) return;
    for (const [otherId, other] of this.entities) {
      if (other === node || other.isDescendantOf(node)) this.entities.delete(otherId);
    }
    node.dispose(false, false);
  }

  assignMaterials(node: TransformNode, names: (string | null)[]): void {
    const meta = metadataOf(node);
    meta.bwMaterials = [...names];
    node.metadata = meta;
    if (!(node instanceof Mesh)) return;
    const materials = names.map((name) => (name ? this.materials.get(name) ?? null : null));
    if (materials.length <= 1) {
      node.material = materials[0] ?? null;
      return;
    }
    const multi = new MultiMaterial(`${node.name}_slots`, this.scene);
    multi.subMaterials = materials;
    node.material = multi;
  }

  // --- internals ------------------------------------------------------------------
  private writeField(node: TransformNode, field: Field, value: unknown): void {
    switch (field) {
      case "name": return this.adapters.name.write(node, String(value), this);
      case "parent": return this.adapters.parent.write(node, typeof value === "string" ? value : null, this);
      case "transform": if (isTransform(value)) this.adapters.transform.write(node, value, this); return;
      case "visible": return this.adapters.visible.write(node, Boolean(value), this);
      case "materials": if (isSlotList(value)) this.adapters.materials.write(node, value, this); return;
    }
  }

  private register(node: TransformNode, id: string, kind: EntityKind): void {
    node.metadata = { ...node.metadata, bwId: id, bwKind: kind, bwMaterials: metadataOf(node).bwMaterials ?? [] };
    this.entities.set(id, node);
  }

  private create(entity: EntityState, mesh: MeshData | undefined): TransformNode {
    const node = entity.kind === "mesh" && mesh
      ? this.buildMesh(entity.name, mesh)
      : new TransformNode(entity.name, this.scene);
    this.register(node, entity.id, entity.kind);
    if (entity.kind === "light" || entity.kind === "camera") this.addMarker(node, entity);
    this.adapters.name.write(node, entity.name, this);
    this.adapters.transform.write(node, entity.transform, this);
    this.adapters.visible.write(node, entity.visible, this);
    return node;
  }

  private buildMesh(name: string, mesh: MeshData): Mesh {
    const node = new Mesh(name, this.scene);
    applyMesh(node, mesh);
    return node;
  }

  private replaceGeometry(id: string, mesh: MeshData): void {
    const node = this.entities.get(id);
    if (!node) return;
    if (node instanceof Mesh) {
      applyMesh(node, mesh);
      this.assignMaterials(node, metadataOf(node).bwMaterials ?? []);
      return;
    }
    // An empty that became a mesh: swap the node, keep children and fields.
    const replacement = this.buildMesh(node.name, mesh);
    replacement.metadata = node.metadata;
    replacement.parent = node.parent;
    replacement.position.copyFrom(node.position);
    replacement.rotationQuaternion = node.rotationQuaternion?.clone() ?? Quaternion.FromEulerVector(node.rotation);
    replacement.scaling.copyFrom(node.scaling);
    for (const child of node.getChildren()) child.parent = replacement;
    this.entities.set(id, replacement);
    node.dispose(true);
  }

  /** Edit a material's properties (or create it); every entity using it changes. */
  setMaterial(name: string, state: MaterialState): void {
    this.upsertMaterial(name, state);
  }

  materialNames(): string[] {
    return [...this.materialStates.keys()].sort();
  }

  materialState(name: string): MaterialState | undefined {
    return this.materialStates.get(name);
  }

  private upsertMaterial(name: string, state: MaterialState): void {
    let material = this.materials.get(name);
    if (!material) {
      material = new PBRMaterial(name, this.scene);
      this.materials.set(name, material);
    }
    material.albedoColor = new Color3(state.color[0], state.color[1], state.color[2]);
    material.alpha = state.color[3];
    material.metallic = state.metallic;
    material.roughness = state.roughness;
    this.materialStates.set(name, state);
  }

  private addMarker(node: TransformNode, entity: EntityState): void {
    const marker = entity.kind === "light"
      ? MeshBuilder.CreateSphere(`${entity.name}_marker`, { diameter: 0.3, segments: 8 }, this.scene)
      : MeshBuilder.CreateBox(`${entity.name}_marker`, { width: 0.5, height: 0.35, depth: 0.25 }, this.scene);
    const material = new StandardMaterial(`${entity.name}_marker`, this.scene);
    material.emissiveColor = entity.kind === "light" ? new Color3(1, 0.85, 0.3) : new Color3(0.6, 0.6, 0.65);
    material.disableLighting = true;
    material.wireframe = entity.kind === "camera";
    marker.material = material;
    marker.parent = node;
    marker.metadata = { markerFor: entity.id };
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

/** Babylon vertex data (left-handed winding, bottom-left UVs) as glTF-space mesh data. */
function canonicalFromVertexData(data: VertexData): MeshData {
  const positions = data.positions ?? [];
  const normals = data.normals ?? [];
  const uvs = data.uvs;
  const indices = data.indices ?? Array.from({ length: positions.length / 3 }, (_, i) => i);
  const n = indices.length;
  const out: MeshData = {
    vertexCount: n,
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    uvs: uvs ? new Float32Array(n * 2) : undefined,
    groups: [[0, 0, n]],
  };
  for (let tri = 0; tri < n; tri += 3) {
    // Reverse each triangle: Babylon's clockwise front faces are glTF's counter-clockwise.
    const corners = [indices[tri], indices[tri + 2], indices[tri + 1]];
    corners.forEach((vertex, k) => {
      const v = tri + k;
      for (let c = 0; c < 3; c++) {
        out.positions[v * 3 + c] = positions[vertex * 3 + c];
        out.normals[v * 3 + c] = normals[vertex * 3 + c];
      }
      if (uvs && out.uvs) {
        out.uvs[v * 2] = uvs[vertex * 2];
        out.uvs[v * 2 + 1] = 1 - uvs[vertex * 2 + 1];
      }
    });
  }
  return out;
}

/** glTF-space mesh data onto a Babylon mesh, one sub-mesh per material group. */
function applyMesh(node: Mesh, mesh: MeshData): void {
  const data = new VertexData();
  data.positions = mesh.positions;
  data.normals = mesh.normals;
  if (mesh.uvs) {
    const uvs = new Float32Array(mesh.uvs);
    for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
    data.uvs = uvs;
  }
  data.indices = Uint32Array.from({ length: mesh.vertexCount }, (_, i) => i);
  data.applyToMesh(node, true);
  // What Babylon's own glTF loader sets for glTF's counter-clockwise data under
  // the mirrored root in a left-handed scene (Babylon 9 orients per mesh).
  node.sideOrientation = Material.ClockWiseSideOrientation;
  node.subMeshes = [];
  for (const [slot, start, count] of mesh.groups) {
    new SubMesh(slot, 0, mesh.vertexCount, start, count, node);
  }
  if (node.subMeshes.length === 0) node.subMeshes.push(new SubMesh(0, 0, mesh.vertexCount, 0, mesh.vertexCount, node));
}

/** A project mesh's data as stored (already glTF space, unindexed or not). */
function readMesh(node: Mesh): MeshData | null {
  const positions = node.getVerticesData(VertexBuffer.PositionKind);
  const normals = node.getVerticesData(VertexBuffer.NormalKind);
  if (!positions || !normals) return null;
  const uvs = node.getVerticesData(VertexBuffer.UVKind);
  const indices = node.getIndices() ?? Array.from({ length: positions.length / 3 }, (_, i) => i);
  const n = indices.length;
  const out: MeshData = {
    vertexCount: n,
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    uvs: uvs ? new Float32Array(n * 2) : undefined,
    groups: node.subMeshes.map((sub) => [sub.materialIndex, sub.indexStart, sub.indexCount]),
  };
  for (let v = 0; v < n; v++) {
    const vertex = indices[v];
    for (let c = 0; c < 3; c++) {
      out.positions[v * 3 + c] = positions[vertex * 3 + c];
      out.normals[v * 3 + c] = normals[vertex * 3 + c];
    }
    if (uvs && out.uvs) {
      out.uvs[v * 2] = uvs[vertex * 2];
      out.uvs[v * 2 + 1] = 1 - uvs[vertex * 2 + 1];
    }
  }
  return out;
}

function materialStateOf(material: Material | null): MaterialState {
  if (material instanceof PBRMaterial) {
    const c = material.albedoColor;
    return { color: [c.r, c.g, c.b, material.alpha], metallic: material.metallic ?? 0, roughness: material.roughness ?? 0.5 };
  }
  if (material instanceof StandardMaterial) {
    const c = material.diffuseColor;
    return { color: [c.r, c.g, c.b, material.alpha], metallic: 0, roughness: 1 - Math.min(1, material.specularPower / 128) };
  }
  return { color: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.5 };
}

