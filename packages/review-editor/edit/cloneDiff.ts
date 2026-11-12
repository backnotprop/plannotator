import type { FileDiffMetadata } from '@pierre/diffs';

export function cloneFileDiff(diff: FileDiffMetadata): FileDiffMetadata {
  return structuredClone(diff);
}
