/**
 * Reading a page's preview out of its HTML: Open Graph, Twitter card, the
 * title, the description, the icon. Pure text work, no DOM, so it runs in
 * the server that fetched the page.
 *
 * Everything it returns is text or an absolute http(s) address. Markup in a
 * value is never kept as markup: entities are decoded once and the result is
 * shown as text by the card.
 */

import type { LinkPreview } from '../model/reference';

export type { LinkPreview };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (Object.hasOwn(ENTITIES, key)) return ENTITIES[key];
    if (key.startsWith('#')) {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return whole;
  });
}

const clean = (value: string | undefined, max: number): string | undefined => {
  if (!value) return undefined;
  const text = decodeEntities(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

function absolute(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(decodeEntities(value).trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The preview of the page at `url` whose HTML is `html`. Always returns at least the address. */
export function parseLinkPreview(html: string, url: string): LinkPreview {
  // Only the head matters, and a page may be cut off mid-body by the size cap.
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = end === -1 ? html : html.slice(0, end);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    const key = (a.property || a.name || '').toLowerCase();
    if (key && a.content && !meta.has(key)) meta.set(key, a.content);
  }
  let icon: string | undefined;
  let iconRank = 0;
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    const rel = (a.rel || '').toLowerCase();
    if (!a.href || !/\bicon\b/.test(rel)) continue;
    const rank = rel.includes('apple-touch') ? 1 : /svg|png/.test(a.type || a.href) ? 3 : 2;
    if (rank > iconRank) {
      iconRank = rank;
      icon = a.href;
    }
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const pick = (...keys: string[]) => keys.map((key) => meta.get(key)).find(Boolean);
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* the address was checked before the fetch */
  }
  const preview: LinkPreview = { url };
  const title = clean(pick('og:title', 'twitter:title') ?? titleTag, 300);
  const description = clean(pick('og:description', 'twitter:description', 'description'), 600);
  const site = clean(pick('og:site_name', 'application-name'), 120) ?? host;
  const image = absolute(pick('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'), url);
  const iconUrl = absolute(icon, url) ?? absolute('/favicon.ico', url);
  if (title) preview.title = title;
  if (description) preview.description = description;
  if (site) preview.site = site;
  if (image) preview.image = image;
  if (iconUrl) preview.icon = iconUrl;
  return preview;
}
