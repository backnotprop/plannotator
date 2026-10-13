/**
 * One attachment in the surface (3.6, 4.1 to 4.4): markdown and text through
 * `Viewer` with the annotation toolstrip, HTML through `HtmlViewer` with pins,
 * diagrams through `DiagramViewer`. Each hands its draft to the shell
 * (`onHostDraft`); the shell's sheet writes the comment, the door saves it,
 * and `commit` draws it as saved.
 */

import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { diagramTargetName, diagramTargetText, type DiagramAnchor } from '@plannotator/core/diagram-anchor';
import { sliceText } from '@plannotator/core/inbox-questions';
import { inboxAttachmentKindLabel, isInboxTextKind, readInboxAttachmentKind, type InboxAnnotationRecord, type SurfaceOpenAttachment } from '@plannotator/core/inbox-types';
import { AnnotationToolstrip } from '@plannotator/ui/components/AnnotationToolstrip';
import { HtmlViewer } from '@plannotator/ui/components/html-viewer';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { AnnotationType, type Annotation, type EditorMode, type HostDraft, type InputMethod } from '@plannotator/ui/types';
import { annotationOwnsHighlight } from '@plannotator/ui/utils/annotationOwnsHighlight';
import { getIdentity } from '@plannotator/ui/utils/identity';
import { annotationOf, attachmentBlocks, codeRangeOf } from '../attachments';
import { postToShell } from './bridge';
import type { DiagramHostDraft } from '@plannotator/ui/components/diagram/DiagramViewer';

// The diagram engine and its runtimes load on the first diagram, as in Plannotator's own viewers.
const SurfaceDiagram = lazy(() => import('./SurfaceDiagram'));

export interface SurfaceDocumentHandle {
  stepPin: (direction: 'parent' | 'child') => void;
  /** Comment in the shell's edit menu: the selection becomes a draft; false when there is none. */
  takeSelection: () => boolean;
  commit: (record: InboxAnnotationRecord) => void;
  remove: (id: string) => void;
}

interface Props {
  open: SurfaceOpenAttachment;
  records: readonly InboxAnnotationRecord[];
  interact: boolean;
}

/** A fresh annotation id; `randomUUID` needs a secure context, which an app scheme may not be. */
function newId(): string {
  return typeof crypto.randomUUID === 'function' && window.isSecureContext
    ? crypto.randomUUID()
    : `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A quote as a sheet's title names it: one line, cut at a word. */
function shortLabel(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.lastIndexOf(' ') > 30 ? cut.slice(0, cut.lastIndexOf(' ')) : sliceText(line, 60)}…`;
}

export const SurfaceDocument = forwardRef<SurfaceDocumentHandle, Props>(function SurfaceDocument({ open, records, interact }, ref) {
  const { attachment, version } = open;
  const viewerRef = useRef<ViewerHandle>(null);
  const [inputMethod, setInputMethod] = useState<InputMethod>('drag');
  const [mode, setMode] = useState<EditorMode>('selection');
  const [selectedId, setSelectedId] = useState<string | null>(open.focus);
  // The draft the shell holds, so a commit or a cancel drops it.
  const draft = useRef<{ id: string; intent: HostDraft['intent'] | 'diagram'; cancel: () => void } | null>(null);

  const kind = readInboxAttachmentKind(attachment.kind);
  const isHtml = kind === 'html';
  const isDiagram = kind === 'mermaid' || kind === 'graphviz';
  // An image, a PDF, any other file and a kind this surface does not know are
  // the shell's to show natively (its image viewer, PDFKit, Quick Look); the
  // surface draws a plain card for them and never reads their bytes as text.
  const isText = isInboxTextKind(kind) && !isHtml && !isDiagram;
  // Code is shown read-only here (one code block); its line comments are made in the window.
  const isCode = kind === 'code';
  const fileRecords = useMemo(
    () => records.filter((r) => r.attachment_id === attachment.id && r.version === version),
    [records, attachment.id, version],
  );
  const annotations = useMemo(() => fileRecords.map(annotationOf), [fileRecords]);
  const blocks = useMemo(() => attachmentBlocks(attachment.kind, open.text, attachment.name), [attachment.kind, attachment.name, open.text]);

  // Paint the stored highlights once the document is drawn; later ones arrive through commit.
  // The shell's "3 annotations" sheet opens a file at one mark (`focus`):
  // once the marks are painted, that one is brought to the middle of the screen.
  const painted = useRef(false);
  useEffect(() => {
    if (!isText || painted.current) return;
    const id = requestAnimationFrame(() => {
      painted.current = true;
      viewerRef.current?.applySharedAnnotations(annotations.filter((a) => annotationOwnsHighlight(a) && codeRangeOf(a) === null));
      if (open.focus) {
        const mark = document.querySelector(`[data-highlight-id="${CSS.escape(open.focus)}"], [data-bind-id="${CSS.escape(open.focus)}"]`);
        mark?.scrollIntoView({ block: 'center' });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [isText, annotations, open.focus]);

  const dropDraft = () => {
    draft.current?.cancel();
    draft.current = null;
  };

  useImperativeHandle(ref, () => ({
    stepPin: (direction) => viewerRef.current?.stepPin?.(direction),
    takeSelection: () => (isText ? (viewerRef.current?.takeSelection?.() ?? false) : false),
    commit: (record) => {
      if (record.attachment_id !== attachment.id || record.version !== version) return;
      dropDraft();
      // A diagram draws its comments from `records`; text and HTML paint the saved mark.
      if (!isDiagram) viewerRef.current?.applySharedAnnotations([annotationOf(record)]);
    },
    remove: (id) => {
      if (draft.current?.id === id) {
        dropDraft();
        return;
      }
      if (!isDiagram) viewerRef.current?.removeHighlight(id);
    },
  }));

  const onHostDraft = useCallback((next: HostDraft | null) => {
    if (next === null) {
      if (draft.current?.intent === 'selection') postToShell({ type: 'selection', quote: null, draft: null });
      draft.current = null;
      return;
    }
    const { annotation } = next;
    draft.current = { id: annotation.id, intent: next.intent, cancel: next.cancel };
    const wire = annotation as unknown as Record<string, unknown>;
    if (next.intent === 'selection') {
      postToShell({ type: 'selection', quote: annotation.originalText, draft: wire });
    } else if (annotation.htmlAnchor) {
      // Parent or Child may have moved it out of sight.
      requestAnimationFrame(() => viewerRef.current?.revealPin?.());
      postToShell({
        type: 'pin',
        target: { label: next.label ?? annotation.htmlAnchor.tagName.toLowerCase(), selector: annotation.htmlAnchor.selector },
        draft: wire,
      });
    } else {
      postToShell({ type: 'draft', target: { kind: 'block', label: next.label ?? shortLabel(annotation.originalText) }, draft: wire });
    }
  }, []);

  const onDiagramDraft = useCallback(
    (next: DiagramHostDraft | null) => {
      if (next === null) {
        draft.current = null;
        return;
      }
      const anchor: DiagramAnchor = next.anchor;
      const annotation: Annotation = {
        id: newId(),
        blockId: blocks[0]?.id ?? '',
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.COMMENT,
        text: '',
        originalText: diagramTargetText(anchor),
        createdA: Date.now(),
        author: getIdentity(),
        diagramAnchor: anchor,
      };
      draft.current = { id: annotation.id, intent: 'diagram', cancel: next.cancel };
      const kind = anchor.kind === 'edge' ? 'edge' : anchor.kind === 'diagram' ? 'block' : 'node';
      const name = diagramTargetName(anchor);
      const text = diagramTargetText(anchor);
      postToShell({
        type: 'draft',
        target: { kind, label: text && kind !== 'block' ? `${text} (${name})` : name },
        draft: annotation as unknown as Record<string, unknown>,
      });
    },
    [blocks],
  );

  // The shell's panel covers the page's lower part and shrinks the web view:
  // the pin being written about stays in sight.
  useEffect(() => {
    if (!isHtml) return;
    const onResize = () => {
      if (draft.current?.intent === 'compose') viewerRef.current?.revealPin?.();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isHtml]);

  // A press anywhere in the document puts down a settled selection (the shell
  // closes its edit menu); a new selection then starts fresh. Pins and
  // composer drafts stay until the shell answers.
  useEffect(() => {
    if (!isText) return;
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.('.sf-toolstrip')) return;
      if (draft.current?.intent === 'selection') draft.current.cancel();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [isText]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) postToShell({ type: 'annotation', id });
  }, []);

  return (
    <div className={`sf-doc${isHtml ? ' sf-doc-html' : ''}${isDiagram ? ' sf-doc-diagram' : ''}`} data-surface-attachment={attachment.id} data-kind={attachment.kind}>
      {/* No onOpenLink: a link in the agent's page never becomes a bridge `link`
          (its script could forge the frame's message). With hostNavigates the
          tap navigates the frame and the shell's navigation delegate decides
          it as a real tap (contract section 5). */}
      {isHtml && open.html !== null && (
        <HtmlViewer
          ref={viewerRef}
          rawHtml={open.html}
          title={attachment.name}
          annotations={annotations}
          onAddAnnotation={() => {}}
          onSelectAnnotation={select}
          selectedAnnotationId={selectedId}
          mode="selection"
          inputMethod="pinpoint"
          annotateModeActive={!interact}
          fullViewport
          hideControls
          maxAdditionalTargets={0}
          onHostDraft={onHostDraft}
          hostNavigates
        />
      )}
      {isDiagram && (
        <Suspense fallback={null}>
          <SurfaceDiagram
            kind={attachment.kind as 'mermaid' | 'graphviz'}
            block={blocks[0]}
            annotations={annotations}
            selectedId={selectedId}
            onSelect={select}
            onHostDraft={onDiagramDraft}
          />
        </Suspense>
      )}
      {!isText && !isHtml && !isDiagram && (
        <div className="sf-file" data-surface-file={kind}>
          <div className="sf-file-name">{attachment.name}</div>
          <div className="sf-file-kind">{inboxAttachmentKindLabel(attachment.kind, attachment.name, attachment.media_type)}</div>
        </div>
      )}
      {isText && (
        <>
          <div className="sf-docscroll">
            <Viewer
              ref={viewerRef}
              blocks={blocks}
              markdown={open.text}
              annotations={annotations}
              onAddAnnotation={() => {}}
              onSelectAnnotation={select}
              selectedAnnotationId={selectedId}
              mode={mode}
              inputMethod={inputMethod}
              taterMode={false}
              maxWidth={null}
              stickyActions={false}
              disableCodePathValidation
              allowImages={false}
              readOnly={isCode}
              onHostDraft={onHostDraft}
            />
          </div>
          {!isCode && <div className="sf-toolstrip">
            <AnnotationToolstrip
              inputMethod={inputMethod}
              onInputMethodChange={(next) => {
                dropDraft();
                setInputMethod(next);
              }}
              mode={mode}
              onModeChange={(next) => {
                dropDraft();
                setMode(next);
              }}
              showHelpLink={false}
              hideQuickLabel
              hideRedline
              compact
            />
          </div>}
        </>
      )}
    </div>
  );
});
