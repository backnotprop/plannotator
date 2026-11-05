/**
 * A picture copied from this Inbox and pasted (approval "reuse-attachments"; the
 * owner: "a way to point to the original file"). A browser's Copy image makes a
 * new PNG, so its hash matches no blob and its name is lost. But the clipboard's
 * HTML names where it came from: `<img src=".../api/inbox/attachments/att_…/image">`.
 * When that is this Inbox, the paste is that file. When a browser leaves the tag
 * out, or it is anything else (words around the picture, two pictures, another
 * Inbox's, another machine's), this answers null and the paste goes on as a paste.
 */

const OWN_ROUTE = /^\/api\/inbox\/attachments\/(att_[0-9A-HJKMNP-TV-Z]{26})\/image$/;

export interface OwnAttachmentPaste {
  id: string;
  version: 'current' | 'sent';
  /** The route, for the tile's picture while it is added. */
  src: string;
}

export function ownAttachmentInPaste(data: Pick<DataTransfer, 'getData'> | null, origin: string): OwnAttachmentPaste | null {
  let html = '';
  try {
    html = data?.getData('text/html') ?? '';
  } catch {
    return null;
  }
  const tags = html.match(/<img\b[^>]*>/gi) ?? [];
  if (tags.length !== 1) return null;
  // Only the picture: what a browser wraps it in, never a selection with words around it.
  const rest = html.replace(/<!--[\s\S]*?-->|<meta\b[^>]*>|<\/?(?:html|head|body|span|div|p|a)\b[^>]*>|<img\b[^>]*>/gi, '');
  if (rest.trim() !== '') return null;
  const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tags[0]!);
  const value = (src?.[1] ?? src?.[2] ?? src?.[3] ?? '').replace(/&amp;/g, '&').trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const id = OWN_ROUTE.exec(url.pathname)?.[1];
  if (!id) return null;
  return { id, version: url.searchParams.get('version') === 'sent' ? 'sent' : 'current', src: `${url.pathname}${url.search}` };
}
