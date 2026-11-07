/**
 * A file an agent's message names, opened beside the thread in the artifact pane's frame (approval
 * "inbox-file-refs-open-viewer"). The pane's own viewers draw it (ui's Viewer for a document, CodeFileView for code at
 * its line, HtmlViewer for a page, the image and video views). A file that is not here, or that the Inbox never shows,
 * says so calmly in the pane.
 *
 * It opens read only and attaches nothing. The person's first comment on it makes it an attachment of that message
 * (`inboxApi.attachReferencedFile`), saves the comment there, and the attachment opens in its place: from then on it is
 * commented, counted and sent like any attachment. A file the message already carries opens as that attachment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { CodeFileView } from '@plannotator/ui/components/CodeFilePopout';
import { HtmlViewer } from '@plannotator/ui/components/html-viewer';
import { HtmlSurfaceControls } from '@plannotator/ui/components/HtmlSurfaceControls';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import type { Annotation } from '@plannotator/ui/types';
import { inboxApi, InboxApiError, referencedFileRawUrl, type ReferencedFileScope, type ReferencedFileView } from '../api';
import { attachmentBlocks, codeCommentAnnotation, inboxViewKind } from '../attachments';
import { referencedCommentQueue } from '../referencedComments';
import { InboxFileSourceProvider, useInboxFileSource, type InboxFileSource } from '../fileSource';
import { Icon } from '../icons';
import { FileName } from './FileName';
import { CopyFileButton } from './CopyFileButton';
import { ImageAttachmentView } from './ImageAttachmentView';
import { VideoAttachmentView } from './VideoAttachmentView';
import { Tip } from './Tip';
import type { FileRef } from '../fileRefs';

const noop = () => {};
const NO_ANNOTATIONS: [] = [];

export interface OpenFileRef extends FileRef {
  /** The message that names it: where its path starts (its folder, its checkout), and the message it attaches to. */
  messageId: string;
}

function folderOfPath(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at + 1);
}

/** A link in a referenced document, from that document's folder (an absolute or `~` path stays as written). */
function joinPath(folder: string, href: string): string {
  if (href.startsWith('/') || href.startsWith('~/') || /^[a-z]:[\\/]/i.test(href)) return href;
  return `${folder}${href}`;
}

function linesLabel(ref: FileRef): string {
  if (!ref.line) return '';
  return ref.lineEnd && ref.lineEnd !== ref.line ? ` · lines ${ref.line}–${ref.lineEnd}` : ` · line ${ref.line}`;
}

/** What the viewers take as the file, before it is one: no record yet, so no sent version and nothing changed. */
function standIn(view: Extract<ReferencedFileView, { found: true }>, messageId: string): InboxAttachmentState {
  return {
    id: `ref:${messageId}:${view.path}`,
    path: view.path,
    named_path: null,
    name: view.name,
    kind: view.kind as InboxAttachmentState['kind'],
    sent_sha256: '',
    size: 0,
    sent_at: '',
    sent_mtime: '',
    message_id: messageId,
    current: null,
    changed_since_sent: false,
    unavailable: null,
  };
}

export function ReferencedFilePane({
  threadId,
  fileRef,
  phone,
  full,
  commentable = true,
  onOpen,
  onClose,
  onAttached,
}: {
  threadId: string;
  fileRef: OpenFileRef;
  agent?: string;
  phone: boolean;
  /** The window has room for the file only (a phone, a narrow window): it covers the thread. */
  full: boolean;
  /** False: read only (another machine's thread; a comment never attaches through the forward). */
  commentable?: boolean;
  /** A link in a referenced document: open that file in this pane. */
  onOpen: (ref: OpenFileRef) => void;
  onClose: () => void;
  /** It is an attachment of its message now (a comment made it one, or it already was): open that, `focus` its comment. */
  onAttached: (attachmentId: string, focus: string | null) => void | Promise<void>;
}) {
  const source = useInboxFileSource();
  const [view, setView] = useState<ReferencedFileView | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useMemo<ReferencedFileScope>(() => ({ thread: threadId, message: fileRef.messageId }), [threadId, fileRef.messageId]);
  const key = `${fileRef.messageId}\u0000${fileRef.path}`;
  const attachedRef = useRef(onAttached);
  attachedRef.current = onAttached;
  useEffect(() => {
    let live = true;
    setView(null);
    setFailed(false);
    setError(null);
    inboxApi
      .referencedFile(scope, fileRef.path)
      .then((answer) => {
        if (!live) return;
        // The message carries this file already: it opens as that attachment, comments and all.
        if (answer.found && answer.attachment_id) void attachedRef.current(answer.attachment_id, null);
        else setView(answer);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // `key` names the message and the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, key]);

  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true });
  }, [key]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!sectionRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Comments made here: the first attaches the file to its message, then each is kept there in the order made, and
   * the attachment opens (at the first). One more made while that runs waits its turn, never dropped. What is not
   * kept stays here, its words shown with the reason, until Try again keeps it.
   */
  const [unsaved, setUnsaved] = useState<object[]>([]);
  const comments = useMemo(
    () =>
      referencedCommentQueue({
        attach: async () => (await inboxApi.attachReferencedFile(scope, fileRef.path)).attachment.id,
        save: async (id, annotation) => (await inboxApi.saveAnnotation(id, 'current', annotation)).annotation.id,
        done: async (id, first) => {
          setUnsaved([]);
          setError(null);
          await attachedRef.current(id, first);
        },
        failed: (cause, left) => {
          setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not saved.');
          setUnsaved(left);
        },
      }),
    // A new file, a new queue. `key` names the message and the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  useEffect(() => setUnsaved([]), [key]);
  const save = useCallback((annotation: Annotation | object): Promise<boolean> => comments.add(annotation), [comments]);

  const name = view?.name ?? fileRef.path.split('/').pop() ?? fileRef.path;
  const found = view?.found ? view : null;
  // A PR's version is shown: a comment attaches this computer's file, so it is taken only where that is the same text.
  const writes = commentable && source.writes && !(found?.pull && !found.local_matches);
  // Drawn as an attachment of that kind is (inboxViewKind): a log or data file as code, with its lines and their
  // numbers, so a comment made here anchors the same way once it is attached.
  const kind = found ? inboxViewKind(found.kind, found.name) : null;
  const folder = folderOfPath(view?.path ?? fileRef.path);
  const openFromDoc = useCallback((href: string) => onOpen({ messageId: fileRef.messageId, path: joinPath(folder, href.replace(/[?#].*$/s, '')) }), [onOpen, fileRef.messageId, folder]);

  // An image or a film: the attachment views, reading this file's bytes until it is one.
  const media = found && (kind === 'image' || kind === 'video') ? standIn(found, fileRef.messageId) : null;
  const mediaSource = useMemo<InboxFileSource>(() => {
    const raw = () => referencedFileRawUrl(scope, fileRef.path);
    return { ...source, imageUrl: raw, videoUrl: raw, downloadUrl: raw, posterUrl: undefined, saveAnnotation: async () => Promise.reject(new Error('unused')), writes };
  }, [source, scope, fileRef.path, writes]);

  // A page: comments go on with the pinpoint, as on an attached page (a click on a link follows it with them off).
  const [armed, setArmed] = useState(!phone);
  const htmlComments = writes && !phone && kind === 'html';

  const missing = failed || (view !== null && !view.found);
  const reason = view && !view.found ? view.reason : 'missing';

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className={`ib-view ib-nopanel ib-refview${full ? ' ib-full' : ''}${phone ? ' ib-phone' : ''}`}
      aria-label={name}
      data-referenced-file={fileRef.path}
    >
      <div className="ib-vhead">
        {full && (
          <Tip content="Back to the thread">
            <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Back to the thread" data-ref-back="">
              <Icon name="chevL" />
            </button>
          </Tip>
        )}
        <span className="ib-fn" data-header-name="">
          <FileName name={name} />
        </span>
        <span className="ib-from" data-header-from="">
          {found?.pull ? `${found.pull.label}${linesLabel(fileRef)}` : `${fileRef.path}${linesLabel(fileRef)}`}
        </span>
        <span className="ib-sp" />
        {htmlComments && <HtmlSurfaceControls armed={armed} onToggleArmed={() => setArmed((v) => !v)} />}
        {!full && (
          <Tip content="Close">
            <button type="button" className="ib-iconbtn" onClick={onClose} aria-label={`Close ${name}`}>
              <Icon name="x" />
            </button>
          </Tip>
        )}
      </div>
      <div />
      <div className="ib-vbody">
        <div className={`ib-docarea${kind === 'html' ? ' ib-html' : ''}`}>
          {error && (
            <div className="ib-error ib-view-error" role="alert" data-ref-error="">
              {error}
              {unsaved.map((annotation, index) => (
                <q key={index} className="ib-ref-unsaved" data-ref-unsaved="">
                  {(annotation as { text?: string }).text ?? ''}
                </q>
              ))}
              {unsaved.length > 0 && (
                <button type="button" className="ib-btn ib-ghost ib-sm ib-ref-retry" onClick={() => void comments.retry()} data-ref-retry="">
                  Try again
                </button>
              )}
            </div>
          )}
          {!view && !failed && <div className="ib-refwait" aria-hidden="true" />}
          {missing && (
            <div className="ib-refmissing" role="status" data-ref-missing={reason}>
              <span className="ib-refmissing-ic">
                <Icon name="doc" size={22} />
              </span>
              <span className="ib-refmissing-name">{fileRef.path}</span>
              <span className="ib-refmissing-t">{reason === 'refused' ? 'does not show here.' : 'is not on this computer.'}</span>
            </div>
          )}
          {found && found.contents !== undefined && (kind === 'markdown' || kind === 'text') && (
            <RefDocument key={key} text={found.contents} name={name} kind={kind} scope={scope} folder={folder} onOpenLink={openFromDoc} onComment={writes ? save : undefined} />
          )}
          {found && found.contents !== undefined && (kind === 'code' || kind === 'mermaid' || kind === 'graphviz') && (
            <div className="ib-codeview" data-code-view="">
              <div className="ib-codehint" data-code-row="">
                <CopyFileButton text={found.contents} name={name} sent={false} announce={noop} />
                {writes && <span className="ib-codehint-t">{phone ? 'Tap a line to comment.' : 'Click a line number, drag across lines, or select code to comment.'}</span>}
              </div>
              <CodeFileView
                key={key}
                filepath={found.path}
                lineScroll="vertical"
                commentCard="plain"
                contents={found.contents}
                line={fileRef.line}
                lineEnd={fileRef.lineEnd}
                revealLine={fileRef.line ? { line: fileRef.line, token: 1 } : undefined}
                onAddAnnotation={
                  writes
                    ? (input) =>
                        void save(
                          codeCommentAnnotation({
                            id: `ann-code-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36)}`,
                            lineStart: input.lineStart,
                            lineEnd: input.lineEnd,
                            text: input.text,
                            code: input.originalCode,
                          }),
                        )
                    : undefined
                }
                allowImages={false}
                className="ib-codebody"
              />
            </div>
          )}
          {found && found.contents !== undefined && kind === 'html' && (
            <div className="ib-htmlframe">
              <HtmlViewer
                key={key}
                rawHtml={found.contents}
                frameUrl={source.pageFrameUrl}
                title={name}
                annotations={NO_ANNOTATIONS}
                onAddAnnotation={htmlComments ? (annotation) => void save(annotation) : noop}
                onSelectAnnotation={noop}
                selectedAnnotationId={null}
                mode="selection"
                inputMethod="pinpoint"
                annotateModeActive={htmlComments && armed}
                onAnnotateModeExit={() => setArmed(false)}
                onAnnotateModeToggle={htmlComments ? () => setArmed((v) => !v) : undefined}
                onOpenLink={openFromDoc}
                fullViewport
                hideControls
                maxAdditionalTargets={htmlComments ? undefined : 0}
                readOnly={!htmlComments}
              />
            </div>
          )}
          {media && (
            <InboxFileSourceProvider source={mediaSource}>
              {kind === 'image' ? (
                <ImageAttachmentView key={key} attachment={media} version="current" annotations={NO_ANNOTATIONS} selectedId={null} readOnly={!writes} onSave={save} onError={setError} />
              ) : (
                <VideoAttachmentView key={key} attachment={media} version="current" annotations={NO_ANNOTATIONS} selectedId={null} onSelect={noop} readOnly={!writes} onSave={save} onError={setError} phone={phone} />
              )}
            </InboxFileSourceProvider>
          )}
          {found && (found.tooLarge || (kind !== null && !['markdown', 'text', 'code', 'mermaid', 'graphviz', 'html', 'image', 'video'].includes(kind))) && (
            <div className="ib-refmissing" role="status" data-ref-missing="kind">
              <span className="ib-refmissing-ic">
                <Icon name="doc" size={22} />
              </span>
              <span className="ib-refmissing-name">{found.path}</span>
              <span className="ib-refmissing-t">{found.tooLarge ? 'is too large to show here.' : 'does not show here.'}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** A referenced document: its pictures and links from its own folder; a selection comments (`onComment`) when it may. */
function RefDocument({
  text,
  name,
  kind,
  scope,
  folder,
  onOpenLink,
  onComment,
}: {
  text: string;
  name: string;
  kind: 'markdown' | 'text';
  scope: ReferencedFileScope;
  folder: string;
  onOpenLink: (href: string) => void;
  onComment?: (annotation: Annotation) => Promise<boolean>;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const viewer = useRef<ViewerHandle>(null);
  const blocks = useMemo(() => attachmentBlocks(kind, text, name), [kind, text, name]);
  const resolveImage = useCallback<ImageResolver>(
    (src) => {
      if (/^(https?:|data:|blob:)/i.test(src)) return { kind: 'src', src };
      return { kind: 'src', src: referencedFileRawUrl(scope, joinPath(folder, src)) };
    },
    [scope, folder],
  );
  const openLinkRef = useRef(onOpenLink);
  openLinkRef.current = onOpenLink;
  const resolveLocalLink = useCallback<LocalLinkResolver>((href) => ({ kind: 'open', open: () => openLinkRef.current(href) }), []);
  return (
    <div className="ib-docscroll ib-linkeddoc bg-card" data-look="clean" ref={setViewport}>
      <ScrollViewportProvider viewport={viewport}>
        <ImageResolverContext.Provider value={resolveImage}>
          <Viewer
            ref={viewer}
            blocks={blocks}
            markdown={text}
            annotations={NO_ANNOTATIONS}
            onAddAnnotation={onComment ? (annotation) => void onComment(annotation) : noop}
            onSelectAnnotation={noop}
            selectedAnnotationId={null}
            resolveLocalLink={resolveLocalLink}
            questionDecisionLines={false}
            stickyActions={false}
            disableCodePathValidation
            copyLabel="Copy file"
            maxWidth={760}
            mode="comment"
            inputMethod="drag"
            taterMode={false}
            gridEnabled={false}
            allowImages={false}
            quickLabels={false}
            readOnly={!onComment}
          />
        </ImageResolverContext.Provider>
      </ScrollViewportProvider>
    </div>
  );
}
