/**
 * Images in a message (#1813). A message body is drawn by ui's
 * Viewer with `imageBaseDir` set to `inboxMessageImageBase(message.id)`, and
 * the window installs `inboxImageSrcResolver` (configurePlannotatorUI), which
 * turns that marker plus the src as written into the Inbox's own route:
 * `/api/inbox/messages/<id>/image?path=<src>`. The server reads the image
 * from the message's project only when the message's body shows it
 * (packages/shared/inbox/message-images.ts). There is no route that takes a
 * bare path.
 *
 * Remote `http(s)` images are left as written: the window's CSP (`img-src
 * 'self' data: blob:`) does not load them.
 */
import type { ImageSrcResolver } from '@plannotator/ui/configure';

const MESSAGE_BASE_PREFIX = 'inbox-message:';
/** `<data dir>/inbox/markups/<sha256>.<ext>`, the path a marked-up image comment carries. */
const INBOX_MARKUP_PATH_RE = /[\\/]inbox[\\/]markups[\\/]([0-9a-f]{64}\.(?:png|jpg|webp))$/;
const MESSAGE_ID_RE = /^msg_[0-9A-Za-z]+$/;

/** The `imageBaseDir` a message body is drawn with. */
export function inboxMessageImageBase(messageId: string): string {
  return `${MESSAGE_BASE_PREFIX}${messageId}`;
}

/** The URL an image in a message loads from. */
export function inboxMessageImageUrl(messageId: string, src: string): string {
  return `/api/inbox/messages/${encodeURIComponent(messageId)}/image?path=${encodeURIComponent(src)}`;
}

/**
 * The window's image resolver. Outside a message body there is no image
 * route in the Inbox, so any other local path keeps ui's default URL, which
 * the Inbox answers with a 404 as it always has.
 */
export const inboxImageSrcResolver: ImageSrcResolver = (path, base) => {
  if (/^https?:\/\//i.test(path)) return path;
  // A marked-up image the person drew on an image attachment: kept in the
  // Inbox's data dir, shown back by its file name only.
  const markup = INBOX_MARKUP_PATH_RE.exec(path);
  if (markup) return `/api/inbox/markups/${markup[1]}`;
  if (base?.startsWith(MESSAGE_BASE_PREFIX)) {
    const id = base.slice(MESSAGE_BASE_PREFIX.length);
    if (MESSAGE_ID_RE.test(id)) return inboxMessageImageUrl(id, path);
  }
  let url = `/api/image?path=${encodeURIComponent(path)}`;
  if (base && !path.startsWith('/')) url += `&base=${encodeURIComponent(base)}`;
  return url;
};
