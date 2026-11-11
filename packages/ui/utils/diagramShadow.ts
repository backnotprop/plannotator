/**
 * Deliberately free of imports so the settings registry can read it on every surface (the
 * guides.show viewer included) without pulling the diagram theme mapping — and the runtime into
 * which it feeds — into that module graph.
 */

export const DIAGRAM_SHADOW_OPTIONS = [0, 40, 70, 100] as const;

/** Shipped default: the neo look with its grey halo toned down. */
export const DEFAULT_DIAGRAM_SHADOW = 70;

/** Any whole percent in range is valid, not only the offered steps. */
export function isDiagramShadow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

export function diagramShadowAmount(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_DIAGRAM_SHADOW / 100;
  return Math.min(100, Math.max(0, percent)) / 100;
}
