import { pathIsInsideDir } from '@plannotator/shared/browser-paths';
import {
  canApplyEditableDocumentDiskSnapshot,
  getEditableDocumentKnownDiskHash,
  type DiskSnapshotReconcileResult,
  type EditableDocumentRecord,
  type EnabledSourceSaveCapability,
} from './editableDocuments';
import type { SourceDocumentSnapshotResult } from './sourceDocumentClient';

export type OpenSourceDocumentRecord = EditableDocumentRecord & { sourceSave: EnabledSourceSaveCapability };

export type SourceDocumentReconcileEvent =
  | {
      type: 'file-missing';
      result: { record: EditableDocumentRecord; clearedSavedChange: boolean; alreadyMissing: boolean };
    }
  | { type: 'clean-updated'; result: Extract<DiskSnapshotReconcileResult, { type: 'clean-updated' }> }
  | { type: 'status-updated'; result: Extract<DiskSnapshotReconcileResult, { type: 'status-updated' }> }
  | { type: 'conflict'; result: Extract<DiskSnapshotReconcileResult, { type: 'conflict' }> };

interface ReconcileSourceDocumentsOptions {
  changedDir?: string;
  documents: OpenSourceDocumentRecord[];
  sequenceByKey: Map<string, number>;
  getDocument: (key: string) => EditableDocumentRecord | null;
  fetchSnapshot: (path: string) => Promise<SourceDocumentSnapshotResult>;
  markFileMissing: (key: string) => { record: EditableDocumentRecord; clearedSavedChange: boolean; alreadyMissing: boolean } | null;
  reconcileDiskSnapshot: (input: {
    key: string;
    text: string;
    sourceSave: EnabledSourceSaveCapability;
  }) => DiskSnapshotReconcileResult;
  onEvent: (event: SourceDocumentReconcileEvent) => void;
}

export async function reconcileSourceDocuments({
  changedDir,
  documents,
  sequenceByKey,
  getDocument,
  fetchSnapshot,
  markFileMissing,
  reconcileDiskSnapshot,
  onEvent,
}: ReconcileSourceDocumentsOptions): Promise<boolean> {
  const docs = documents.filter((doc) => !changedDir || pathIsInsideDir(doc.sourceSave.path, changedDir));
  let changed = false;

  for (const doc of docs) {
    const startRecord = getDocument(doc.key);
    if (startRecord?.saveStatus === 'saving') continue;
    const expectedDiskHash = getEditableDocumentKnownDiskHash(startRecord);
    const seq = (sequenceByKey.get(doc.key) ?? 0) + 1;
    sequenceByKey.set(doc.key, seq);
    const snapshotResult = await fetchSnapshot(doc.sourceSave.path);
    if (sequenceByKey.get(doc.key) !== seq) continue;
    const currentRecord = getDocument(doc.key);
    if (!canApplyEditableDocumentDiskSnapshot(currentRecord, expectedDiskHash)) continue;

    if (snapshotResult.status === 'missing') {
      const result = markFileMissing(doc.key);
      if (!result) continue;
      if (!result.alreadyMissing || result.clearedSavedChange) changed = true;
      onEvent({ type: 'file-missing', result });
      continue;
    }

    if (snapshotResult.status === 'unavailable') continue;

    const { snapshot } = snapshotResult;
    const result = reconcileDiskSnapshot({
      key: doc.key,
      text: snapshot.markdown,
      sourceSave: snapshot.sourceSave,
    });

    if (result.type === 'clean-updated') {
      changed = true;
      onEvent({ type: 'clean-updated', result });
    } else if (result.type === 'status-updated') {
      changed = true;
      onEvent({ type: 'status-updated', result });
    } else if (result.type === 'conflict') {
      changed = true;
      onEvent({ type: 'conflict', result });
    }
  }

  return changed;
}
