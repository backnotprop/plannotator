/**
 * The browser's side of link previews: a `LinkPreviewPort` that asks a
 * server route (the one `unfurl/route.ts` makes). A failed request, or an
 * answer that is not the expected shape, is no preview, never an error for
 * the person.
 */
import type { LinkPreview, LinkPreviewPort } from '../model/reference';

const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value ? value.slice(0, max) : undefined);

/** Keep only the fields a preview has, each as text of a sane length. */
export function readLinkPreview(value: unknown): LinkPreview | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const url = text(v.url, 2048);
  if (!url) return null;
  const out: LinkPreview = { url };
  const title = text(v.title, 300);
  const description = text(v.description, 600);
  const site = text(v.site, 300);
  const image = text(v.image, 2048);
  const icon = text(v.icon, 2048);
  if (title) out.title = title;
  if (description) out.description = description;
  if (site) out.site = site;
  if (image) out.image = image;
  if (icon) out.icon = icon;
  return out;
}

export function routeLinkPreview(path: string): LinkPreviewPort {
  return async (url, signal) => {
    try {
      const response = await fetch(`${path}?url=${encodeURIComponent(url)}`, { signal });
      if (response.status !== 200) return null;
      return readLinkPreview(await response.json());
    } catch {
      return null;
    }
  };
}
