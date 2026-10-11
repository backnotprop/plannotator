import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inboxAttachmentKindLabel, isInboxTextKind, readInboxAttachmentKind, type InboxAnnotationRecord, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { CodeFileView } from '@plannotator/ui/components/CodeFilePopout';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { AnnotationToolstrip } from '@plannotator/ui/components/AnnotationToolstrip';
import { HtmlSurfaceControls } from '@plannotator/ui/components/HtmlSurfaceControls';
import { HtmlViewer } from '@plannotator/ui/components/html-viewer';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { useConfigValue } from '@plannotator/ui/config';
import type { Annotation, EditorMode, InputMethod } from '@plannotator/ui/types';
import { annotationOwnsHighlight } from '@plannotator/ui/utils/annotationOwnsHighlight';
import { groupAnnotationsByDocument, type AnnotationScope } from '@plannotator/ui/utils/annotationScope';
import { InboxApiError, inboxApi, type AttachmentView } from '../api';
import {
  annotationOf,
  attachmentBlocks,
  attachmentDownloadUrl,
  CODE_HIGHLIGHT_MAX_CHARS,
  attachmentLabel,
  codeAnnotationOf,
  codeCommentAnnotation,
  codeCommentBlocks,
  codeRangeOf,
} from '../attachments';
import { clockTime, formatBytes } from '../format';
import { ImageAttachmentView } from './ImageAttachmentView';
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
  /**
   * Bumped each time the person opens a file (its tile, or a link to it in
   * a message): keyboard focus moves into the pane, so a file opened full
   * screen is not left behind the control that opened it.
   */
  focusRequest?: number;
}

const recordKey = (path: string, version: string) => (version === 'current' ? path : `${path}#${version.slice(0, 12)}`);

/**
 * An attachment opened (record 2.2 to 2.5): beside the thread for markdown,
 * diagrams and code (read-only, one highlighted code block), full screen for
 * HTML, with Plannotator's viewers and its annotation panel. The changed line offers the version the agent sent.
 */
export function AttachmentPane(props: AttachmentPaneProps) {
  const { attachment, version } = props;
  const [view, setView] = useState<AttachmentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The text grew past what the window reads whole (413): the Download card instead.
  const [tooLarge, setTooLarge] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(props.focusId);
  const [unanchored, setUnanchored] = useState<ReadonlySet<string>>(new Set());
  const [inputMethod, setInputMethod] = useState<InputMethod>('drag');
  const [mode, setMode] = useState<EditorMode>('selection');
  const [armed, setArmed] = useState(true);
  const [scope, setScope] = useState<AnnotationScope>('all');
  const viewerRef = useRef<ViewerHandle>(null);
  // Plannotator's plan look (Settings, "Grid" or "Clean"), read from the same registry and cookie as its windows.
  const gridEnabled = useConfigValue('gridEnabled');

  // The current file cannot be read (gone, or no longer the file that was sent): the sent version opens.
  const currentUnavailable = attachment.unavailable !== null;
  const effectiveVersion = currentUnavailable ? 'sent' : version;
  const kind = readInboxAttachmentKind(attachment.kind);
  // Text kinds read through the view route; an image draws from its own route, a PDF or a file downloads.
  const readsText = isInboxTextKind(kind);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setTooLarge(false);
    setError(null);
    setUnanchored(new Set());
    if (!readsText) return;
    inboxApi
      .view(attachment.id, effectiveVersion)
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((cause) => {
        if (cancelled) return;
        if (cause instanceof InboxApiError && cause.code === 'attachment_too_large') setTooLarge(true);
        else setError(cause instanceof InboxApiError ? cause.message : 'The file could not be opened.');
      });
    return () => {
      cancelled = true;
    };
    // A changed file on disk (a new hash) reads again.
  }, [attachment.id, effectiveVersion, attachment.current?.sha256, readsText]);

  useEffect(() => setSelectedId(props.focusId), [props.focusId, attachment.id]);

  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (props.focusRequest) sectionRef.current?.focus({ preventScroll: true });
  }, [props.focusRequest]);

  const annotationVersion = view?.version ?? (effectiveVersion === 'sent' ? attachment.sent_sha256 : 'current');
  const isHtml = kind === 'html';
  const isText = kind === 'markdown' || kind === 'text';
  const isCode = kind === 'code';
  const isImage = kind === 'image';
  // A PDF, any other file, and a kind this window does not know: offered as a download.
  const isDownload = kind === 'pdf' || kind === 'file' || tooLarge;
  const fileRecords = useMemo(
    () => props.records.filter((r) => r.path === attachment.path && r.version === annotationVersion),
    [props.records, attachment.path, annotationVersion],
  );
  const annotations = useMemo(() => fileRecords.map(annotationOf), [fileRecords]);
  // The document's blocks keep their identity across saves (the Viewer re-renders on a new array);
  // only code comments, which carry their own lines, derive blocks from the annotations.
  const documentBlocks = useMemo(() => (view && !isCode ? attachmentBlocks(kind, view.text, attachment.name) : []), [view, kind, isCode, attachment.name]);
  const commentBlocks = useMemo(() => (isCode ? codeCommentBlocks(annotations) : []), [isCode, annotations]);
  const blocks = isCode ? commentBlocks : documentBlocks;
  // Code comments drawn under their lines; one whose lines no longer read as they did is unanchored.
  const codeAnnotations = useMemo(
    () => (isCode ? annotations.map((a) => codeAnnotationOf(a, attachment.name)).filter((a): a is NonNullable<typeof a> => a !== null) : []),
    [isCode, annotations, attachment.name],
  );
  useEffect(() => {
    if (!isCode || !view) return;
    const lines = view.text.split('\n');
    const moved = new Set<string>();
    for (const annotation of annotations) {
      const range = codeRangeOf(annotation);
      if (range && lines.slice(range.lineStart - 1, range.lineEnd).join('\n') !== range.code) moved.add(annotation.id);
    }
    setUnanchored(moved);
  }, [isCode, view, annotations]);

  // Paint the stored text highlights once per document read; a new comment paints itself.
  const painted = useRef<string | null>(null);
  useEffect(() => {
    if (!view || isHtml || isCode) return;
    const key = `${attachment.id}\0${view.version}\0${view.text.length}`;
    if (painted.current === key) return;
    painted.current = key;
    const id = requestAnimationFrame(() => viewerRef.current?.applySharedAnnotations(annotations.filter(annotationOwnsHighlight)));
    return () => cancelAnimationFrame(id);
  }, [view, attachment.kind, attachment.id, annotations]);

  const save = useCallback(
    async (annotation: Annotation): Promise<boolean> => {
      try {
        const result = await inboxApi.saveAnnotation(attachment.id, annotationVersion, annotation);
        props.onSaved(result.annotation);
        return true;
      } catch (cause) {
        setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not saved.');
        return false;
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

  const chipText = [
    props.strip.picks > 0 ? `${props.strip.picks} pick${props.strip.picks === 1 ? '' : 's'}` : null,
    `${props.strip.annotations} annotation${props.strip.annotations === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
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
        <a
          className="ib-btn ib-sm ib-ghost"
          href={attachmentDownloadUrl(attachment, effectiveVersion)}
          download={attachment.name}
          title={`Download ${attachment.name}${effectiveVersion === 'sent' ? ' (the version it sent)' : ''}`}
          data-attachment-download=""
        >
          <Icon name="download" size={14} />
          Download
        </a>
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
          {isImage && (
            <ImageAttachmentView
              attachment={attachment}
              version={effectiveVersion}
              annotations={annotations}
              selectedId={selectedId}
              readOnly={props.readOnly}
              onSave={save}
              onError={setError}
            />
          )}
          {isDownload && (
            <div className="ib-docscroll" data-download-card="">
              <div className="ib-att-t ib-dlcard">
                <span className="ib-fi">
                  <Icon name={kind === 'pdf' ? 'doc' : 'cube'} size={18} />
                </span>
                <span className="ib-att-text">
                  <span className="ib-nm">{attachment.name}</span>
                  <span className="ib-kd">
                    {inboxAttachmentKindLabel(attachment.kind, attachment.name, attachment.media_type)}, {formatBytes(attachment.current?.size ?? attachment.size)}. {tooLarge ? 'It is too large to show here; download it to open it.' : 'Plannotator does not show this kind of file; download it to open it.'}
                  </span>
                </span>
                <a className="ib-btn ib-pri" href={attachmentDownloadUrl(attachment, effectiveVersion)} download={attachment.name}>
                  <Icon name="download" size={14} />
                  Download
                </a>
              </div>
            </div>
          )}
          {view && isCode && (
            <div className="ib-codeview" data-code-view="">
              {!props.readOnly && <div className="ib-codehint">Click a line number, drag across lines, or select code to comment.</div>}
              <CodeFileView
                key={`${attachment.id}:${view.version}:${view.attachment.current?.sha256 ?? ''}`}
                filepath={attachment.name}
                contents={view.text}
                annotations={codeAnnotations}
                selectedAnnotationId={selectedId}
                onSelectAnnotation={setSelectedId}
                onAddAnnotation={
                  props.readOnly
                    ? undefined
                    : (input) =>
                        void save(
                          codeCommentAnnotation({
                            id: `ann-code-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36)}`,
                            lineStart: input.lineStart,
                            lineEnd: input.lineEnd,
                            text: input.text,
                            code: input.originalCode,
                          }),
                        )
                }
                onEditAnnotation={props.readOnly ? undefined : (id, updates) => edit(id, { text: updates.text })}
                onDeleteAnnotation={props.readOnly ? undefined : (id) => void remove(id)}
                allowImages={false}
                lang={view.text.length > CODE_HIGHLIGHT_MAX_CHARS ? 'text' : undefined}
                className="ib-codebody"
              />
            </div>
          )}
          {view && !isHtml && !isCode && (
            <div className={`ib-docscroll ${gridEnabled ? 'bg-grid' : 'bg-card'}`} data-look={gridEnabled ? 'grid' : 'clean'}>
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
                gridEnabled={gridEnabled}
                maxWidth={props.full ? 760 : 640}
                stickyActions={false}
                disableCodePathValidation
                copyLabel="Copy file"
                allowImages={false}
                readOnly={props.readOnly}
                onRestoreReport={(report) => setUnanchored(new Set(report.unanchored))}
              />
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
            emptyHint={isImage ? 'Comment below the image' : isCode ? 'Click a line to comment' : undefined}
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
