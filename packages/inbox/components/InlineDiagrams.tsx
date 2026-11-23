import { lazy, Suspense, useContext, useEffect, useState } from 'react';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { NativeDiagramEnabled } from '@plannotator/ui/components/diagram/nativeDiagramEnabled';
import type { NativeDiagramFileReference } from '@plannotator/ui/components/diagram/nativeDiagramDrawing';
import type { CommentAskAIHandler } from '@plannotator/ui/components/CommentPopover';
import type { Annotation } from '@plannotator/ui/types';
import { diagramDocumentBlocks } from '@plannotator/ui/utils/parser';
import { annotationOf, inboxViewKind, readableVersion } from '../attachments';
import { useInboxFileSource } from '../fileSource';
import type { AttachmentView } from '../api';
import { fileSideSource } from '../ask/sideSource';

const NativeDiagramBlock = lazy(async () => ({ default: (await import('@plannotator/ui/components/diagram/NativeDiagramBlock')).NativeDiagramBlock }));

interface InlineDiagramProps {
  records: readonly InboxAnnotationRecord[];
  onSaved: (record: InboxAnnotationRecord) => void;
  readOnly: boolean;
  onOpenFile?: (ref: NativeDiagramFileReference) => void;
  onSide?: (words: string, source?: string) => void;
}

export function InlineDiagrams({ files, ...props }: InlineDiagramProps & { files: readonly InboxAttachmentState[] }) {
  const enabled = useContext(NativeDiagramEnabled);
  if (!enabled) return null;
  return <>{files.filter((a) => inboxViewKind(a.kind, a.name) === 'plannotator-diagram').map((attachment) => (
    <InlineDiagram key={`${attachment.id}:${attachment.current?.sha256 ?? attachment.sent_sha256}:${readableVersion(attachment)}`} attachment={attachment} {...props} />
  ))}</>;
}

function InlineDiagram({ attachment, records, readOnly, onOpenFile, onSide, onSaved }: InlineDiagramProps & { attachment: InboxAttachmentState }) {
  const source = useInboxFileSource();
  const version = readableVersion(attachment);
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
  const ask: CommentAskAIHandler | undefined = onSide && ((question, context) =>
    onSide(question, [fileSideSource(attachment, version, { selected: context.text ?? '', blockId: blocks[0]?.id ?? '', blocks, annotations }), context.detail].filter(Boolean).join('\n')));
  return <div data-inline-diagram-attachment={attachment.id}>
    <Suspense fallback={null}>
      <NativeDiagramBlock block={blocks[0]!} annotations={annotations}
        onAddAnnotation={readOnly ? undefined : save}
        onEditAnnotation={readOnly ? undefined : (id, changes) => {
          const prior = annotations.find((a) => a.id === id);
          return prior ? save({ ...prior, ...changes }) : false;
        }}
        onOpenFile={onOpenFile} onAskAI={ask} sourcePath={attachment.path}
        embedded />
    </Suspense>
    {error && <p role="alert">{error}</p>}
  </div>;
}
