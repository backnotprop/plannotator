import type { CodeAnnotation } from '@plannotator/ui/types';

export function selectAllAnnotations(state: { localAnnotations: CodeAnnotation[]; externalAnnotations: CodeAnnotation[] }): CodeAnnotation[] {
  const { localAnnotations, externalAnnotations } = state;
  if (externalAnnotations.length === 0) return localAnnotations;
  if (localAnnotations.length === 0) return externalAnnotations;

  const externalKeys = new Set(
    externalAnnotations.map((a) =>
      `${a.source}:${a.type}:${a.filePath}:${a.lineStart}:${a.lineEnd}:${a.side}`,
    ),
  );

  const deduped = localAnnotations.filter((a) => {
    if (!a.source) return true;
    const key = `${a.source}:${a.type}:${a.filePath}:${a.lineStart}:${a.lineEnd}:${a.side}`;
    return !externalKeys.has(key);
  });

  return [...deduped, ...externalAnnotations];
}
