import type { DraftEditedDocument } from '@plannotator/ui/hooks/useAnnotationDraft';

export function pickRestoredSingleFileDraftToDisplay(
  documents: DraftEditedDocument[],
  restoredKeys: string[],
  activeKey: string | null,
): DraftEditedDocument | undefined {
  const restored = documents.filter((doc) =>
    doc.sourceSave.scope === 'single-file' && restoredKeys.includes(doc.key)
  );
  if (activeKey) return restored.find((doc) => doc.key === activeKey);
  return restored.length === 1 ? restored[0] : undefined;
}
