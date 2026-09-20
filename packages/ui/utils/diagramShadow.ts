/**
 * The user-facing scale for the Mermaid node drop shadow: whole percent, 0..100,
 * where 100 is Mermaid 12's own default shadow and 0 is none.
 *
 * Deliberately free of imports so the settings registry can read it on every
 * surface (the guides.show viewer included) without pulling the diagram theme
 * mapping — and the runtime into which it feeds — into that module graph.
 * `mermaidTheme.DEFAULT_MERMAID_SHADOW_AMOUNT` is the same value in the 0..1
 * unit the mapping takes; `mermaidTheme.test.ts` pins the two together.
 */

/** The steps Settings offers. A slider would imply a precision nobody can see. */
export const DIAGRAM_SHADOW_OPTIONS = [0, 40, 70, 100] as const;

/** Shipped default: the neo look with its grey halo toned down. */
export const DEFAULT_DIAGRAM_SHADOW = 70;

/** Any whole percent in range is valid, not only the offered steps. */
export function isDiagramShadow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

/** The 0..1 amount `buildMermaidThemeVariables` takes. */
export function diagramShadowAmount(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_DIAGRAM_SHADOW / 100;
  return Math.min(100, Math.max(0, percent)) / 100;
}
