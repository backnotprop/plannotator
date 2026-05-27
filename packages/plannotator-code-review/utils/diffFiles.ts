import type { DiffFile } from '../types';

/**
 * Keep files marked "viewed" only if their patch is identical in the new diff.
 * Files that changed or were added get removed from the set so they reappear.
 */
export function retainUnchangedViewedFiles(
  oldFiles: DiffFile[],
  newFiles: DiffFile[],
  viewedFiles: Set<string>,
): Set<string> {
  if (viewedFiles.size === 0) return viewedFiles;
  const oldPatches = new Map(oldFiles.map(f => [f.path, f.patch]));
  const retained = new Set<string>();
  for (const file of newFiles) {
    if (viewedFiles.has(file.path) && oldPatches.get(file.path) === file.patch) {
      retained.add(file.path);
    }
  }
  return retained;
}
