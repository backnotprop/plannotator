import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { AnnotationToolstrip } from '@plannotator/ui/components/AnnotationToolstrip';
import { HtmlSurfaceControls } from '@plannotator/ui/components/HtmlSurfaceControls';
import { HtmlViewer } from '@plannotator/ui/components/html-viewer';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import type { Annotation, EditorMode, InputMethod } from '@plannotator/ui/types';
import { annotationOwnsHighlight } from '@plannotator/ui/utils/annotationOwnsHighlight';
import { groupAnnotationsByDocument, type AnnotationScope } from '@plannotator/ui/utils/annotationScope';
import { InboxApiError, inboxApi, type AttachmentView } from '../api';
import { annotationOf, attachmentBlocks, attachmentLabel } from '../attachments';
import { clockTime } from '../format';
import { Icon } from '../icons';

export interface AttachmentPaneProps {
  attachment: InboxAttachmentState;
  /** Every attachment of the thread, for the panel's files and the strip. */
  attachments: readonly InboxAttachmentState[];
  /** The thread's annotations waiting for a Send. */
  records: readonly InboxAnnotationRecord[];
  agent: string;
  projectName: string;
  projectRoot: string;
  version: 'current' | 'sent';
  onVersion: (version: 'current' | 'sent') => void;
  full: boolean;
  onToggleFull: () => void;
  /** An annotation to select when the file opens (from the chip's list). */
  focusId: string | null;
  readOnly: boolean;
  onSaved: (record: InboxAnnotationRecord) => void;
  onRemoved: (id: string) => void;
  /** Open another attachment (a card of another file in the panel). */
  onOpenAt: (attachmentId: string, version: 'current' | 'sent', annotationId: string) => void;
  onClose: () => void;
  /** Full screen's strip: what rides the next Send, and the way back. */
  strip: { picks: number; annotations: number; onBack: () => void; onWriteReply: () => void };
}

const recordKey = (path: string, version: string) => (version === 'current' ? path : `${path}#${version.slice(0, 12)}`);

/**
 * An attachment opened (record 2.2 to 2.5): beside the thread for markdown
 * and diagrams, full screen for HTML, with Plannotator's viewers and its
 * annotation panel. The changed line offers the version the agent sent.
 */
export function AttachmentPane(props: AttachmentPaneProps) {
  const { attachment, version } = props;
  const [view, setView] = useState<AttachmentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(props.focusId);
  const [unanchored, setUnanchored] = useState<ReadonlySet<string>>(new Set());
  const [inputMethod, setInputMethod] = useState<InputMethod>('drag');
  const [mode, setMode] = useState<EditorMode>('selection');
  const [armed, setArmed] = useState(true);
  const [scope, setScope] = useState<AnnotationScope>('all');
  const viewerRef = useRef<ViewerHandle>(null);

  // The current file cannot be read (gone, or no longer the file that was sent): the sent version opens.
  const currentUnavailable = attachment.unavailable !== null;
  const effectiveVersion = currentUnavailable ? 'sent' : version;

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    setUnanchored(new Set());
    inboxApi
      .view(attachment.id, effectiveVersion)
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof InboxApiError ? cause.message : 'The file could not be opened.');
      });
    return () => {
      cancelled = true;
    };
    // A changed file on disk (a new hash) reads again.
  }, [attachment.id, effectiveVersion, attachment.current?.sha256]);

  useEffect(() => setSelectedId(props.focusId), [props.focusId, attachment.id]);

  const annotationVersion = view?.version ?? (effectiveVersion === 'sent' ? attachment.sent_sha256 : 'current');
  const fileRecords = useMemo(
    () => props.records.filter((r) => r.path === attachment.path && r.version === annotationVersion),
    [props.records, attachment.path, annotationVersion],
  );
  const annotations = useMemo(() => fileRecords.map(annotationOf), [fileRecords]);
  const blocks = useMemo(() => (view ? attachmentBlocks(attachment.kind, view.text, attachment.name) : []), [view, attachment.kind, attachment.name]);

  // Paint the stored text highlights once per document read; a new comment paints itself.
  const painted = useRef<string | null>(null);
  useEffect(() => {
    if (!view || attachment.kind === 'html') return;
    const key = `${attachment.id}\0${view.version}\0${view.text.length}`;
    if (painted.current === key) return;
    painted.current = key;
    const id = requestAnimationFrame(() => viewerRef.current?.applySharedAnnotations(annotations.filter(annotationOwnsHighlight)));
    return () => cancelAnimationFrame(id);
  }, [view, attachment.kind, attachment.id, annotations]);

  const save = useCallback(
    async (annotation: Annotation) => {
      try {
        const result = await inboxApi.saveAnnotation(attachment.id, annotationVersion, annotation);
        props.onSaved(result.annotation);
      } catch (cause) {
        setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not saved.');
      }
    },
    [attachment.id, annotationVersion, props.onSaved],
  );

  const remove = async (id: string) => {
    viewerRef.current?.removeHighlight(id);
    try {
      await inboxApi.removeAnnotation(id);
      props.onRemoved(id);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not removed.');
    }
  };

  const edit = (id: string, updates: Partial<Annotation>) => {
    const record = props.records.find((r) => r.id === id);
    if (record) void save({ ...annotationOf(record), ...updates });
  };

  // The panel lists the thread's other files too, each under its own name (record 2.4).
  const documents = useMemo(() => {
    const byKey = new Map<string, { path: string; label: string; annotations: Annotation[] }>();
    for (const record of props.records) {
      const owner = props.attachments.find((a) => a.id === record.attachment_id) ?? attachment;
      const key = recordKey(record.path, record.version);
      const entry = byKey.get(key) ?? {
        path: key,
        label: `${attachmentLabel(owner, props.projectRoot)}${record.version === 'current' ? '' : ' (sent)'}`,
        annotations: [],
      };
      entry.annotations.push(annotationOf(record));
      byKey.set(key, entry);
    }
    return [...byKey.values()];
  }, [props.records, props.attachments, props.projectRoot, attachment]);
  const currentKey = recordKey(attachment.path, annotationVersion);
  const otherFiles = documents.some((d) => d.path !== currentKey);
  const groups = useMemo(() => groupAnnotationsByDocument(documents, currentKey), [documents, currentKey]);
  const openInDocument = (_path: string, id: string) => {
    const record = props.records.find((r) => r.id === id);
    if (!record) return;
    if (recordKey(record.path, record.version) === currentKey) setSelectedId(id);
    else props.onOpenAt(record.attachment_id, record.version === 'current' ? 'current' : 'sent', id);
  };

  const sentAt = clockTime(attachment.sent_at);
  let line: React.ReactNode = null;
  if (currentUnavailable) {
    line = (
      <>
        {attachment.unavailable!.message} This is the version {props.agent} sent at {sentAt}.
      </>
    );
  } else if (effectiveVersion === 'sent') {
    line = (
      <>
        The version {props.agent} sent at {sentAt}.
        <button type="button" className="ib-vlink" onClick={() => props.onVersion('current')}>
          Open the file as it is now
        </button>
      </>
    );
  } else if ((view?.attachment ?? attachment).changed_since_sent) {
    const current = (view?.attachment ?? attachment).current;
    line = (
      <>
        Changed since {props.agent} sent it at {sentAt}.{current ? ` Edited ${clockTime(current.mtime)}.` : ''}
        <button type="button" className="ib-vlink" onClick={() => props.onVersion('sent')}>
          Open the version it sent
        </button>
      </>
    );
  }

  const isHtml = attachment.kind === 'html';
  const isText = attachment.kind === 'markdown' || attachment.kind === 'text';
  const chipText = [
    props.strip.picks > 0 ? `${props.strip.picks} pick${props.strip.picks === 1 ? '' : 's'}` : null,
    `${props.strip.annotations} annotation${props.strip.annotations === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <section
      className={`ib-view${props.full ? ' ib-full' : ''}`}
      aria-label={attachment.name}
      data-attachment-pane={attachment.id}
      data-version={effectiveVersion}
    >
      <div className="ib-vhead">
        <span className="ib-fn">{attachment.name}</span>
        <span className="ib-from">
          from {props.agent} in {props.projectName}
        </span>
        <span className="ib-sp" />
        {isHtml && <HtmlSurfaceControls armed={armed} onToggleArmed={props.readOnly ? undefined : () => setArmed((v) => !v)} />}
        <button type="button" className="ib-btn ib-sm" onClick={props.onToggleFull}>
          <Icon name={props.full ? 'collapse' : 'expand'} size={14} />
          {props.full ? 'Exit full screen' : 'Full screen'}
        </button>
        <button type="button" className="ib-iconbtn" onClick={props.onClose} aria-label={`Close ${attachment.name}`} title="Close">
          <Icon name="x" />
        </button>
      </div>
      {line ? (
        <div className="ib-changed" data-changed-line="">
          <Icon name="info" size={14} />
          {line}
        </div>
      ) : (
        <div />
      )}
      <div className="ib-vbody">
        <div className={`ib-docarea${isHtml ? ' ib-html' : ''}`}>
          {error && (
            <div className="ib-error ib-view-error" role="alert">
              {error}
            </div>
          )}
          {view && isHtml && view.html !== null && (
            <div className="ib-htmlframe">
            <HtmlViewer
              key={`${attachment.id}:${view.version}:${view.attachment.current?.sha256 ?? ''}`}
              rawHtml={view.html}
              title={attachment.name}
              annotations={annotations}
              onAddAnnotation={(annotation) => void save(annotation)}
              onSelectAnnotation={setSelectedId}
              selectedAnnotationId={selectedId}
              mode="selection"
              inputMethod="pinpoint"
              annotateModeActive={armed}
              onAnnotateModeExit={() => setArmed(false)}
              onAnnotateModeToggle={() => setArmed((v) => !v)}
              onOpenLink={(href) => {
                if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
              }}
              onUnanchoredChange={(ids) => setUnanchored(new Set(ids))}
              fullViewport
              hideControls
              maxAdditionalTargets={0}
              readOnly={props.readOnly}
            />
            </div>
          )}
          {view && isText && !props.readOnly && (
            <div className="ib-toolstrip">
              <AnnotationToolstrip
                inputMethod={inputMethod}
                onInputMethodChange={setInputMethod}
                mode={mode}
                onModeChange={setMode}
                showHelpLink={false}
                hideQuickLabel
                compact
              />
            </div>
          )}
          {view && !isHtml && (
            <div className="ib-docscroll">
              <div className="ib-doccard">
                <Viewer
                  key={`${attachment.id}:${view.version}:${view.attachment.current?.sha256 ?? ''}`}
                  ref={viewerRef}
                  blocks={blocks}
                  markdown={view.text}
                  annotations={annotations}
                  onAddAnnotation={(annotation) => void save(annotation)}
                  onSelectAnnotation={setSelectedId}
                  selectedAnnotationId={selectedId}
                  mode={isText ? mode : 'comment'}
                  inputMethod={isText ? inputMethod : 'drag'}
                  taterMode={false}
                  maxWidth={null}
                  stickyActions={false}
                  disableCodePathValidation
                  copyLabel="Copy file"
                  allowImages={false}
                  readOnly={props.readOnly}
                  onRestoreReport={(report) => setUnanchored(new Set(report.unanchored))}
                />
              </div>
            </div>
          )}
          {props.full && (
            <div className="ib-vstrip">
              <span className="ib-l">Reply to {props.agent}</span>
              <span className="ib-rchip" data-strip-chip="">
                {chipText}
              </span>
              <span className="ib-l">ride your next Send.</span>
              <span className="ib-sp" />
              <button type="button" className="ib-btn" onClick={props.strip.onBack}>
                <Icon name="back" size={15} />
                Back to the thread
              </button>
              <button type="button" className="ib-btn ib-pri" onClick={props.strip.onWriteReply}>
                <Icon name="reply" size={15} />
                Write the reply
              </button>
            </div>
          )}
        </div>
        <div className="ib-apanel">
          <AnnotationPanel
            isOpen
            annotations={annotations}
            blocks={blocks}
            onSelect={setSelectedId}
            onDelete={(id) => void remove(id)}
            onEdit={edit}
            selectedId={selectedId}
            width="100%"
            readOnly={props.readOnly}
            unanchoredIds={unanchored}
            annotationScope={otherFiles ? scope : undefined}
            onAnnotationScopeChange={otherFiles ? setScope : undefined}
            documentGroups={otherFiles ? groups : undefined}
            onSelectInDocument={openInDocument}
            onDeleteInDocument={(_path, id) => void remove(id)}
            onEditInDocument={(_path, id, updates) => edit(id, updates)}
          />
        </div>
      </div>
    </section>
  );
}
