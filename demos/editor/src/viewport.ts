import type { EngineSide } from "@knervous/blender-wasm";

export type GizmoMode = "position" | "rotation" | "scale";

/**
 * What the editor needs from an engine: its project side (the package's
 * adapter), a camera and gizmos, picking, and content loaded outside the
 * project. `N` is the engine's node type.
 */
export interface Viewport<N> {
  readonly engine: string;
  readonly side: EngineSide<N>;
  /** Formats the engine opens by itself (outside the project). */
  readonly formats: string[];
  /** The download the engine makes of its own scene. */
  readonly nativeExport: { label: string; file: string };
  start(): void;
  /** A tap on the canvas: the project entity or untracked root under it, or null. */
  onPick(listener: (node: N | null) => void): void;
  /** A gizmo drag or camera move ended (time to refresh and maybe auto-sync). */
  onEditEnd(listener: () => void): void;
  attachGizmo(node: N | null): void;
  setGizmoMode(mode: GizmoMode): void;
  nameOf(node: N): string;
  /** Loads a file into the engine outside the project; returns a line for the log. */
  openUntracked(file: File): Promise<string>;
  untracked(): N[];
  adoptUntracked(): string[];
  /** Deletes an untracked node. */
  disposeUntracked(node: N): void;
  exportNative(): Promise<BlobPart>;
}

/* Linear (glTF, Principled BSDF) colour <-> the sRGB hex a colour picker shows. */
const toSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function linearToHex(rgb: readonly number[]): string {
  return "#" + rgb.slice(0, 3).map((c) => Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255).toString(16).padStart(2, "0")).join("");
}

export function hexToLinear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}
