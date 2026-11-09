import { useState } from 'react';
import { ShortcutHint, useShortcutAria } from '../shortcuts/hint';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import { inboxAttachmentKindLabel, inboxVideoMeta, isInboxAnnotatableKind, readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { imageFitsWithin, readableVersion, WIDE_IMAGE_RATIO } from '../attachments';
import { useInboxFileSource } from '../fileSource';
import { drawnImageUrl, GALLERY_IMAGE_WIDTH, TILE_IMAGE_WIDTH } from '../images';
import { formatBytes, plural, shortTime, whenTime } from '../format';
import { Icon, type IconName } from '../icons';
import { FileName } from './FileName';
import { TileMenu, type OpenInSurface } from './OpenIn';
import { Tip } from './Tip';
import { ReuseButton, useReuse } from '../reuse';

/** The icon a tile (and the stepper's list) shows for a file of this kind. */
export function iconOf(attachment: InboxAttachmentState): IconName {
  switch (readInboxAttachmentKind(attachment.kind)) {
    case 'html':
    case 'code':
      return 'code';
    case 'mermaid':
    case 'graphviz':
      return 'diagram';
    case 'image':
      return 'photo';
    case 'video':
      return 'film';
    case 'file':
      return 'cube';
    default:
      return 'doc';
  }
}

/** "1280 × 800, 79 KB" for an image; "MP4 video · 7:41 · 1920 × 1080 · 461 MB" for a video; "PDF, 2.3 MB" otherwise. */
/** The line under a file's name as two parts: words, then its separator and size. A narrow tile cuts only the words. */
function sizeParts(attachment: InboxAttachmentState): { words: string; size: string } {
  const size = formatBytes(attachment.current?.size ?? attachment.size);
  const kind = readInboxAttachmentKind(attachment.kind);
  if (kind === 'video') {
    return { words: [inboxAttachmentKindLabel(attachment.kind, attachment.name, attachment.media_type), inboxVideoMeta(attachment)].filter(Boolean).join(' · '), size: ` · ${size}` };
  }
  if (kind === 'image' && attachment.width && attachment.height) return { words: `${attachment.width} × ${attachment.height}`, size: `, ${size}` };
  return { words: inboxAttachmentKindLabel(attachment.kind, attachment.name, attachment.media_type), size: `, ${size}` };
}

export function sizeLine(attachment: InboxAttachmentState): string {
  const { words, size } = sizeParts(attachment);
  return `${words}${size}`;
}

/** The changed line a tile or caption shows, or null when the file on disk is what was sent. */
export function changedLine(attachment: InboxAttachmentState, short = false): string | null {
  if (attachment.unavailable) {
    if (short) return attachment.unavailable.code === 'attachment_missing' ? 'No longer on disk' : 'Changed type';
    return attachment.unavailable.code === 'attachment_missing' ? 'No longer on disk; the sent version opens' : 'Changed type; the sent version opens';
  }
  if (attachment.changed_since_sent && attachment.current) {
    // Short (a tile, a caption, the step list): the time today, else the day, so the count beside it keeps its room.
    if (short) return `Changed ${shortTime(attachment.current.mtime)}`;
    return `${attachment.captured === 'on_open' ? 'Changed since you first opened it' : 'Changed since it was sent'}, edited ${whenTime(attachment.current.mtime)}`;
  }
  return null;
}

/** Whether the window opens this attachment in its pane (every viewer kind), or offers it as a download (a PDF, any other file, and a kind it does not know). */
export function opensInWindow(attachment: Pick<InboxAttachmentState, 'kind'>): boolean {
  return isInboxAnnotatableKind(attachment.kind);
}

/**
 * The images of a message, shown in it like an email's: one justified row,
 * each image as wide as its shape asks, at most 240 px tall; a tall
 * screenshot shows its top, cropped with a fade. The frame and its caption
 * are one button that opens the image beside the thread. Images load only
 * from the attachment's own route (`<img src>`, so an SVG never runs). A
 * right-click on one opens its tile's menu (TileMenu: Download, Copy image,
 * the rest of the tile's list); it has no ⋯ of its own.
 */
export function ImageGallery({
  images,
  annotationCounts,
  onOpen,
  openIn,
  onOpenAs,
}: {
  images: readonly InboxAttachmentState[];
  annotationCounts: ReadonlyMap<string, number>;
  onOpen: (attachment: InboxAttachmentState) => void;
  /** Where the window is, for the menu's Open in list (as the tiles'). */
  openIn?: OpenInSurface;
  onOpenAs?: (attachment: InboxAttachmentState, view: 'full' | 'side') => void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="ib-gallery" data-image-gallery="">
      {images.map((image) => (
        <GalleryImage key={image.id} image={image} count={annotationCounts.get(image.path) ?? 0} onOpen={onOpen} openIn={openIn} onOpenAs={onOpenAs} />
      ))}
    </div>
  );
}

/** Tall images are cropped to this width-to-height ratio in the row. */
const TALL_RATIO = 0.62;

function GalleryImage({
  image,
  count,
  onOpen,
  openIn,
  onOpenAs,
}: {
  image: InboxAttachmentState;
  count: number;
  onOpen: (attachment: InboxAttachmentState) => void;
  openIn?: OpenInSurface;
  onOpenAs?: (attachment: InboxAttachmentState, view: 'full' | 'side') => void;
}) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const width = natural?.width ?? image.width ?? 4;
  const height = natural?.height ?? image.height ?? 3;
  const ratio = width / height;
  const shown = Math.min(Math.max(ratio, TALL_RATIO), WIDE_IMAGE_RATIO);
  const tall = ratio < TALL_RATIO;
  const wide = ratio > WIDE_IMAGE_RATIO;
  const source = useInboxFileSource();
  const src = source.imageUrl(image, readableVersion(image));
  // A frame is at most a few hundred pixels wide: a big screenshot loads as a smaller copy (images.ts).
  const shownSrc = drawnImageUrl(src, image.width, GALLERY_IMAGE_WIDTH);
  const changed = changedLine(image, true);
  // A changed image keeps its comment count beside the changed line.
  const detail = `${changed ?? sizeLine(image)}${count > 0 ? `, ${plural(count, 'comment')}` : ''}`;
  const label = `View ${image.name}, ${inboxAttachmentKindLabel(image.kind, image.name, image.media_type)}${changed ? `, ${changed.toLowerCase()}` : ''}${count > 0 ? `, ${plural(count, 'comment')}` : ''}`;
  const frame = { flex: `${shown} 1 ${Math.round(shown * 160)}px`, maxWidth: `min(100%, ${Math.round(shown * 230)}px)` };
  const item = (
    <button
      type="button"
      className="ib-gal-item"
      onClick={() => onOpen(image)}
      aria-label={label}
      data-gallery-image={image.id}
      data-attachment-name={image.name}
    >
      <span className={`ib-gal-frame${tall ? ' ib-tall' : ''}${wide ? ' ib-wide' : ''}`} style={{ aspectRatio: String(shown) }} data-src={shownSrc}>
        {failed ? (
          <span className="ib-gal-fail">
            <Icon name="photo" size={20} />
            This image could not be shown
          </span>
        ) : (
          <img
            src={shownSrc}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={(event) => {
              const img = event.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0) setNatural({ width: img.naturalWidth, height: img.naturalHeight });
            }}
            onError={() => setFailed(true)}
          />
        )}
        {count > 0 && <span className="ib-gal-count">{count}</span>}
      </span>
      <span className="ib-gal-cap">
        <FileName name={image.name} className="ib-nm" />
        <span className={changed ? 'ib-ch' : 'ib-kd'}>{detail}</span>
      </span>
    </button>
  );
  // The add-to-reply button is the frame's sibling (a button in a button is invalid); the wrapper takes the frame's size.
  return (
    <TileMenu
      attachment={image}
      surface={openIn}
      onOpenAs={onOpenAs ? (view) => onOpenAs(image, view) : undefined}
      render={(_more, status) => (
        <div className={`ib-gal-w${count > 0 ? ' ib-gal-w-count' : ''}`} style={frame}>
          {item}
          <ReuseButton file={image} surface="gallery" />
          {status}
        </div>
      )}
    />
  );
}

/**
 * The files at the foot of a message (record 2.1): an image gallery first,
 * then a tile per file. A tile that opens in the window (documents, code,
 * images with their thumbnail) is one button; a PDF, any other file and a
 * kind this window does not know is one Download link. The changed line
 * replaces the kind when the file on disk is no longer what was sent.
 *
 * `placement="header"` is the same tiles a second time, in the band the
 * message header's count opens (design record "inbox-attachments-header",
 * variant Count): no heading and no gallery, only the tiles.
 */
export function AttachmentTiles({
  attachments,
  annotationCounts,
  onOpen,
  openId = null,
  placement = 'foot',
  openIn,
  onOpenAs,
  newestId = null,
}: {
  attachments: readonly InboxAttachmentState[];
  annotationCounts: ReadonlyMap<string, number>;
  onOpen: (attachment: InboxAttachmentState) => void;
  /** The file open beside the thread: its tile says "Open beside" (`aria-current`); the thread does not scroll to it. */
  openId?: string | null;
  /** Where the tiles sit: at the foot of the message (with their heading and the image gallery), or in the header's band. */
  placement?: 'foot' | 'header';
  /** "Open in" on this computer (`apps`): each tile gets a ⋯ menu beside its button. Otherwise none. */
  openIn?: OpenInSurface;
  /** The tile ⋯'s "Open side by side" / "Open full screen": this file in that view, the remembered choice unchanged. Absent on a phone or a stacked window. */
  onOpenAs?: (attachment: InboxAttachmentState, view: 'full' | 'side') => void;
  /** The file `O` opens (artifacts.ts `newestViewableFile`): its tile shows the O keycap and names the key. */
  newestId?: string | null;
}) {
  const newestKeys = useShortcutAria({ scope: inboxThreadShortcuts, action: 'openNewest' });
  const source = useInboxFileSource();
  const reuse = useReuse();
  if (attachments.length === 0) return null;
  const header = placement === 'header';
  const images = header ? [] : attachments.filter((a) => readInboxAttachmentKind(a.kind) === 'image');
  return (
    <div className={header ? 'ib-attachments ib-hatts-tiles' : 'ib-attachments'}>
      {!header && (
        <div className="ib-attach-h">
          <Icon name="clip" size={13} />
          {plural(attachments.length, 'attachment')}
        </div>
      )}
      <ImageGallery images={images} annotationCounts={annotationCounts} onOpen={onOpen} openIn={openIn} onOpenAs={onOpenAs} />
      <div className="ib-atts ib-tiles">
        {attachments.map((attachment) => {
          const count = annotationCounts.get(attachment.path) ?? 0;
          // The tile says it short ("Changed 6:43 PM"), on one line, and keeps
          // the annotation count beside it; the whole sentence is its hover
          // text and what a screen reader hears.
          const changed = changedLine(attachment, true);
          const changedLong = changedLine(attachment);
          const isImage = readInboxAttachmentKind(attachment.kind) === 'image';
          const isVideo = readInboxAttachmentKind(attachment.kind) === 'video';
          // A video's caption keeps one separator throughout: "WebM video · 81.8 KB · 2 comments".
          const counted = count > 0 ? (isVideo ? ` · ${plural(count, 'comment')}` : `, ${plural(count, 'annotation')}`) : '';
          const detail = `${changed ?? sizeLine(attachment)}${counted}`;
          const detailLong = `${changedLong ?? sizeLine(attachment)}${counted}`;
          // The header's band shows the same tiles while the foot's are on the page: ids stay unique.
          const detailId = `ib-${header ? 'hatt' : 'att'}-detail-${attachment.id}`;
          const icon = isImage ? (
            <span className="ib-fi ib-thumb">
              <img src={drawnImageUrl(source.imageUrl(attachment, readableVersion(attachment)), attachment.width, TILE_IMAGE_WIDTH)} alt="" loading="lazy" decoding="async" draggable={false} data-small={imageFitsWithin(attachment, 30) ? '' : undefined} />
            </span>
          ) : (
            <span className="ib-fi">
              <Icon name={iconOf(attachment)} size={16} />
            </span>
          );
          const text = (
            <span className="ib-att-text">
              <FileName name={attachment.name} className="ib-nm" />
              {changed ? (
                <Tip content={detailLong}>
                  <span className="ib-ch">
                    <span aria-hidden="true">{detail}</span>
                    <span className="ib-sr" id={detailId}>
                      {detailLong}
                    </span>
                  </span>
                </Tip>
              ) : (
                <span className="ib-kd ib-kd-split" id={detailId}>
                  <span className="ib-kd-w">{sizeParts(attachment).words}</span>
                  <span className="ib-kd-n">{sizeParts(attachment).size}</span>
                  {counted ? <span className="ib-kd-c">{counted}</span> : null}
                </span>
              )}
            </span>
          );
          // The ⋯ is the tile button's sibling (a button inside a button is invalid), in a wrapper the grid lays out.
          // A right-click anywhere on the tile opens the ⋯'s list (Download in it), with or without the ⋯ (TileMenu).
          const withMenu = (tile: React.ReactElement) => (
            <TileMenu
              key={attachment.id}
              attachment={attachment}
              surface={openIn}
              onOpenAs={onOpenAs && opensInWindow(attachment) ? (view) => onOpenAs(attachment, view) : undefined}
              render={(more, status) =>
                more || reuse ? (
                  <div className={`ib-att-w${reuse ? ' ib-att-w-reuse' : ''}${more ? ' ib-att-w-more' : ''}`} data-open-in-tile={more ? attachment.id : undefined}>
                    {tile}
                    <ReuseButton file={attachment} surface="tile" />
                    {more}
                    {status}
                  </div>
                ) : (
                  tile
                )
              }
            />
          );
          if (!opensInWindow(attachment)) {
            // A download: the whole tile is the link, never a viewer on this origin.
            return withMenu(
              <a
                className="ib-att-t ib-dl"
                key={attachment.id}
                href={source.downloadUrl(attachment, readableVersion(attachment))}
                download={attachment.name}
                aria-label={`Download ${attachment.name}`}
                aria-describedby={detailId}
                data-attachment-id={attachment.id}
                data-attachment-name={attachment.name}
                data-attachment-kind={readInboxAttachmentKind(attachment.kind)}
              >
                {icon}
                {text}
                <span className="ib-open" aria-hidden="true">
                  Download
                </span>
              </a>,
            );
          }
          // The whole tile is the one control (record 2.1): a click on the
          // icon, the name or the type line opens the file exactly as Open
          // does. "Open" stays as the visual cue inside it.
          const isOpen = attachment.id === openId;
          return withMenu(
            <button
              type="button"
              className={`ib-att-t${isOpen ? ' ib-open-beside' : ''}`}
              key={attachment.id}
              onClick={() => onOpen(attachment)}
              aria-label={isOpen ? `${attachment.name}, open beside the thread` : `${isVideo ? 'Play' : 'Open'} ${attachment.name}`}
              aria-current={isOpen ? 'true' : undefined}
              aria-describedby={detailId}
              aria-keyshortcuts={attachment.id === newestId ? newestKeys : undefined}
              data-attachment-id={attachment.id}
              data-attachment-name={attachment.name}
              data-attachment-kind={readInboxAttachmentKind(attachment.kind)}
            >
              {icon}
              {text}
              {attachment.id === newestId && <ShortcutHint scope={inboxThreadShortcuts} action="openNewest" className="ib-kbd ib-att-kbd" />}
              <span className="ib-open" aria-hidden="true">
                {isOpen ? 'Open beside' : isVideo ? 'Play' : 'Open'}
              </span>
            </button>,
          );
        })}
      </div>
    </div>
  );
}

/** How many of these files changed since they were sent: the same truth as the tiles' changed line. */
export function changedCount(attachments: readonly InboxAttachmentState[]): number {
  return attachments.filter((attachment) => changedLine(attachment) !== null).length;
}

/**
 * The count in an agent message's "to you" line (design record
 * "inbox-attachments-header", variant Count, approved 2026-10-11): a quiet
 * disclosure, `3 attachments · 1 changed ⌄`, that opens the band of tiles
 * under the sender row. "· N changed" only when a file changed since it was
 * sent.
 */
export function AttachmentsCount({
  messageId,
  count,
  changed,
  open,
  controls,
  onToggle,
  onKeyDown,
}: {
  messageId: string;
  count: number;
  changed: number;
  open: boolean;
  /** The band's id (`aria-controls`). */
  controls: string;
  onToggle: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  return (
    <>
      <span className="ib-to-sep" aria-hidden="true">
        ·
      </span>
      <button
        type="button"
        className="ib-hcount"
        data-header-files={messageId}
        aria-expanded={open}
        aria-controls={controls}
        aria-label={`${plural(count, 'attachment')}${changed > 0 ? `, ${changed} changed` : ''}`}
        onClick={onToggle}
        onKeyDown={onKeyDown}
      >
        <Icon name="clip" size={13} />
        <span>{plural(count, 'attachment')}</span>
        {changed > 0 && (
          <>
            <span className="ib-to-sep" aria-hidden="true">
              ·
            </span>
            <span className="ib-hflag">{changed} changed</span>
          </>
        )}
        <Icon name="chevD" size={12} className="ib-hchev" />
      </button>
    </>
  );
}
