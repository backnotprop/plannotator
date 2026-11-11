import { AnnotationType, type Annotation } from "../../types";

/**
 * A page-anchored row the viewer can never post to the bridge: nothing to find it by (no quoted
 * text, no element anchor, no additional target anchor).
 */
export function isTextlessPageAnnotation(annotation: Annotation): boolean {
  if (annotation.type === AnnotationType.GLOBAL_COMMENT) return false;
  if (annotation.originalText) return false;
  if (annotation.htmlAnchor) return false;
  return !(annotation.htmlAdditionalTargets ?? []).some((target) => !!target.anchor);
}

/**
 * The host-facing unanchored set: the bridge's report (ids with no live representation on the
 * page) completed with what the bridge cannot see..
 */
export function mergeUnanchoredIds(input: {
  bridgeIds: readonly string[];
  annotations: readonly Annotation[];
  createdIds: ReadonlySet<string>;
}): string[] {
  const known = new Set<string>();
  for (const annotation of input.annotations) known.add(annotation.id);
  const out = new Set<string>();
  for (const id of input.bridgeIds) {
    if (input.createdIds.has(id) && !known.has(id)) continue;
    out.add(id);
  }
  for (const annotation of input.annotations) {
    if (isTextlessPageAnnotation(annotation)) out.add(annotation.id);
  }
  return [...out].sort();
}
