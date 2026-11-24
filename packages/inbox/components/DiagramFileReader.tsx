import { useState } from 'react';
import type { NativeDiagramFileReference } from '@plannotator/ui/components/diagram/nativeDiagramDrawing';
import { ReferencedFilePane, type OpenFileRef } from './ReferencedFilePane';

/** Reuse the Inbox file viewer in the expanded drawing, scoped to the message that supplied this edition. */
export function diagramFileReader(threadId: string | undefined, messageId: string) {
  if (!threadId) return undefined;
  return (ref: NativeDiagramFileReference, close: () => void) => <DiagramFileReader key={ref.path}
    threadId={threadId} initial={{ messageId, from: 'root', path: ref.path, line: ref.start, lineEnd: ref.end }} close={close} />;
}

function DiagramFileReader({ threadId, initial, close }: { threadId: string; initial: OpenFileRef; close: () => void }) {
  const [file, setFile] = useState(initial);
  return <ReferencedFilePane fileRef={file} threadId={threadId} phone={false} full={false} inspect
    onClose={close} onOpen={setFile} onAttached={() => {}} />;
}
