import type { FileDiffMetadata } from '@pierre/diffs';

/**
 * Deep-clone a FileDiffMetadata BEFORE handing it to Pierre's editor.
 *
 * Pierre's edit session mutates the metadata object in place (replaces
 * `additionLines`, `Object.assign`s recomputed `hunks`, stamps
 * `editSessionDirty`). The pristine clone is what gets republished onto the
 * CodeView item when the session ends (complete OR cancel), so the diff view
 * always returns to exactly what the reviewer saw before editing.
 *
 * FileDiffMetadata is plain structured data (strings/numbers/arrays/objects),
 * so structuredClone covers it; if upstream ever adds an uncloneable field,
 * this throws loudly at session start instead of silently sharing state.
 */
export function cloneFileDiff(diff: FileDiffMetadata): FileDiffMetadata {
  return structuredClone(diff);
}
