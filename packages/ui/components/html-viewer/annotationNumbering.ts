import type { Annotation } from "../../types";
import { AnnotationType } from "../../types";

/** Mirror of the bridge's MAX_SYNC_ANNOTATIONS: the bridge truncates the
 * synced numbering list at this many ENTRIES, so the sender ships at most
 * this many (after globals are dropped) and both sides keep the same set.
 * Numbers themselves are array positions and may exceed this value; the
 * bridge's own number bound (100000) accepts them. */
export const MAX_SYNC_ANNOTATIONS = 512;

/**
 * Placed-marker numbers for the bridge sync, derived from the SAME effective
 * ordering `exportAnnotations` (packages/ui/utils/parser.ts) numbers the
 * submitted feedback with. exportAnnotations sorts by (block index, start
 * offset) and every raw-HTML annotation ties on both keys (blockId "",
 * startOffset 0) — including externally submitted ones, whose server-stamped
 * createdA can interleave arbitrarily with local timestamps — so its stable
 * sort numbers the list in ARRAY order. Numbering here is therefore by array
 * position of the input (the combined [...local, ...external] list the App
 * feeds both consumers), never by createdA: an on-page "Comment 3" must read
 * `## 3.` in the feedback the agent receives.
 *
 * Global comments occupy a number (they get their own `## N.` section in the
 * feedback) but ship no sync entry — they have no page location — so the
 * on-page numbers show gaps where globals sit. The entry cap applies AFTER
 * globals are dropped, so globals never waste sync capacity and a non-global
 * the export numbers past position 512 still syncs while slots remain.
 */
export function buildSyncNumbering(
  annotations: readonly Annotation[],
): Array<{ id: string; number: number }> {
  return annotations
    .map((ann, index) => ({ ann, number: index + 1 }))
    .filter(({ ann }) => ann.type !== AnnotationType.GLOBAL_COMMENT)
    .slice(0, MAX_SYNC_ANNOTATIONS)
    .map(({ ann, number }) => ({ id: ann.id, number }));
}
