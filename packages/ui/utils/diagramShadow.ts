export const DIAGRAM_SHADOW_OPTIONS = [0, 40, 70, 100] as const;

export const DEFAULT_DIAGRAM_SHADOW = 70;

export function isDiagramShadow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

export function diagramShadowAmount(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_DIAGRAM_SHADOW / 100;
  return Math.min(100, Math.max(0, percent)) / 100;
}
