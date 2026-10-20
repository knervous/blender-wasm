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

/** Fields a change can carry. Only the first four have Blender writers built in. */
export type Field = "name" | "parent" | "transform" | "visible" | "materials";
export const BLENDER_WRITABLE: readonly Field[] = ["name", "parent", "transform", "visible"];
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
  | { op: "material"; name: string; value: MaterialState };

/** toBlender: the scene's edits on their way out. toScene: Blender's results on their way in. */
export type Direction = "toBlender" | "toScene";

export type Side = "blender" | "scene";

export interface Conflict {
  id: string;
  field: Field;
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
  blend: Uint8Array;
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
