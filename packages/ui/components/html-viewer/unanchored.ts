import { AnnotationType, type Annotation } from "../../types";

/**
 * A page-anchored row the viewer can never post to the bridge: nothing to
 * find it by (no quoted text, no element anchor, no additional target
 * anchor). Document-level comments are excluded on purpose: a
 * GLOBAL_COMMENT has no page location by design and is not "unanchored".
 */
export function isTextlessPageAnnotation(annotation: Annotation): boolean {
  if (annotation.type === AnnotationType.GLOBAL_COMMENT) return false;
  if (annotation.originalText) return false;
  if (annotation.htmlAnchor) return false;
  return !(annotation.htmlAdditionalTargets ?? []).some((target) => !!target.anchor);
}

/**
 * The host-facing unanchored set: the bridge's report (ids with no live
 * representation on the page) completed with what the bridge cannot see.
 *
 * - Textless page rows are added: they were never posted, so the bridge
 *   cannot report them, yet they have no marker and no highlight.
 * - An id this viewer minted for a locally created comment (`create-mark`)
 *   that the host never carried in `annotations`, or has since swapped out
 *   for its own id, is dropped: the host holds no card for it, so naming it
 *   would be noise. Every other bridge id passes through untouched, so a
 *   host that paints through the imperative handle keeps today's delivery.
 *
 * Sorted and deduplicated like the bridge's own emission. With no textless
 * rows and no swapped-out minted ids the result is exactly the bridge list.
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
