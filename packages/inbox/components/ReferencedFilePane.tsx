/**
 * Design prototype "file-refs-open-pane": a file an agent's message names, opened beside the thread in the artifact
 * pane's frame, read only. The pane's own viewers draw it (ui's Viewer for a document, CodeFileView for code at its
 * line, HtmlViewer for a page, the picture, the film). A file that is not here, or not one the Inbox opens, says so
 * calmly in the pane.
 *
 * Not attached, so no comments: the same rule and words as a page an attached page links to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { CodeFileView } from '@plannotator/ui/components/CodeFilePopout';
import { HtmlViewer } from '@plannotator/ui/components/html-viewer';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import { inboxApi, type ReferencedFileView } from '../api';
import { attachmentBlocks } from '../attachments';
import { useInboxFileSource } from '../fileSource';
import { Icon } from '../icons';
import { FileName } from './FileName';
import { CopyFileButton } from './CopyFileButton';
import { Tip } from './Tip';
import type { FileRef } from '../fileRefs';

const noop = () => {};
const NO_ANNOTATIONS: [] = [];

export interface OpenFileRef extends FileRef {
  /** The message that names it: where its path starts (its folder, its checkout). */
  messageId: string;
}

function folderOfPath(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at + 1);
}

/** A link in a referenced document, from that document's folder (a `..` stays as written; the server holds the root). */
function joinPath(folder: string, href: string): string {
  if (href.startsWith('/') || /^[a-z]:[\\/]/i.test(href)) return href;
  return `${folder}${href}`;
}

function linesLabel(ref: FileRef): string {
  if (!ref.line) return '';
  return ref.lineEnd && ref.lineEnd !== ref.line ? ` · lines ${ref.line}–${ref.lineEnd}` : ` · line ${ref.line}`;
}

export function ReferencedFilePane({
  threadId,
  fileRef,
  phone,
  full,
  onOpen,
  onClose,
}: {
  threadId: string;
  fileRef: OpenFileRef;
  agent?: string;
  phone: boolean;
  /** The window has room for the file only (a phone, a narrow window): it covers the thread. */
  full: boolean;
  /** A link in a referenced document: open that file in this pane. */
  onOpen: (ref: OpenFileRef) => void;
  onClose: () => void;
}) {
  const source = useInboxFileSource();
  const [view, setView] = useState<ReferencedFileView | null>(null);
  const [failed, setFailed] = useState(false);
  const key = `${fileRef.messageId}\u0000${fileRef.path}`;
  useEffect(() => {
    let live = true;
    setView(null);
    setFailed(false);
    inboxApi
      .referencedFile({ thread: threadId, message: fileRef.messageId }, fileRef.path)
      .then((answer) => live && setView(answer))
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

  const name = view?.name ?? fileRef.path.split('/').pop() ?? fileRef.path;
  const kind = view?.found ? view.kind : null;
  const folder = folderOfPath(view?.path ?? fileRef.path);
  const openFromDoc = useCallback((href: string) => onOpen({ messageId: fileRef.messageId, path: joinPath(folder, href.replace(/[?#].*$/s, '')) }), [onOpen, fileRef.messageId, folder]);

  // ui's line reveal falls back to scrollIntoView, which slides a long row sideways by the gutter's width: put it back
  // (prototype only; the fix belongs in CodeFileView's fallback).
  const codeRef = useRef<HTMLDivElement>(null);
  const loaded = view?.found ? view.path : null;
  useEffect(() => {
    if (!fileRef.line || !loaded) return;
    let frames = 0;
    let id = 0;
    const settle = () => {
      const root = codeRef.current?.querySelector('diffs-container')?.shadowRoot;
      for (const el of root?.querySelectorAll<HTMLElement>('code, pre') ?? []) if (el.scrollLeft > 0) el.scrollLeft = 0;
      if (++frames < 90) id = requestAnimationFrame(settle);
    };
    id = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(id);
  }, [loaded, fileRef.line]);

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
          {view?.found && view.pull ? `${view.pull.label}${linesLabel(fileRef)}` : `${fileRef.path}${linesLabel(fileRef)}`}
        </span>
        <span className="ib-sp" />
        {!full && (
          <Tip content="Close">
            <button type="button" className="ib-iconbtn" onClick={onClose} aria-label={`Close ${name}`}>
              <Icon name="x" />
            </button>
          </Tip>
        )}
      </div>
      {view?.found ? (
        <div className="ib-refnote" data-ref-note="">
          <Icon name="info" size={13} />
          <span>
            <b>{name}</b> is not attached, so comments are off.
          </span>
        </div>
      ) : (
        <div />
      )}
      <div className="ib-vbody">
        <div className={`ib-docarea${kind === 'html' ? ' ib-html' : ''}`}>
          {!view && !failed && <div className="ib-refwait" aria-hidden="true" />}
          {missing && (
            <div className="ib-refmissing" role="status" data-ref-missing={reason}>
              <span className="ib-refmissing-ic">
                <Icon name="doc" size={22} />
              </span>
              <span className="ib-refmissing-name">{fileRef.path}</span>
              <span className="ib-refmissing-t">{reason === 'refused' ? 'is not a file of this project.' : 'is not on this computer.'}</span>
            </div>
          )}
          {view?.found && view.contents !== undefined && (kind === 'markdown' || kind === 'text') && (
            <RefDocument key={key} text={view.contents} name={name} kind={kind} scope={{ thread: threadId, message: fileRef.messageId }} folder={folder} onOpenLink={openFromDoc} />
          )}
          {view?.found && view.contents !== undefined && (kind === 'code' || kind === 'mermaid' || kind === 'graphviz') && (
            <div className="ib-codeview" data-code-view="" ref={codeRef}>
              <div className="ib-codehint" data-code-row="">
                <CopyFileButton text={view.contents} name={name} sent={false} announce={noop} />
              </div>
              <CodeFileView
                key={key}
                filepath={view.path}
                contents={view.contents}
                line={fileRef.line}
                lineEnd={fileRef.lineEnd}
                // A line near the top is on screen already; ui's reveal scrolls a short file's long row sideways (its fallback).
                revealLine={fileRef.line ? { line: fileRef.line, token: 1 } : undefined}
                allowImages={false}
                className="ib-codebody"
              />
            </div>
          )}
          {view?.found && view.contents !== undefined && kind === 'html' && (
            <div className="ib-htmlframe">
              <HtmlViewer
                key={key}
                rawHtml={view.contents}
                frameUrl={source.pageFrameUrl}
                title={name}
                annotations={NO_ANNOTATIONS}
                onAddAnnotation={noop}
                onSelectAnnotation={noop}
                selectedAnnotationId={null}
                mode="selection"
                inputMethod="pinpoint"
                annotateModeActive={false}
                onOpenLink={openFromDoc}
                fullViewport
                hideControls
                maxAdditionalTargets={0}
                readOnly
              />
            </div>
          )}
          {view?.found && kind === 'image' && view.raw && (
            <div className="ib-refmedia" data-ref-image="">
              <img src={view.raw} alt={name} />
            </div>
          )}
          {view?.found && kind === 'video' && view.raw && (
            <div className="ib-refmedia" data-ref-video="">
              <video src={view.raw} controls playsInline preload="metadata" />
            </div>
          )}
          {view?.found && (view.tooLarge || kind === 'pdf' || kind === 'file') && (
            <div className="ib-refmissing" role="status" data-ref-missing="kind">
              <span className="ib-refmissing-ic">
                <Icon name="doc" size={22} />
              </span>
              <span className="ib-refmissing-name">{view.path}</span>
              <span className="ib-refmissing-t">{view.tooLarge ? 'is too large to show here.' : 'does not show here.'}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** A referenced document: read only, its pictures and links from its own folder. */
function RefDocument({ text, name, kind, scope, folder, onOpenLink }: { text: string; name: string; kind: 'markdown' | 'text'; scope: { thread: string; message: string }; folder: string; onOpenLink: (href: string) => void }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const viewer = useRef<ViewerHandle>(null);
  const blocks = useMemo(() => attachmentBlocks(kind, text, name), [kind, text, name]);
  const resolveImage = useCallback<ImageResolver>(
    (src) => {
      if (/^(https?:|data:|blob:)/i.test(src)) return { kind: 'src', src };
      const raw = new URLSearchParams({ ...scope, path: joinPath(folder, src) });
      return { kind: 'src', src: `/api/inbox/open-in/file/raw?${raw}` };
    },
    [scope.thread, scope.message, folder],
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
            onAddAnnotation={noop}
            onSelectAnnotation={noop}
            selectedAnnotationId={null}
            resolveLocalLink={resolveLocalLink}
            questionDecisionLines={false}
            stickyActions={false}
            disableCodePathValidation
            maxWidth={760}
            mode="comment"
            taterMode={false}
            readOnly
          />
        </ImageResolverContext.Provider>
      </ScrollViewportProvider>
    </div>
  );
}
