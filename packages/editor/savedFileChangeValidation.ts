import type { SavedFileChangeDraftData } from './editableDocuments';
import type { SourceSaveProbeResult } from './sourceDocumentClient';

export interface SavedFileChangeValidationResult {
  valid: SavedFileChangeDraftData[];
  dropped: Array<{ change: SavedFileChangeDraftData; reason: 'changed' | 'missing' | 'noop' }>;
  unverified: SavedFileChangeDraftData[];
}

export async function validateSavedFileChanges(
  changes: SavedFileChangeDraftData[],
  resolveSourceSave: (change: SavedFileChangeDraftData) => Promise<SourceSaveProbeResult>,
): Promise<SavedFileChangeValidationResult> {
  const valid: SavedFileChangeDraftData[] = [];
  const dropped: SavedFileChangeValidationResult['dropped'] = [];
  const unverified: SavedFileChangeDraftData[] = [];

  for (const change of changes) {
    if (change.beforeText === change.afterText) {
      dropped.push({ change, reason: 'noop' });
      continue;
    }

    const expectedHash = change.afterHash ?? change.sourceSave.hash;
    const probe = await resolveSourceSave(change);
    if (probe.status === 'unavailable') {
      unverified.push(change);
      continue;
    }
    if (probe.status === 'missing') {
      dropped.push({ change, reason: 'missing' });
      continue;
    }
    if (probe.sourceSave.hash !== expectedHash) {
      dropped.push({ change, reason: 'changed' });
      continue;
    }

    valid.push({
      ...change,
      sourceSave: probe.sourceSave,
      afterHash: probe.sourceSave.hash,
    });
  }

  return { valid, dropped, unverified };
}
