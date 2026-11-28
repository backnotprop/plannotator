/**
 * Whether a rendered diagram may load from another host (a label's picture, a
 * style's `url()`, a picture node).
 *
 * Default: true, for every host, as before. A host that must never let a
 * diagram call another host (a signed-in hosted app) passes
 * `configurePlannotatorUI({ diagramRemoteLoads: false })`. Read at each
 * render (`utils/diagram-render`, `utils/mermaidTheme`), so a call made after
 * the first diagram applies to every later render. See HANDOFF.md
 * "Diagrams that load nothing from another host".
 */
let diagramRemoteLoads = true;

export function setDiagramRemoteLoads(on: boolean): void {
  diagramRemoteLoads = on;
}

export function resetDiagramRemoteLoads(): void {
  diagramRemoteLoads = true;
}

export function getDiagramRemoteLoads(): boolean {
  return diagramRemoteLoads;
}
