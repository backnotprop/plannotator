import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import { Suspense, useContext, useEffect, useState } from 'react';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { NativeDiagramBlockContext, type NativeDiagramRenderer } from '@plannotator/ui/components/diagram/nativeDiagramEnabled';
import type { NativeDiagramFileReference } from '@plannotator/ui/components/diagram/nativeDiagramDrawing';
import type { Annotation } from '@plannotator/ui/types';
import { diagramDocumentBlocks } from '@plannotator/ui/utils/parser';
import { annotationOf, inboxViewKind } from '../attachments';
import { latestDiagramFor, type Artifact } from '../artifacts';
import { diagramFileReader } from './DiagramFileReader';
import { useInboxFileSource } from '../fileSource';
import type { AttachmentView } from '../api';
import { useDiagramQuestionRoutes } from '../ask/DiagramThreadScope';
import { diagramFileAsk } from '../ask/sideSource';

interface InlineDiagramProps {
  records: readonly InboxAnnotationRecord[];
  onSaved: (record: InboxAnnotationRecord) => void;
  readOnly: boolean;
  onRemoved?: (id: string) => void;
  onOpenFile?: (ref: NativeDiagramFileReference) => void;
  onSide?: (words: string, source?: string) => void;
}

export function InlineDiagrams({ files, artifacts = [], onOpenLatest, ...props }: InlineDiagramProps & {
  files: readonly InboxAttachmentState[];
  artifacts?: readonly Artifact[];
  onOpenLatest?: (attachment: InboxAttachmentState) => void;
}) {
  const NativeDiagramBlock = useContext(NativeDiagramBlockContext);
  if (!NativeDiagramBlock) return null;
  return <>{files.filter((a) => inboxViewKind(a.kind, a.name) === 'plannotator-diagram').map((attachment) => {
    const latest = latestDiagramFor(artifacts, attachment);
    return <InlineDiagram key={`${attachment.id}:${attachment.sent_sha256}`} attachment={attachment} renderBlock={NativeDiagramBlock}
      latest={latest} openLatest={latest && onOpenLatest ? () => onOpenLatest(latest) : undefined} {...props} />;
  })}</>;
}

export function ExpandedDiagramEdition({ attachment, ...props }: InlineDiagramProps & { attachment: InboxAttachmentState }) {
  const Block = useContext(NativeDiagramBlockContext);
  return Block && <InlineDiagram renderBlock={Block} attachment={attachment} {...props} expandedOnly />;
}

function InlineDiagram({ renderBlock: NativeDiagramBlock, attachment, records, readOnly, onOpenFile, onSide, onSaved, onRemoved, latest, openLatest, expandedOnly }: InlineDiagramProps & { renderBlock: NativeDiagramRenderer; attachment: InboxAttachmentState; latest?: InboxAttachmentState | null; openLatest?: () => void; expandedOnly?: boolean }) {
  const source = useInboxFileSource();
  const { reply, threadId } = useDiagramQuestionRoutes(attachment.message_id);
  const version = 'sent';
  const [view, setView] = useState<AttachmentView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    source.view(attachment, version).then((result) => { if (live) setView(result); }, () => { if (live) setError('Could not load the diagram preview.'); });
    return () => { live = false; };
  }, [source, attachment.id, version]);
  if (!view) return error || expandedOnly ? <p role="status">{error || 'Loading diagram…'}</p> : null;
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
  return <div data-inline-diagram-attachment={attachment.id} className={expandedOnly ? "flex flex-col flex-1 min-h-0" : undefined}>
    <LazyBlockBoundary fallback={notice => <>{notice}<pre className="max-h-64 overflow-auto">{view.text}</pre></>}>
      <Suspense fallback={null}>
        <NativeDiagramBlock block={blocks[0]!} annotations={annotations}
          onAddAnnotation={readOnly ? undefined : save}
          onDeleteAnnotation={!readOnly && onRemoved ? async id => { await source.removeAnnotation(id); onRemoved(id); } : undefined}
          onEditAnnotation={readOnly ? undefined : (id, changes) => {
            const prior = annotations.find((a) => a.id === id);
            return prior ? save({ ...prior, ...changes }) : false;
          }}
          expandedOnly={expandedOnly} renderExpandedFile={diagramFileReader(threadId, attachment.message_id)}
          latestEdition={latest && openLatest ? <ExpandedDiagramEdition key={latest.id} attachment={latest}
            records={records} readOnly={readOnly} onSaved={onSaved} onRemoved={onRemoved} onOpenFile={onOpenFile} onSide={onSide} /> : undefined}
          onOpenLatest={openLatest} onOpenFile={onOpenFile} onAskAI={diagramFileAsk(view, onSide, reply)} sourcePath={attachment.path}
          embedded />
      </Suspense>
    </LazyBlockBoundary>
    {error && <p role="alert">{error}</p>}
  </div>;
}
