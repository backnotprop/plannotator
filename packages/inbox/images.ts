/**
 * Images in a message (#1813). A message body is drawn by ui's
 * Viewer with `imageBaseDir` set to `inboxMessageImageBase(message.id)`, and
 * the window installs `inboxImageSrcResolver` (configurePlannotatorUI), which
 * turns that marker plus the src as written into the Inbox's own route:
 * `/api/inbox/messages/<id>/image?path=<src>`. The server reads the image
 * only when the message's body shows it: for an agent's message from
 * anywhere the user can read, for the person's own from its project, never
 * from a hidden folder of the home folder (`~/.ssh`) or a dotenv file
 * (packages/shared/inbox/message-images.ts). An attached Markdown file's
 * images work the same way with `inboxMarkdownImageBase(attachment, version)`:
 * `/api/inbox/attachments/<id>/markdown-image?path=<src>&version=…`, relative
 * to the file's folder (#2228); a Markdown file a link in it opened adds
 * `&document=<its path in that folder>` (#2230). There is no route that takes a bare path.
 *
 * Remote images (`http(s)`, protocol-relative `//host/…`) are left as
 * written: the window's CSP (`img-src 'self' data: blob:`) does not load them.
 */
import { inboxUrl, machineOf } from './inboxUrl';
import type { ImageSrcResolver } from '@plannotator/ui/configure';
import { tourAssetUrl, tourMarkupUrl } from './tour/assets';

const MESSAGE_BASE_PREFIX = 'inbox-message:';
const ATTACHMENT_BASE_PREFIX = 'inbox-markdown:';
/** The onboarding tour's messages (tour/): their images are the tour's own assets, by file name only. */
export const TOUR_IMAGE_BASE = 'inbox-tour:';
const TOUR_ASSET_RE = /^[a-z0-9][a-z0-9.-]*\.webp$/;
/**
 * A drawing the person made in the tour (a circle on a1.png, a film's frame): kept in memory only, as a
 * `blob:` URL the tour revokes on Exit or Finish (tour/assets.ts). Its path is `inbox-tour-markup:<n>`.
 */
export const TOUR_MARKUP_BASE = 'inbox-tour-markup:';
/** `<data dir>/inbox/markups/<sha256>.<ext>`, the path a marked-up image comment carries. */
const INBOX_MARKUP_PATH_RE = /[\\/]inbox[\\/]markups[\\/]([0-9a-f]{64}\.(?:png|jpg|webp))$/;
const MESSAGE_ID_RE = /^msg_[0-9A-Za-z]+$/;

/** A marked-up image's file name (`<sha256>.png`) from the path a comment carries in the data dir; null for any other path. */
export function inboxMarkupName(path: string): string | null {
  return INBOX_MARKUP_PATH_RE.exec(path)?.[1] ?? null;
}

/** Where a marked-up image a comment carries (its path in the data dir) is shown back, by its file name; null for any other path. */
export function inboxMarkupUrl(path: string): string | null {
  const name = inboxMarkupName(path);
  return name ? inboxUrl(`/markups/${name}`) : null;
}

/** The `imageBaseDir` a message body is drawn with. */
export function inboxMessageImageBase(messageId: string): string {
  return `${MESSAGE_BASE_PREFIX}${messageId}`;
}

/** The URL an image in a message loads from. */
export function inboxMessageImageUrl(messageId: string, src: string): string {
  return inboxUrl(`/messages/${encodeURIComponent(messageId)}/image?path=${encodeURIComponent(src)}`, undefined, machineOf(messageId));
}

/**
 * The src as the body wrote it, read back from an image URL the body drew
 * (`inboxMessageImageUrl`), when the URL is that message's: what finds the
 * image's captured file (`inline_images`, by `ref`). Null for anything else.
 */
export function inlineImageRefFromSrc(src: string, messageId: string): string | null {
  try {
    const base = typeof window !== 'undefined' && /^https?:/.test(window.location.href) ? window.location.href : 'http://localhost/';
    const url = new URL(src, base);
    if (url.pathname !== inboxUrl(`/messages/${encodeURIComponent(messageId)}/image`, undefined, machineOf(messageId))) return null;
    return url.searchParams.get('path');
  } catch {
    return null;
  }
}

/**
 * The image base for one Markdown attachment version (the images themselves remain live files). `document`: a
 * Markdown file a link in it opened (its path relative to the attachment's folder), whose own images these are.
 */
export function inboxMarkdownImageBase(attachmentId: string, version: 'current' | 'sent', document?: string): string {
  return `${ATTACHMENT_BASE_PREFIX}${attachmentId}:${version}${document ? `:${encodeURIComponent(document)}` : ''}`;
}

/** The window's image resolver: message and Markdown images use scoped Inbox routes. */
export const inboxImageSrcResolver: ImageSrcResolver = (path, base) => {
  if (/^(https?:)?\/\//i.test(path)) return path;
  // A marked-up image the person drew on an image attachment: kept in the
  // Inbox's data dir, shown back by its file name only.
  const markup = inboxMarkupUrl(path);
  if (markup) return markup;
  // A drawing the person made in the tour (kept in memory only): never for a real message's body, and only while the tour holds it.
  if (path.startsWith(TOUR_MARKUP_BASE) && !base?.startsWith(MESSAGE_BASE_PREFIX)) {
    const kept = tourMarkupUrl(path);
    if (kept) return kept;
  }
  if (base === TOUR_IMAGE_BASE) {
    // A tour picture loads from the tour's read-only asset route; anything else in a tour message loads nothing.
    return TOUR_ASSET_RE.test(path) ? tourAssetUrl(path) : inboxUrl(`/tour/assets/none`);
  }
  if (base?.startsWith(ATTACHMENT_BASE_PREFIX)) {
    const match = /^(att_[0-9A-Za-z]+):(current|sent)(?::([^:]+))?$/.exec(base.slice(ATTACHMENT_BASE_PREFIX.length));
    if (match) {
      const document = match[3] ? `&document=${match[3]}` : '';
      return inboxUrl(`/attachments/${match[1]}/markdown-image?path=${encodeURIComponent(path)}&version=${match[2]}${document}`, undefined, machineOf(match[1]));
    }
  }
  if (base?.startsWith(MESSAGE_BASE_PREFIX)) {
    const id = base.slice(MESSAGE_BASE_PREFIX.length);
    if (MESSAGE_ID_RE.test(id)) return inboxMessageImageUrl(id, path);
  }
  let url = `/api/image?path=${encodeURIComponent(path)}`;
  if (base && !path.startsWith('/')) url += `&base=${encodeURIComponent(base)}`;
  return url;
};

/**
 * The widths the window asks the Inbox's image routes for (`?w=`, packages/server/inbox-image-scale.ts) where it
 * draws a picture smaller than it is: a message body's pictures, the gallery's frames, a tile's icon. A wider
 * picture comes back that wide, so the browser decodes a copy of a few MB instead of the 34 MB of a 3840 by 2242
 * screenshot; the viewer that opens a picture whole asks for no width. An Inbox that does not know `w` sends the
 * original, as before.
 */
export const MESSAGE_IMAGE_WIDTH = 1600;
export const GALLERY_IMAGE_WIDTH = 800;
export const TILE_IMAGE_WIDTH = 128;

/**
 * An Inbox image route's URL asking for the picture at most `width` wide. Any other URL (a tour's asset, a
 * `blob:`, a remote picture) comes back as it is.
 */
export function scaledImageUrl(url: string, width: number): string {
  if (!/\/(?:messages|attachments)\/[A-Za-z0-9_%]+\/image$/.test(url.split('?', 1)[0]!)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}w=${width}`;
}

/** The URL a picture of `width` pixels is drawn from where it shows at most `drawn` wide: a smaller copy when it is wider. */
export function drawnImageUrl(url: string, width: number | undefined, drawn: number): string {
  return typeof width === 'number' && width > drawn ? scaledImageUrl(url, drawn) : url;
}

/** Whether a URL asks for a smaller copy (`scaledImageUrl`). */
export function isScaledImageUrl(url: string): boolean {
  return /[?&]w=\d+(?:&|$)/.test(url);
}

/**
 * How a picture in a message body is drawn (approval "inbox-inline-image-fit", 2026-11-10; inbox.css
 * `img[data-ib-fit]`). Whole: at most the column wide, at most its own width, at most the cap high
 * (`messageImageCap`), its shape kept, never drawn larger than its file. The one exception is a picture more
 * than `LONG_MESSAGE_IMAGE_RATIO` times as tall as it is wide that would pass the cap (a full-page capture):
 * it keeps the column's width and shows its top down to the cap, with "Show all" under it (Thread.tsx).
 */
export const MESSAGE_IMAGE_HEIGHT_SHARE = 0.7;
export const MESSAGE_IMAGE_MIN_CAP_PX = 320;
export const LONG_MESSAGE_IMAGE_RATIO = 3;

/** The tallest a picture in a message is drawn in a window `windowHeight` high: 70% of it, never under 320 px. */
export function messageImageCap(windowHeight: number): number {
  return Math.max(MESSAGE_IMAGE_MIN_CAP_PX, windowHeight * MESSAGE_IMAGE_HEIGHT_SHARE);
}

/** A picture more than three times as tall as it is wide: the only shape that is ever cut. */
export function isLongMessageImage(size: { width: number; height: number }): boolean {
  return size.height > size.width * LONG_MESSAGE_IMAGE_RATIO;
}

/**
 * The size a picture of `size` is drawn at in a column `column` wide, in a window `windowHeight` high, and
 * whether only its top shows (`cut`). The CSS draws the same numbers; this is the rule in one place, for the
 * "Show all" control and the tests.
 */
export function fitMessageImage(size: { width: number; height: number }, column: number, windowHeight: number): { width: number; height: number; cut: boolean } {
  const cap = messageImageCap(windowHeight);
  const across = Math.min(column, size.width);
  if (isLongMessageImage(size) && (across * size.height) / size.width > cap) return { width: across, height: cap, cut: true };
  const scale = Math.min(1, column / size.width, cap / size.height);
  return { width: size.width * scale, height: size.height * scale, cut: false };
}

/**
 * The box a picture in a message is fitted from: its own pixels once it has loaded (a smaller copy,
 * `scaledImageUrl`, is measured as the original it carries in `width`), else the size recorded when the
 * message was sent (`inline_images`), so its place is held before it loads. A width or height the agent wrote
 * on a raw `<img>` is the box it asked for. Null: nothing is known yet.
 */
export function messageImageBox(img: HTMLImageElement, recorded?: { width?: number; height?: number } | null): { width: number; height: number } | null {
  const scaled = isScaledImageUrl(img.getAttribute('src') ?? '');
  const attrWidth = Number(img.getAttribute('width')) || 0;
  const attrHeight = Number(img.getAttribute('height')) || 0;
  let width = 0;
  let height = 0;
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    width = scaled && attrWidth > 0 ? attrWidth : img.naturalWidth;
    height = (img.naturalHeight * width) / img.naturalWidth;
  } else if (recorded?.width && recorded.height && recorded.width > 0 && recorded.height > 0) {
    width = recorded.width;
    height = recorded.height;
  } else return null;
  if (!scaled && attrWidth > 0 && attrHeight > 0) return { width: attrWidth, height: attrHeight };
  if (!scaled && attrWidth > 0) return { width: attrWidth, height: (height * attrWidth) / width };
  if (!scaled && attrHeight > 0) return { width: (width * attrHeight) / height, height: attrHeight };
  return { width, height };
}

/**
 * Give a picture in a message body its box (`--ib-nw`, `--ib-nh`, `data-ib-fit`; "long" for the shape that may
 * be cut): inbox.css draws it from these. Returns the box, or null when nothing is known yet (the picture stays
 * as ui drew it until it loads).
 */
export function fitMessageImageElement(img: HTMLImageElement, recorded?: { width?: number; height?: number } | null): { width: number; height: number } | null {
  const box = messageImageBox(img, recorded);
  if (!box) return null;
  const width = String(Math.round(box.width * 100) / 100);
  const height = String(Math.round(box.height * 100) / 100);
  if (img.style.getPropertyValue('--ib-nw') !== width) img.style.setProperty('--ib-nw', width);
  if (img.style.getPropertyValue('--ib-nh') !== height) img.style.setProperty('--ib-nh', height);
  const fit = isLongMessageImage(box) ? 'long' : '';
  if (img.getAttribute('data-ib-fit') !== fit) img.setAttribute('data-ib-fit', fit);
  return box;
}

const MORE_ATTR = 'data-ib-imgmore';

/** What a picture is called in its control's name: its alt text, else "this picture". */
function pictureName(img: HTMLImageElement): string {
  return img.alt.trim() || 'this picture';
}

/** The key a picture's "Show all" is remembered under while its message is on screen: the src as the body wrote it. */
function pictureKey(img: HTMLImageElement): string {
  return img.getAttribute('data-image-src') ?? img.getAttribute('src') ?? '';
}

/**
 * Fit every picture of a message body (`fitMessageImageElement`) and keep the "Show all" control of each long
 * one that is cut: a real button after the picture (keyboard reachable, named "Show all of <alt>"), apart from
 * the picture itself, whose click still opens the viewer. `open` holds the pictures the person opened (by
 * `pictureKey`): they stay whole, with "Show less". Safe to call again at any time (a render, a load, a resize).
 */
export function syncMessageImages(body: HTMLElement, recordedOf: (img: HTMLImageElement) => { width?: number; height?: number } | null, open: ReadonlySet<string>): void {
  const kept = new Set<Element>();
  const view = body.ownerDocument.defaultView;
  for (const img of body.querySelectorAll<HTMLImageElement>('img')) {
    if (img.hasAttribute('data-question-picture') || img.hidden) continue;
    const box = fitMessageImageElement(img, recordedOf(img));
    if (!box || !isLongMessageImage(box)) continue;
    const isOpen = open.has(pictureKey(img));
    // The cap the CSS drew with (`max-height`, in px once computed); the window's height where there is no layout.
    const drawnCap = isOpen || !view ? NaN : parseFloat(view.getComputedStyle(img).maxHeight);
    const windowHeight = Number.isFinite(drawnCap) && drawnCap > 0 ? drawnCap / MESSAGE_IMAGE_HEIGHT_SHARE : (view?.innerHeight ?? 0);
    const cut = fitMessageImage(box, img.clientWidth > 0 ? img.clientWidth : box.width, windowHeight).cut;
    img.toggleAttribute('data-ib-open', isOpen);
    img.toggleAttribute('data-ib-cut', cut);
    if (!isOpen && !cut) continue;
    let more = img.nextElementSibling;
    if (!more?.hasAttribute(MORE_ATTR)) {
      more = body.ownerDocument.createElement('span');
      more.setAttribute(MORE_ATTR, '');
      more.className = 'ib-imgmore annotation-exclude';
      const button = body.ownerDocument.createElement('button');
      button.type = 'button';
      button.className = 'ib-btn ib-sm';
      more.append(button);
      img.after(more);
    }
    const button = more.firstElementChild as HTMLButtonElement;
    const label = isOpen ? 'Show less' : 'Show all';
    if (button.getAttribute('data-label') !== label) button.setAttribute('data-label', label);
    const name = `${label} of ${pictureName(img)}`;
    if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
    button.setAttribute('aria-expanded', String(isOpen));
    more.toggleAttribute('data-open', isOpen);
    (more as HTMLElement).style.setProperty('--ib-nw', img.style.getPropertyValue('--ib-nw'));
    kept.add(more);
  }
  for (const more of body.querySelectorAll(`[${MORE_ATTR}]`)) if (!kept.has(more)) more.remove();
  for (const img of body.querySelectorAll<HTMLImageElement>('img[data-ib-cut], img[data-ib-open]')) {
    if (img.getAttribute('data-ib-fit') !== 'long' || img.hidden) {
      img.removeAttribute('data-ib-cut');
      img.removeAttribute('data-ib-open');
    }
  }
}

/**
 * A click in a message body on a picture's "Show all" / "Show less": flips that picture in `open` and returns
 * it. Null: the click was on something else.
 */
export function toggleMessageImage(target: EventTarget | null, open: Set<string>): HTMLImageElement | null {
  const more = target instanceof Element ? target.closest(`[${MORE_ATTR}]`) : null;
  const img = more?.previousElementSibling;
  if (!more || !(img instanceof HTMLImageElement)) return null;
  const key = pictureKey(img);
  if (open.has(key)) open.delete(key);
  else open.add(key);
  return img;
}
