import type { FieldTranslator } from "./translators.ts";
import type { Change, EntityState, Field, MaterialState, MeshData } from "./types.ts";
import { BLENDER_WRITABLE, SCENE_FIELDS } from "./types.ts";

type Translators = Record<Field, FieldTranslator>;

/**
 * The scene's edits since the last agreed state: what is new, gone, or has a
 * Blender-writable field that differs. `previous` is the agreed value, which
 * Blender checks before writing (conflict detection).
 */
export function diffToBlender(
  agreed: Record<string, EntityState>,
  scene: Record<string, EntityState>,
  translators: Translators,
): Change[] {
  const changes: Change[] = [];
  for (const [id, entity] of Object.entries(scene)) {
    const before = agreed[id];
    if (!before) {
      changes.push({ op: "create", id, entity });
      continue;
    }
    for (const field of BLENDER_WRITABLE) {
      if (!translators[field].equal(before[field], entity[field])) {
        changes.push({ op: "update", id, field, value: entity[field], previous: before[field] });
      }
    }
  }
  for (const id of Object.keys(agreed)) {
    if (!scene[id]) changes.push({ op: "delete", id });
  }
  return changes;
}

/**
 * What the scene must do to match Blender's report: compared against what the
 * scene holds now, so the scene's own edits that Blender accepted produce no
 * change, and only Blender's work (scripts, UI edits, normalisation such as a
 * renamed duplicate, conflicts it won) comes back.
 */
export function diffToScene(
  scene: Record<string, EntityState>,
  sceneMaterials: Record<string, MaterialState>,
  report: { entities: Record<string, EntityState>; materials: Record<string, MaterialState> },
  geometry: Record<string, MeshData>,
  translators: Translators,
): Change[] {
  const changes: Change[] = [];
  for (const [name, value] of Object.entries(report.materials)) {
    const before = sceneMaterials[name];
    if (!before || !sameMaterial(before, value)) changes.push({ op: "material", name, value });
  }
  for (const [id, entity] of Object.entries(report.entities)) {
    const before = scene[id];
    if (!before) {
      changes.push({ op: "create", id, entity, mesh: geometry[id] });
      continue;
    }
    for (const field of SCENE_FIELDS) {
      if (!translators[field].equal(before[field], entity[field])) {
        changes.push({ op: "update", id, field, value: entity[field], previous: before[field] });
      }
    }
    if (geometry[id]) changes.push({ op: "geometry", id, mesh: geometry[id] });
  }
  for (const id of Object.keys(scene)) {
    if (!report.entities[id]) changes.push({ op: "delete", id });
  }
  return changes;
}

const sameMaterial = (a: MaterialState, b: MaterialState): boolean =>
  a.color.every((c, i) => Math.abs(c - b.color[i]) < 1e-5)
  && Math.abs(a.metallic - b.metallic) < 1e-5
  && Math.abs(a.roughness - b.roughness) < 1e-5;
