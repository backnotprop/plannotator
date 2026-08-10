import type { Annotation } from "../../types";
import { AnnotationType } from "../../types";

/** Mirror of the bridge's MAX_SYNC_ANNOTATIONS: the bridge truncates the
 * synced numbering list at this bound, so the sender truncates AFTER the
 * stable sort too — the first 512 numbers then agree on both sides instead
 * of the bridge silently dropping an arbitrary tail. */
export const MAX_SYNC_ANNOTATIONS = 512;

/**
 * Placed-marker numbers for the bridge sync, derived from the SAME ordering
 * `exportAnnotations` (packages/ui/utils/parser.ts) numbers the submitted
 * feedback with: the FULL createdA-sorted list INCLUDING global comments.
 * Global comments occupy a number (they get their own `## N.` section in the
 * feedback) but ship no sync entry — they have no page location — so the
 * on-page numbers show gaps where globals sit. That is correct: an on-page
 * "Comment 3" must read `## 3.` in the feedback the agent receives, never
 * shift down because a global comment sat between them.
 */
export function buildSyncNumbering(
  annotations: readonly Annotation[],
): Array<{ id: string; number: number }> {
  return [...annotations]
    .sort((a, b) => a.createdA - b.createdA)
    .slice(0, MAX_SYNC_ANNOTATIONS)
    .map((ann, index) => ({ ann, number: index + 1 }))
    .filter(({ ann }) => ann.type !== AnnotationType.GLOBAL_COMMENT)
    .map(({ ann, number }) => ({ id: ann.id, number }));
}
