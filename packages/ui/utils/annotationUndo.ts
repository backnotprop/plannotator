import { AnnotationType, type Annotation } from "../types";

function hasMeaningfulText(text?: string): boolean {
  return (text?.trim().length ?? 0) > 0;
}

export function isUndoRemovableAnnotation(annotation: Annotation): boolean {
  if (annotation.source) return false;
  if (annotation.type === AnnotationType.GLOBAL_COMMENT) return false;
  if (annotation.isQuickLabel) return false;
  if (hasMeaningfulText(annotation.text)) return false;
  if ((annotation.images?.length ?? 0) > 0) return false;
  return true;
}

export function findLastUndoRemovableAnnotation(
  annotations: Annotation[],
): Annotation | null {
  let latest: Annotation | null = null;

  for (const annotation of annotations) {
    if (!isUndoRemovableAnnotation(annotation)) continue;
    if (!latest || annotation.createdA >= latest.createdA) {
      latest = annotation;
    }
  }

  return latest;
}
