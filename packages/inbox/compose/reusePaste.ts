/** A browser's Copy image makes a new PNG whose hash matches no blob, but the clipboard HTML names the source. When that is this Inbox's own picture, the paste is that file; anything else returns null. */

const OWN_ROUTE = /^\/api\/inbox\/attachments\/(att_[0-9A-HJKMNP-TV-Z]{26})\/image$/;

export interface OwnAttachmentPaste {
  id: string;
  version: 'current' | 'sent';
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
  // Browsers write the absolute address when they copy a picture; anything else did not come from this page.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const id = OWN_ROUTE.exec(url.pathname)?.[1];
  if (!id) return null;
  return { id, version: url.searchParams.get('version') === 'sent' ? 'sent' : 'current', src: `${url.pathname}${url.search}` };
}
