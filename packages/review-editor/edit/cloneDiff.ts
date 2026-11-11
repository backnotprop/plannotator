import type { FileDiffMetadata } from '@pierre/diffs';

/**
 * Pierre's edit session mutates the metadata object in place (replaces `additionLines`,
 * `Object.assign`s recomputed `hunks`, stamps `editSessionDirty`).
 */
export function cloneFileDiff(diff: FileDiffMetadata): FileDiffMetadata {
  return structuredClone(diff);
}
