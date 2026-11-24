import { lazy, Suspense, useContext, useEffect, useState } from 'react';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { NativeDiagramEnabled } from '@plannotator/ui/components/diagram/nativeDiagramEnabled';
import type { NativeDiagramFileReference } from '@plannotator/ui/components/diagram/nativeDiagramDrawing';
import type { Annotation } from '@plannotator/ui/types';
import { diagramDocumentBlocks } from '@plannotator/ui/utils/parser';
import { annotationOf, inboxViewKind } from '../attachments';
import { latestDiagramFor, type Artifact } from '../artifacts';
import { useInboxFileSource } from '../fileSource';
import type { AttachmentView } from '../api';
import { useDiagramQuestionRoutes } from '../ask/DiagramThreadScope';
import { diagramFileAsk } from '../ask/sideSource';

const NativeDiagramBlock = lazy(async () => ({ default: (await import('@plannotator/ui/components/diagram/NativeDiagramBlock')).NativeDiagramBlock }));

interface InlineDiagramProps {
  records: readonly InboxAnnotationRecord[];
  onSaved: (record: InboxAnnotationRecord) => void;
  readOnly: boolean;
  onOpenFile?: (ref: NativeDiagramFileReference) => void;
  onSide?: (words: string, source?: string) => void;
}

export function InlineDiagrams({ files, artifacts = [], onOpenLatest, ...props }: InlineDiagramProps & {
  files: readonly InboxAttachmentState[];
  artifacts?: readonly Artifact[];
  onOpenLatest?: (attachment: InboxAttachmentState) => void;
}) {
  const enabled = useContext(NativeDiagramEnabled);
  if (!enabled) return null;
  return <>{files.filter((a) => inboxViewKind(a.kind, a.name) === 'plannotator-diagram').map((attachment) => {
    const latest = latestDiagramFor(artifacts, attachment);
    return <InlineDiagram key={`${attachment.id}:${attachment.sent_sha256}`} attachment={attachment}
      openLatest={latest && onOpenLatest ? () => onOpenLatest(latest) : undefined} {...props} />;
  })}</>;
}

function InlineDiagram({ attachment, records, readOnly, onOpenFile, onSide, onSaved, openLatest }: InlineDiagramProps & { attachment: InboxAttachmentState; openLatest?: () => void }) {
  const source = useInboxFileSource();
  const { reply } = useDiagramQuestionRoutes(attachment.message_id);
  const version = 'sent';
  const [view, setView] = useState<AttachmentView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    source.view(attachment, version).then((result) => { if (live) setView(result); }, () => { if (live) setError('Could not load the diagram preview.'); });
    return () => { live = false; };
  }, [source, attachment.id, version]);
  if (!view) return error ? <p role="status">{error}</p> : null;
  const annotations = records.filter((r) => r.path === attachment.path && r.version === view.version).map(annotationOf);
  const blocks = diagramDocumentBlocks(view.text, 'plannotator-diagram');
  const save = async (annotation: Annotation) => {
    try {
      const record = await source.saveAnnotation(attachment, view.version, annotation);
      onSaved(record);
      setError('');
      return true;
    } catch {
      setError('The diagram comment could not be saved.');
      return false;
    }
  };
  return <div data-inline-diagram-attachment={attachment.id}>
    <Suspense fallback={null}>
      <NativeDiagramBlock block={blocks[0]!} annotations={annotations}
        onAddAnnotation={readOnly ? undefined : save}
        onEditAnnotation={readOnly ? undefined : (id, changes) => {
          const prior = annotations.find((a) => a.id === id);
          return prior ? save({ ...prior, ...changes }) : false;
        }}
        onOpenLatest={openLatest} onOpenFile={onOpenFile} onAskAI={diagramFileAsk(view, onSide, reply)} sourcePath={attachment.path}
        embedded />
    </Suspense>
    {error && <p role="alert">{error}</p>}
  </div>;
}
