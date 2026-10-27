/**
 * The thread's Artifacts view (approval "inbox-thread-artifacts", 2026-10-23,
 * variant Swap): every file, image and guided review across the thread's
 * messages, as one grid, newest message first. It swaps in for the thread's
 * messages (the messages never change: it is a second view of the same
 * thread, not a filter). A tile opens exactly what its tile in the message
 * opens: the same viewer and view rule; PDFs and other files download; a
 * guided review opens its reader. With a file open beside the thread, the
 * grid stays in the thread's column with that file's tile ringed.
 *
 * Previews load only once a tile is near the screen: an image's thumbnail,
 * a video's first frame and length, the first lines of a document or code
 * file, a diagram drawn small, an HTML page drawn small in a frame that runs
 * no script, a typed face for anything else, the guide's own face.
 */

import { forwardRef, useEffect, useRef, useState } from 'react';
import {
  formatInboxVideoTime,
  inboxAttachmentKindLabel,
  readInboxAttachmentKind,
  type InboxAttachmentKind,
  type InboxAttachmentState,
} from '@plannotator/core/inbox-types';
import { artifactKey, artifactMessageCount, artifactsNewestFirst, type Artifact, type FileArtifact, type GuideArtifact } from '../artifacts';
import { readableVersion } from '../attachments';
import { attachmentFramePolicy } from '../framePolicy';
import { prependSrcdocPolicy } from '@plannotator/ui/components/html-viewer';
import { useInboxFileSource, type InboxFileSource } from '../fileSource';
import { formatBytes, formatCount, fullTime, plural } from '../format';
import { HostMark, Icon, type IconName } from '../icons';
import { ArtifactDiagramFace } from './ArtifactDiagramFace';
import { opensInWindow, sizeLine } from './AttachmentTiles';
import { FileName } from './FileName';
import { OpenInTileMenu, type OpenInSurface } from './OpenIn';
import { Tip } from './Tip';

/** The words under a tile's name: "PNG image, 1280 × 800, 38.4 KB", "Code (.sql), 331 B", "WebM video · 0:03 · 48.2 KB". */
export function artifactDetail(artifact: Artifact): string {
  if (artifact.type === 'guide') {
    const { guide } = artifact;
    return `Guided review, ${plural(guide.sections, 'section')}, ${plural(guide.files, 'file')}`;
  }
  const { attachment } = artifact;
  if (readInboxAttachmentKind(attachment.kind) === 'image') {
    const kind = inboxAttachmentKindLabel(attachment.kind, attachment.name, attachment.media_type);
    const size = formatBytes(attachment.current?.size ?? attachment.size);
    return attachment.width && attachment.height ? `${kind}, ${attachment.width} × ${attachment.height}, ${size}` : `${kind}, ${size}`;
  }
  return sizeLine(attachment);
}

/** A file that is not what was sent any more, in a tile's short words, or null. */
export function artifactChanged(attachment: InboxAttachmentState): { short: string; long: string } | null {
  if (attachment.unavailable) {
    return attachment.unavailable.code === 'attachment_missing'
      ? { short: 'No longer on disk', long: 'no longer on disk, the sent version opens' }
      : { short: 'Changed type', long: 'changed type, the sent version opens' };
  }
  if (attachment.changed_since_sent && attachment.current) {
    return attachment.captured === 'on_open'
      ? { short: 'Changed since opened', long: 'changed since you first opened it' }
      : { short: 'Changed since sent', long: 'changed since it was sent' };
  }
  return null;
}

/**
 * A tile's accessible name: everything the tile shows, in one sentence.
 * "checkout-after.png, PNG image, 1280 × 800, 38.4 KB, from Claude Code at
 * 11:05 AM, shown in the message text, 1 comment".
 */
export function artifactLabel(artifact: Artifact, comments: number): string {
  const from = `from ${artifact.fromPerson ? 'you' : artifact.sender} at ${artifact.sentAt}`;
  if (artifact.type === 'guide') {
    const { guide } = artifact;
    return `Guided review: ${guide.title}, ${plural(guide.sections, 'section')}, ${plural(guide.files, 'file')}, ${formatCount(guide.additions)} lines added, ${formatCount(guide.deletions)} removed, ${from}`;
  }
  const { attachment } = artifact;
  const download = opensInWindow(attachment) ? '' : 'Download ';
  const changed = artifactChanged(attachment);
  return [
    `${download}${attachment.name}`,
    artifactDetail(artifact),
    from,
    artifact.inline ? 'shown in the message text' : null,
    changed ? changed.long : null,
    comments > 0 ? plural(comments, 'comment') : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** A tile's preview loads once it comes this near the screen... */
const LOAD_MARGIN = '300px 0px';
/** ...and unloads (an HTML frame, a video, an image, a drawn diagram) once it is this far away. */
const UNLOAD_MARGIN = '2000px 0px';

/**
 * Whether a tile is on screen or near it: its preview is drawn then, never
 * for the whole grid at once, and dropped again once the tile is far off
 * screen, so a long thread never keeps every page frame and video alive.
 */
function useNear<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const load = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin: LOAD_MARGIN });
    const unload = new IntersectionObserver((entries) => {
      if (entries.every((e) => !e.isIntersecting)) setNear(false);
    }, { rootMargin: UNLOAD_MARGIN });
    load.observe(el);
    unload.observe(el);
    return () => {
      load.disconnect();
      unload.disconnect();
    };
  }, []);
  return [ref, near];
}

/** Text previews are read up to this size; a larger file keeps its typed face. */
const PREVIEW_MAX_BYTES = 256 * 1024;
/** How many text previews the window keeps (the newest used; at most 256 KB each). */
const PREVIEW_CACHE_MAX = 48;
/** Reads kept by file version: the grid opens, closes and scrolls back without reading again. */
const previewCache = new Map<string, Promise<{ text: string; html: string | null }>>();

function previewOf(source: InboxFileSource, attachment: InboxAttachmentState): Promise<{ text: string; html: string | null }> {
  const version = readableVersion(attachment);
  const key = `${attachment.id}:${version}:${version === 'current' ? (attachment.current?.sha256 ?? '') : attachment.sent_sha256}`;
  let cached = previewCache.get(key);
  if (cached) {
    // The most recently used stays: move it to the end.
    previewCache.delete(key);
    previewCache.set(key, cached);
    return cached;
  }
  cached = source.view(attachment, version).then((view) => ({ text: view.text, html: view.html ?? null }));
  // A failed read is not kept: the next time the grid shows it, it reads again.
  cached.catch(() => previewCache.delete(key));
  previewCache.set(key, cached);
  while (previewCache.size > PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value!);
  return cached;
}

/** A short type mark ("SQL", "MD", "PDF"): the extension, else the kind. */
function typeMark(attachment: Pick<InboxAttachmentState, 'name' | 'kind'>): string {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(attachment.name)?.[1];
  return (ext ?? readInboxAttachmentKind(attachment.kind)).toUpperCase().slice(0, 5);
}

function typedIcon(kind: InboxAttachmentKind): IconName {
  if (kind === 'video') return 'film';
  if (kind === 'image') return 'photo';
  if (kind === 'file') return 'cube';
  return 'doc';
}

/** The first lines of a text file, as a document's face reads them: headings bold, nothing rendered. */
function TextLines({ text, code }: { text: string; code: boolean }) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).slice(0, 14).map((line) => (line.length > 160 ? `${line.slice(0, 160)}…` : line));
  if (code) return <code className="ib-art-code">{lines.join('\n')}</code>;
  return (
    <span className="ib-art-page">
      {lines
        .filter((line, i) => line.trim() !== '' || i === 0)
        .map((line, i) => {
          const heading = /^#{1,6}\s+(.*)$/.exec(line);
          return heading ? (
            <b key={i} dir="auto">
              {heading[1]}
            </b>
          ) : (
            <i key={i} dir="auto">
              {line.replace(/^\s*[-*+]\s+/, '· ')}
            </i>
          );
        })}
    </span>
  );
}

/** An HTML page drawn small: its own markup in a frame that runs no script and takes no pointer or focus. */
function PageFrame({ html }: { html: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(0.2);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setScale(width / PAGE_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={box} className="ib-art-frame" aria-hidden="true" inert>
      <iframe title="" srcDoc={prependSrcdocPolicy(html, attachmentFramePolicy())} sandbox="" tabIndex={-1} loading="lazy" style={{ transform: `scale(${scale})` }} />
    </span>
  );
}
const PAGE_WIDTH = 1024;

/** The face of a file: what it is, at a glance. */
function FileFace({ artifact, near }: { artifact: FileArtifact; near: boolean }) {
  const { attachment } = artifact;
  const source = useInboxFileSource();
  const kind = readInboxAttachmentKind(attachment.kind);
  const version = readableVersion(attachment);
  const [preview, setPreview] = useState<{ text: string; html: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const wantsText = kind === 'markdown' || kind === 'text' || kind === 'code' || kind === 'html' || kind === 'mermaid' || kind === 'graphviz';
  const small = (attachment.current?.size ?? attachment.size) <= PREVIEW_MAX_BYTES;
  useEffect(() => {
    // Far off screen: the drawn preview goes (a page frame, a diagram); the read stays cached.
    if (!near) {
      setPreview(null);
      return;
    }
    if (!wantsText || !small || attachment.unavailable?.code === 'attachment_changed_type') return;
    let cancelled = false;
    previewOf(source, attachment).then(
      (next) => !cancelled && setPreview(next),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [near, wantsText, small, attachment]);
  const typed = (
    <span className="ib-art-typed">
      <Icon name={typedIcon(kind)} size={26} />
      <span>{typeMark(attachment)}</span>
    </span>
  );
  if (kind === 'image') {
    return (
      <span className="ib-art-prev ib-art-f-img" data-face="image">
        {near && !failed ? <img src={source.imageUrl(attachment, version)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} /> : typed}
      </span>
    );
  }
  if (kind === 'video') {
    return (
      <span className="ib-art-prev ib-art-f-img" data-face="video">
        {near && !failed ? (
          <video src={`${source.videoUrl(attachment, version)}#t=0.001`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true" onError={() => setFailed(true)} />
        ) : (
          typed
        )}
        <span className="ib-art-play" aria-hidden="true">
          <Icon name="play" size={16} />
        </span>
        {attachment.duration_ms ? <span className="ib-art-dur">{formatInboxVideoTime(attachment.duration_ms / 1000)}</span> : null}
      </span>
    );
  }
  if (kind === 'html') {
    return (
      <span className="ib-art-prev ib-art-f-page" data-face="html">
        {preview?.html ? <PageFrame html={preview.html} /> : typed}
        <span className="ib-art-ext">HTML</span>
      </span>
    );
  }
  if (kind === 'mermaid' || kind === 'graphviz') {
    return (
      <span className="ib-art-prev ib-art-f-diagram" data-face="diagram">
        {preview ? <ArtifactDiagramFace kind={kind} source={preview.text} fallback={typed} /> : typed}
        <span className="ib-art-ext">{typeMark(attachment)}</span>
      </span>
    );
  }
  if (kind === 'markdown' || kind === 'text' || kind === 'code') {
    return (
      <span className={`ib-art-prev ${kind === 'code' ? 'ib-art-f-code' : 'ib-art-f-doc'}`} data-face={kind === 'code' ? 'code' : 'text'}>
        {preview ? <TextLines text={preview.text} code={kind === 'code'} /> : typed}
        <span className="ib-art-ext">{typeMark(attachment)}</span>
      </span>
    );
  }
  // A PDF, any other file: a typed face.
  return (
    <span className="ib-art-prev ib-art-f-typed" data-face="typed">
      {typed}
    </span>
  );
}

function GuideFace({ artifact }: { artifact: GuideArtifact }) {
  const { guide } = artifact;
  return (
    <span className="ib-art-prev ib-art-f-guide" data-face="guide">
      <span className="ib-art-g-ic">
        <Icon name="book" size={20} />
      </span>
      <span className="ib-art-g-t">Guided review</span>
      <span className="ib-art-g-bars" aria-hidden="true">
        <s style={{ width: '72%' }} />
        <s style={{ width: '48%' }} />
        <s style={{ width: '86%' }} />
      </span>
      <span className="ib-art-g-n">
        <span className="ib-add">+{formatCount(guide.additions)}</span> <span className="ib-del">-{formatCount(guide.deletions)}</span>
      </span>
    </span>
  );
}

function Tile({
  artifact,
  comments,
  current,
  openIn,
  onOpen,
  onOpenGuide,
  onOpenAs,
}: {
  artifact: Artifact;
  comments: number;
  current: boolean;
  openIn?: OpenInSurface;
  onOpen: (artifact: FileArtifact) => void;
  onOpenGuide: (artifact: GuideArtifact) => void;
  onOpenAs?: (artifact: FileArtifact, view: 'full' | 'side') => void;
}) {
  const [ref, near] = useNear<HTMLLIElement>();
  const source = useInboxFileSource();
  const key = artifactKey(artifact);
  const label = artifactLabel(artifact, comments);
  const changed = artifact.type === 'file' ? artifactChanged(artifact.attachment) : null;
  const downloads = artifact.type === 'file' && !opensInWindow(artifact.attachment);
  const name = artifact.type === 'file' ? artifact.attachment.name : artifact.guide.title;
  const body = (
    <>
      <span className="ib-art-stage" data-video={artifact.type === 'file' && readInboxAttachmentKind(artifact.attachment.kind) === 'video' ? '' : undefined}>
        {artifact.type === 'file' ? <FileFace artifact={artifact} near={near} /> : <GuideFace artifact={artifact} />}
        {changed && <span className="ib-art-chg">{changed.short}</span>}
        {comments > 0 && (
          <span className="ib-art-cmt">
            <Icon name="comment" size={12} />
            {formatCount(comments)}
          </span>
        )}
      </span>
      <span className="ib-art-cap">
        {artifact.type === 'file' ? (
          <FileName name={name} className="ib-art-nm" />
        ) : (
          <Tip content={name} cut>
            <span className="ib-art-nm" dir="auto">
              {name}
            </span>
          </Tip>
        )}
        <Tip content={artifactDetail(artifact)} cut>
          <span className="ib-art-kd">{artifactDetail(artifact)}</span>
        </Tip>
        <span className="ib-art-from">
          {artifact.fromPerson ? (
            <span className="ib-mk">
              <Icon name="reply" />
            </span>
          ) : (
            <HostMark host={artifact.host} />
          )}
          <Tip content={fullTime(artifact.at)}>
            <span className="ib-art-when">
              <span className="ib-art-who">{artifact.sender} · </span>
              {artifact.sentAt}
              {artifact.type === 'file' && artifact.inline ? ' · in text' : ''}
            </span>
          </Tip>
          {downloads && (
            <span className="ib-art-dl" aria-hidden="true">
              <Icon name="download" size={13} />
            </span>
          )}
        </span>
      </span>
    </>
  );
  const common = {
    className: `ib-art-tile${current ? ' ib-art-current' : ''}`,
    'aria-label': label,
    'aria-current': current ? ('true' as const) : undefined,
    'data-artifact-tile': key,
  };
  let tile: React.ReactElement;
  if (artifact.type === 'guide') {
    tile = (
      <button type="button" {...common} onClick={() => onOpenGuide(artifact)} data-artifact-kind="guide">
        {body}
      </button>
    );
  } else if (downloads) {
    tile = (
      <a {...common} href={source.downloadUrl(artifact.attachment, readableVersion(artifact.attachment))} download={artifact.attachment.name} data-artifact-kind={readInboxAttachmentKind(artifact.attachment.kind)}>
        {body}
      </a>
    );
  } else {
    tile = (
      <button type="button" {...common} onClick={() => onOpen(artifact)} data-artifact-kind={readInboxAttachmentKind(artifact.attachment.kind)}>
        {body}
      </button>
    );
  }
  return (
    <li className="ib-art-cell" ref={ref}>
      <div className="ib-art-w">
        {tile}
        {/* The tile's ⋯ "Open in" is its sibling (a button in a button is invalid): the next tab stop after the tile. */}
        {artifact.type === 'file' && openIn === 'apps' && (
          <OpenInTileMenu
            attachment={artifact.attachment}
            version={readableVersion(artifact.attachment)}
            onOpenAs={onOpenAs && !downloads ? (view) => onOpenAs(artifact, view) : undefined}
          />
        )}
      </div>
    </li>
  );
}

export interface ArtifactsViewProps {
  /** The thread's artifacts in thread order (artifacts.ts), or null while the thread's files load. */
  artifacts: readonly Artifact[] | null;
  /** Annotations waiting for a Send, by file path: a tile's comment count. */
  annotationCounts: ReadonlyMap<string, number>;
  /** The file open beside the thread: its tile is ringed (`aria-current`). */
  openId: string | null;
  onOpen: (artifact: FileArtifact) => void;
  onOpenGuide: (artifact: GuideArtifact) => void;
  /** A tile's ⋯ "Open side by side" / "Open full screen" (absent on a phone or a stacked window). */
  onOpenAs?: (artifact: FileArtifact, view: 'full' | 'side') => void;
  /** "Back to the thread" (desktop; a phone's header has its own Back). */
  onBack?: () => void;
  openIn?: OpenInSurface;
  /** A phone: the header names the view, so the heading here is for a screen reader only. */
  phone?: boolean;
}

/** The grid itself, with its heading ("Artifacts") as the region's name and the focus target when it opens. */
export const ArtifactsView = forwardRef<HTMLHeadingElement, ArtifactsViewProps>(function ArtifactsView(
  { artifacts, annotationCounts, openId, onOpen, onOpenGuide, onOpenAs, onBack, openIn, phone = false },
  headingRef,
) {
  const ordered = artifacts ? artifactsNewestFirst(artifacts) : [];
  const count = ordered.length;
  // The open file's tile stays in sight beside it (a step, a reload with a file open).
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (openId === null) return;
    section.current?.querySelector<HTMLElement>('.ib-art-current')?.scrollIntoView?.({ block: 'nearest' });
  }, [openId, count]);
  return (
    <section ref={section} className="ib-art" aria-labelledby="ib-art-h" data-artifacts-view="">
      <div className="ib-art-top">
        {onBack && (
          <button type="button" className="ib-art-back" onClick={onBack} data-artifacts-back="">
            <Icon name="chevL" size={15} />
            <span>Back to the thread</span>
          </button>
        )}
        <h2 id="ib-art-h" ref={headingRef} className={phone ? 'ib-sr' : 'ib-art-h'} tabIndex={-1}>
          Artifacts
        </h2>
        {artifacts !== null && count > 0 && (
          <span className="ib-art-sum" data-artifacts-summary="">
            {count === 1 ? '1 artifact' : `${formatCount(count)} from ${plural(artifactMessageCount(ordered), 'message')}`}
            {count > 1 ? ' · newest first' : ''}
          </span>
        )}
      </div>
      {artifacts === null ? (
        <p className="ib-art-load" aria-busy="true">
          Loading the artifacts…
        </p>
      ) : count === 0 ? (
        <div className="ib-art-empty" data-artifacts-empty="">
          <span className="ib-art-empty-ic">
            <Icon name="artifacts" size={28} />
          </span>
          <b>No artifacts in this thread yet</b>
          <span>Files, images and guided reviews an agent sends, and files you paste into a reply, show here.</span>
        </div>
      ) : (
        <ul className="ib-art-grid" aria-label={plural(count, 'artifact')}>
          {ordered.map((artifact) => {
            const current =
              openId !== null && artifact.type === 'file' && (artifact.attachment.id === openId || artifact.alsoIds.includes(openId));
            return (
              <Tile
                key={artifactKey(artifact)}
                artifact={artifact}
                comments={artifact.type === 'file' ? (annotationCounts.get(artifact.attachment.path) ?? 0) : 0}
                current={current}
                openIn={phone ? undefined : openIn}
                onOpen={onOpen}
                onOpenGuide={onOpenGuide}
                onOpenAs={onOpenAs}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
});
