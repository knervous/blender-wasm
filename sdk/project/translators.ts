import type { Field, Transform } from "./types.ts";

/**
 * How one field crosses between the sides. Values are already in the shared
 * description; a translator decides when two values are the same change and
 * may reshape a value on its way to either side. Plugins replace them per
 * field (`ProjectPlugin.translators`).
 */
export interface FieldTranslator<V = unknown> {
  field: Field;
  equal(a: V, b: V): boolean;
  /** Shape the value Blender's writer receives (default: unchanged). */
  toBlender?(value: V): unknown;
  /** Shape the value the scene's writer receives (default: unchanged). */
  toScene?(value: V): V;
}

const EPSILON = 1e-5;

export const nearlyEqual = (a: number, b: number): boolean => Math.abs(a - b) < EPSILON;

const vectorsEqual = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((value, i) => nearlyEqual(value, b[i]));

/** q and -q are the same rotation. */
const rotationsEqual = (a: readonly number[], b: readonly number[]): boolean =>
  vectorsEqual(a, b) || vectorsEqual(a, b.map((v) => -v));

export const transformTranslator: FieldTranslator<Transform> = {
  field: "transform",
  equal: (a, b) => vectorsEqual(a.t, b.t) && rotationsEqual(a.r, b.r) && vectorsEqual(a.s, b.s),
};

const strictTranslator = <V>(field: Field): FieldTranslator<V> => ({ field, equal: (a, b) => a === b });

export const materialsTranslator: FieldTranslator<(string | null)[]> = {
  field: "materials",
  equal: (a, b) => a.length === b.length && a.every((name, i) => name === b[i]),
};

export function defaultTranslators(): Record<Field, FieldTranslator> {
  return {
    name: strictTranslator<string>("name"),
    parent: strictTranslator<string | null>("parent"),
    visible: strictTranslator<boolean>("visible"),
    transform: transformTranslator,
    materials: materialsTranslator,
  };
}
