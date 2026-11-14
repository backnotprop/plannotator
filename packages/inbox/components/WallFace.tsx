/**
 * A picture of one artifact on the Artifacts wall (ArtifactsWall.tsx; the owner's round 2: "the height needs to be
 * figured out where they're the same height", and documents should look like documents). Every face fills one 4:3
 * stage on a quiet backdrop; what it draws is fitted whole and centred, never cropped mid-content:
 *
 * - a picture or a video: the whole frame, contained;
 * - an HTML page: the page drawn small on a landscape sheet (a frame that runs no script);
 * - a diagram: drawn small on a landscape sheet;
 * - Markdown and text: a small rendered page (the title in heading type, a few lines of body);
 * - a PDF: a page card with its name and page count (the Inbox has no PDF renderer, and adds none);
 * - code: a few highlighted lines on the code background;
 * - CSV: a small table;
 * - a guided review: its own face on a sheet;
 * - any other file: a file card with its type.
 *
 * The name and the type sit under the stage, the same way for every kind (`wallTypeLabel`, wallFaceText.ts).
 */

import { useEffect, useState } from 'react';
import { getFiletypeFromFileName } from '@pierre/diffs';
import { ensureHighlight, highlightToHtml } from '@plannotator/ui/utils/codeHighlight';
import { useFenceTheme } from '@plannotator/ui/hooks/useFenceTheme';
import { formatInboxVideoTime, readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { InboxArtifactRow } from '@plannotator/core/inbox-artifact-pins';
import { readableVersion } from '../attachments';
import { useInboxFileSource } from '../fileSource';
import { plural } from '../format';
import { documentBlocks, extOf, isTable, pdfPageCount, tableRows } from '../wallFaceText';
import { Icon } from '../icons';
import { ArtifactDiagramFace } from './ArtifactDiagramFace';
import { GuideFace, PageFrame, previewOf, typeMark, typedIcon } from './ArtifactsView';
import type { GuideArtifact } from '../artifacts';

/** Text previews are read up to this size; a larger file keeps its card. */
const TEXT_MAX = 256 * 1024;
/** A PDF's pages are counted from its bytes up to this size. */
const PDF_COUNT_MAX = 4 * 1024 * 1024;

/** The file's first lines, read once the tile is near (shared with the thread grid's cache). */
function useText(attachment: InboxAttachmentState | null, near: boolean, wanted: boolean): { text: string; html: string | null } | null {
  const source = useInboxFileSource();
  const [preview, setPreview] = useState<{ text: string; html: string | null } | null>(null);
  const small = !!attachment && (attachment.current?.size ?? attachment.size) <= TEXT_MAX;
  useEffect(() => {
    if (!attachment || !near || !wanted || !small || attachment.unavailable?.code === 'attachment_changed_type') return;
    let cancelled = false;
    previewOf(source, attachment).then(
      (next) => !cancelled && setPreview(next),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [near, wanted, small, attachment, source]);
  return preview;
}

const pageCounts = new Map<string, Promise<number | null>>();

/** The PDF's page count, read once the tile is near (PDFs up to 4 MB); null until then, or when it cannot be told. */
export function usePdfPages(attachment: InboxAttachmentState | null, near: boolean): number | null {
  const source = useInboxFileSource();
  const [pages, setPages] = useState<number | null>(null);
  useEffect(() => {
    if (!attachment || !near || readInboxAttachmentKind(attachment.kind) !== 'pdf') return;
    if ((attachment.current?.size ?? attachment.size) > PDF_COUNT_MAX) return;
    const version = readableVersion(attachment);
    const key = `${attachment.id}:${version}:${attachment.current?.sha256 ?? attachment.sent_sha256}`;
    let read = pageCounts.get(key);
    if (!read) {
      read = fetch(source.downloadUrl(attachment, version), { cache: 'force-cache' })
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .then((buffer) => (buffer ? pdfPageCount(new TextDecoder('latin1').decode(buffer)) : null))
        .catch(() => null);
      pageCounts.set(key, read);
    }
    let cancelled = false;
    void read.then((n) => !cancelled && setPages(n));
    return () => {
      cancelled = true;
    };
  }, [attachment, near, source]);
  return pages;
}

function FileCard({ attachment }: { attachment: InboxAttachmentState }) {
  return (
    <span className="ib-wf-file" data-face="file">
      <span className="ib-wf-file-ic">
        <Icon name={typedIcon(readInboxAttachmentKind(attachment.kind))} size={22} />
      </span>
      <span className="ib-wf-file-ext">{typeMark(attachment)}</span>
    </span>
  );
}

function DocumentPage({ text, markdown, name }: { text: string; markdown: boolean; name: string }) {
  const blocks = documentBlocks(text, markdown);
  const titled = blocks[0]?.kind === 'h1';
  return (
    <span className="ib-wf-paper" data-face="document">
      <span className="ib-wf-paper-in">
        {!titled && markdown && <b className="ib-wf-h1">{name.replace(/\.[^.]+$/, '')}</b>}
        {blocks.map((block, i) =>
          block.kind === 'h1' ? (
            <b key={i} className="ib-wf-h1" dir="auto">
              {block.text}
            </b>
          ) : block.kind === 'h2' ? (
            <b key={i} className="ib-wf-h2" dir="auto">
              {block.text}
            </b>
          ) : (
            <span key={i} className={block.kind === 'li' ? 'ib-wf-li' : markdown ? 'ib-wf-p' : 'ib-wf-p ib-wf-plain'} dir="auto">
              {block.text}
            </span>
          ),
        )}
      </span>
    </span>
  );
}

function PdfPage({ name, pages }: { name: string; pages: number | null }) {
  return (
    <span className="ib-wf-paper ib-wf-pdf" data-face="pdf">
      <span className="ib-wf-paper-in">
        <span className="ib-wf-pdf-mark">
          <Icon name="doc" size={14} />
          PDF
        </span>
        <b className="ib-wf-pdf-name" dir="auto">
          {name.replace(/\.pdf$/i, '')}
        </b>
        {pages !== null && <span className="ib-wf-pdf-pages">{plural(pages, 'page')}</span>}
      </span>
    </span>
  );
}

function CodeLines({ text, name }: { text: string; name: string }) {
  const theme = useFenceTheme();
  const shown = text.replace(/^﻿/, '').split(/\r?\n/).slice(0, 14).map((line) => (line.length > 120 ? line.slice(0, 120) : line)).join('\n');
  const lang = getFiletypeFromFileName(name);
  const [html, setHtml] = useState<string | null>(() => (lang ? highlightToHtml(shown, lang, theme) : null));
  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    void ensureHighlight(lang, theme).then((ok) => {
      if (!cancelled && ok) setHtml(highlightToHtml(shown, lang, theme));
    });
    return () => {
      cancelled = true;
    };
  }, [shown, lang, theme]);
  return (
    <span className="ib-wf-code" data-face="code">
      {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{shown}</code>}
    </span>
  );
}

function TableSheet({ text, tab }: { text: string; tab: boolean }) {
  const rows = tableRows(text, tab);
  const numeric = (cell: string) => /^[-+$€£]?\d[\d,.\s]*%?$/.test(cell);
  return (
    <span className="ib-wf-sheet ib-wf-table" data-face="table">
      <span className="ib-wf-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, rows[0]?.length ?? 1)}, minmax(0, 1fr))` }}>
        {rows.flatMap((row, r) =>
          row.map((cell, c) => (
            <span key={`${r}-${c}`} className={`ib-wf-cell${r === 0 ? ' ib-wf-th' : ''}${r > 0 && numeric(cell) ? ' ib-wf-num' : ''}`} dir="auto">
              {cell}
            </span>
          )),
        )}
      </span>
    </span>
  );
}

/** The face of one Wall artifact, inside its 4:3 stage. */
export function WallFace({ row, near, guide, pages }: { row: InboxArtifactRow; near: boolean; guide: GuideArtifact | null; pages: number | null }) {
  const source = useInboxFileSource();
  const attachment = row.attachment;
  const kind = attachment ? readInboxAttachmentKind(attachment.kind) : null;
  const wantsText = kind === 'markdown' || kind === 'text' || kind === 'code' || kind === 'html' || kind === 'mermaid' || kind === 'graphviz';
  const preview = useText(attachment, near, wantsText);
  const [failed, setFailed] = useState(false);
  if (!attachment || !kind) {
    return (
      <span className="ib-wf-sheet ib-wf-guide" data-face="guide">
        {guide && <GuideFace artifact={guide} />}
      </span>
    );
  }
  const version = readableVersion(attachment);
  if ((kind === 'image' || kind === 'video') && !failed) {
    return (
      <span className="ib-wf-fit" data-face={kind}>
        {near &&
          (kind === 'image' ? (
            <img src={source.imageUrl(attachment, version)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
          ) : (
            <video src={`${source.videoUrl(attachment, version)}#t=0.001`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true" onError={() => setFailed(true)} />
          ))}
        {kind === 'video' && (
          <span className="ib-wf-play" aria-hidden="true">
            <Icon name="play" size={14} />
            {attachment.duration_ms ? formatInboxVideoTime(attachment.duration_ms / 1000) : null}
          </span>
        )}
      </span>
    );
  }
  if (kind === 'audio') {
    // A recording: its note and type, and the play mark with its length (as a film's).
    return (
      <>
        <FileCard attachment={attachment} />
        <span className="ib-wf-play" aria-hidden="true" data-face-audio="">
          <Icon name="play" size={14} />
          {attachment.duration_ms ? formatInboxVideoTime(attachment.duration_ms / 1000) : null}
        </span>
      </>
    );
  }
  if (kind === 'html' && preview?.html) {
    return (
      <span className="ib-wf-sheet ib-wf-page" data-face="html">
        <PageFrame html={preview.html} />
      </span>
    );
  }
  if ((kind === 'mermaid' || kind === 'graphviz') && preview) {
    return (
      <span className="ib-wf-sheet ib-wf-diagram" data-face="diagram">
        <ArtifactDiagramFace kind={kind} source={preview.text} fallback={<FileCard attachment={attachment} />} />
      </span>
    );
  }
  if (kind === 'markdown' && preview) return <DocumentPage text={preview.text} markdown name={attachment.name} />;
  if (kind === 'text' && preview) return isTable(attachment.name) ? <TableSheet text={preview.text} tab={extOf(attachment.name) === 'tsv'} /> : <DocumentPage text={preview.text} markdown={false} name={attachment.name} />;
  if (kind === 'code' && preview) return <CodeLines text={preview.text} name={attachment.name} />;
  if (kind === 'pdf') return <PdfPage name={attachment.name} pages={pages} />;
  return <FileCard attachment={attachment} />;
}
