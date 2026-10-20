/**
 * The shared description both sides of a project are translated into.
 *
 * Everything is in glTF space: Y up, right handed, metres, quaternions as
 * [x, y, z, w]. Blender's Z-up is converted in protocol.py and nowhere else;
 * a scene side converts its own conventions in its field adapters.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Rgba = [number, number, number, number];

/** A node's transform relative to its parent entity (or the scene root). */
export interface Transform {
  t: Vec3;
  r: Quat;
  s: Vec3;
}

export type EntityKind = "mesh" | "empty" | "light" | "camera" | "other";

/** One object, as both sides agree to describe it. `id` is stable across renames. */
export interface EntityState {
  id: string;
  name: string;
  kind: EntityKind;
  parent: string | null;
  transform: Transform;
  visible: boolean;
  /** Material per slot, by material name. */
  materials: (string | null)[];
  /** Blender's fingerprint of the evaluated mesh; only Blender computes it. */
  geometry?: string;
}

export interface MaterialState {
  color: Rgba;
  metallic: number;
  roughness: number;
}

export interface Snapshot {
  entities: Record<string, EntityState>;
  materials: Record<string, MaterialState>;
}

/**
 * Triangles as consecutive vertex triples (counter-clockwise, glTF), grouped
 * by material slot: groups are [slot, firstVertex, vertexCount].
 */
export interface MeshData {
  vertexCount: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  groups: [number, number, number][];
}

/** Fields a change can carry; every one has a Blender writer in protocol.py. */
export type Field = "name" | "parent" | "transform" | "visible" | "materials";
export const BLENDER_WRITABLE: readonly Field[] = ["name", "parent", "transform", "visible", "materials"];
export const SCENE_FIELDS: readonly Field[] = ["name", "parent", "transform", "visible", "materials"];

export interface MaterialAssignment {
  name: string;
  props?: MaterialState;
}

export type Change =
  | { op: "create"; id: string; entity: EntityState; mesh?: MeshData; materials?: MaterialAssignment[] }
  | { op: "delete"; id: string }
  | { op: "update"; id: string; field: Field; value: unknown; previous: unknown }
  | { op: "geometry"; id: string; mesh: MeshData }
  /** A material's properties, by name. `previous` is the agreed value (toBlender only). */
  | { op: "material"; name: string; value: MaterialState; previous?: MaterialState };

/** toBlender: the scene's edits on their way out. toScene: Blender's results on their way in. */
export type Direction = "toBlender" | "toScene";

export type Side = "blender" | "scene";

/** What a conflict is about: an entity field, or (id = material name) a material's properties. */
export type ConflictSubject = Field | "material";

export interface Conflict {
  id: string;
  field: ConflictSubject;
  blender: unknown;
  scene: unknown;
  kept: Side;
}

/** What one Blender run reported, after decoding. */
export interface RunReport {
  snapshot: Snapshot;
  geometry: Record<string, MeshData>;
  conflicts: Conflict[];
  missing: string[];
  log: string[];
  output: string;
  /** The session .blend, when the run saved one (always for one-shot runs). */
  blend?: Uint8Array;
  /** Seconds since the request started, at the end of each phase (Blender's clock). */
  timings: Record<string, number>;
  files: Record<string, Uint8Array>;
}

/** The serialized job protocol.py reads from /job/project.json. */
export interface BlenderJob {
  commands: BlenderCommand[];
  script?: string;
  known: Record<string, string>;
  handlers: Record<string, string>;
  reportGeometry: boolean;
}

export type BlenderCommand = { op: string; [key: string]: unknown };

/**
 * Runs Blender once: `code` against an optional staged .blend, with `files`
 * staged into the module FS, returning everything written under /out.
 */
export interface BlenderRunner {
  run(job: {
    code: string;
    blendFile?: string;
    files: Record<string, Uint8Array>;
    onLine?: (line: string) => void;
  }): Promise<{ output: string; files: Record<string, Uint8Array> }>;
}

/**
 * A persistent Blender serving protocol.py requests (server mode): booted
 * once, it keeps the scene in memory, so a request costs only its own work.
 * `load` replaces the session first; `save` writes /out/session.blend.
 * Files come back keyed as a one-shot run writes them (/out/...).
 */
export interface BlenderSession {
  request(request: {
    job: BlenderJob;
    files: Record<string, Uint8Array>;
    load?: { kind: "factory" | "empty" } | { kind: "blend"; bytes: Uint8Array };
    save?: boolean;
    onLine?: (line: string) => void;
  }): Promise<{ output: string; files: Record<string, Uint8Array> }>;
}

/**
 * The other side of the project: an engine scene (Babylon, three.js, ...).
 * It reads its tracked entities into the shared description and applies
 * changes coming from Blender. Untracked content is its own business.
 */
export interface SceneSide {
  read(): Record<string, EntityState>;
  readMaterials(): Record<string, MaterialState>;
  /** Mesh data for an entity the scene created, for its first trip to Blender. */
  meshData(id: string): MeshData | null;
  materialsOf(id: string): MaterialAssignment[];
  apply(changes: Change[]): void;
}

export type Primitive = "box" | "sphere";

/**
 * What an engine adapter (`/babylon`, `/three`) offers on top of SceneSide:
 * the project's entities as engine nodes, and edits made from the engine
 * that the next sync carries to Blender. `N` is the engine's node type.
 */
export interface EngineSide<N> extends SceneSide {
  /** The node every project entity lives under. */
  readonly root: N;
  node(id: string): N | undefined;
  /** The entity id of a node that is one, else null. */
  idOf(node: N | null): string | null;
  /** The entity a picked node belongs to (through markers and sub-nodes), if any. */
  entityOf(node: N | null): N | null;
  ids(): string[];
  /** A new mesh entity; colour is linear RGBA (as glTF). */
  createPrimitive(kind: Primitive, options?: { name?: string; color?: Rgba }): N;
  /** Brings untracked engine content into the project, keeping its world placement. */
  adopt(nodes: N[]): string[];
  /** Removes an entity and every entity under it. */
  remove(id: string): void;
  assignMaterials(node: N, names: (string | null)[]): void;
  setMaterial(name: string, state: MaterialState): void;
  materialNames(): string[];
  materialState(name: string): MaterialState | undefined;
}
