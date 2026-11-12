import type { Annotation } from "../../types";
import { AnnotationType } from "../../types";

export const MAX_SYNC_ANNOTATIONS = 512;

export function buildSyncNumbering(
  annotations: readonly Annotation[],
): Array<{ id: string; number: number }> {
  return annotations
    .map((ann, index) => ({ ann, number: index + 1 }))
    .filter(({ ann }) => ann.type !== AnnotationType.GLOBAL_COMMENT)
    .slice(0, MAX_SYNC_ANNOTATIONS)
    .map(({ ann, number }) => ({ id: ann.id, number }));
}
