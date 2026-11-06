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
 * Remote images (`http(s)`, protocol-relative `//host/…`) never load in the
 * window: an agent's text never makes the browser call a site when the person
 * reads it (the owner's rule, kept for "Pages only", 2026-11-05). The window's
 * CSP allows `https:` and `http:` images only because an attached HTML page,
 * a srcdoc frame, inherits it (inbox.ts `WINDOW_CSP`), so the window's own
 * renderers refuse them: `inboxBodyImageResolver` draws one as its alt text,
 * `refuseWebImage` does for every other surface (`InboxWebImagePolicy`), and
 * `inboxImageSrcResolver` turns one into a URL that loads nothing.
 */
import { inboxUrl, machineOf } from './inboxUrl';
import type { ImageSrcResolver } from '@plannotator/ui/configure';
import { createElement, type ReactNode } from 'react';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import { ImageResolverContext, type ImageResolution, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { GuideImageSrcContext, type GuideImageSrcResolver } from '@plannotator/guide-viewer/renderInlineMarkdown';
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

/**
 * A picture from the web, as the browser would read the src: `https:`/`http:`
 * (with or without slashes) or protocol-relative (`//host`, and `\\host`,
 * which a URL parser reads the same way), after any leading space.
 */
export function isWebImageSrc(src: string): boolean {
  return /^[\s\u0000-\u001f]*(?:https?:|[\\/]{2})/i.test(src);
}

/** What a web picture in the window draws as: its alt text in a quiet chip, nothing fetched. */
export const WEB_IMAGE_REFUSED = { kind: 'unavailable', title: 'Pictures from the web are not loaded here' } as const satisfies ImageResolution;

/** A src that loads nothing (an empty `data:` URL, which the window's CSP allows and no request is made for). */
export const NO_IMAGE_SRC = 'data:,';

/** The window's default for any rendered text (`InboxWebImagePolicy`): a web picture is refused, anything else is the renderer's own. */
export const refuseWebImage: ImageResolver = (src) => (isWebImageSrc(src) ? WEB_IMAGE_REFUSED : null);

/** A guide's picture in the window: a web one is not drawn (a guide's images are all web ones), as when the CSP held it. */
const refuseWebGuideImage: GuideImageSrcResolver = (src) => (isWebImageSrc(src) ? null : src);

/**
 * Around the whole window (InboxApp): every surface that draws text without its own image resolver
 * (decision and action cards, card panels, a question's context, guides) refuses a web picture. A
 * surface with its own resolver (`inboxBodyImageResolver`) refuses one itself.
 */
export function InboxWebImagePolicy({ children }: { children?: ReactNode }) {
  return createElement(
    ImageResolverContext.Provider,
    { value: refuseWebImage },
    createElement(GuideImageSrcContext.Provider, { value: refuseWebGuideImage }, children),
  );
}

/**
 * A message body's, a Markdown attachment's or a context's images (`imageBaseDir` from
 * `inboxMessageImageBase` or `inboxMarkdownImageBase`): `data:` and `blob:` keep their URL, a web
 * picture is refused, and anything else loads from the Inbox's scoped route, so ui draws one the Inbox
 * refuses (403 image_hidden, 404) as its alt text in a quiet chip: markdown images, `<img>` in raw-HTML
 * blocks and question cards' pictures alike.
 */
export function inboxBodyImageResolver(imageBaseDir: string): ImageResolver {
  return (src) => {
    if (isWebImageSrc(src)) return WEB_IMAGE_REFUSED;
    return { kind: 'src', src: /^(data|blob):/i.test(src) ? src : getImageSrc(src, imageBaseDir) };
  };
}

/** The window's image resolver: message and Markdown images use scoped Inbox routes; a web picture loads nothing. */
export const inboxImageSrcResolver: ImageSrcResolver = (path, base) => {
  if (isWebImageSrc(path)) return NO_IMAGE_SRC;
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

/** Taller than this (in CSS pixels), an image in a message is cropped to its top (inbox.css `[data-ib-tall]`). */
export const TALL_MESSAGE_IMAGE_PX = 480;

/**
 * Mark a loaded image in a message body that would draw taller than the crop
 * (a phone screenshot of 390 by 4000): the window crops it from the top, as
 * the attachment gallery does, keeping its own width (`--ib-nw`). A click
 * still opens it whole. An image that fits is never marked.
 */
export function markTallImage(img: HTMLImageElement): void {
  const { naturalWidth: width, naturalHeight: height } = img;
  if (width <= 0 || height <= 0) return;
  if (height <= TALL_MESSAGE_IMAGE_PX || height <= width * 1.5) {
    img.removeAttribute('data-ib-tall');
    return;
  }
  img.setAttribute('data-ib-tall', '');
  img.style.setProperty('--ib-nw', `${width}px`);
}
