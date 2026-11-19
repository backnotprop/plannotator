/**
 * Reference cards: reading them. A card stands for a web page, one of the
 * person's artifacts, or a place in a plan. See `ReferenceObject`.
 */
import type { ReferenceObject, ReferenceTarget } from './types';

/** One `xn--` label of a host name as the letters it stands for (RFC 3492), or null when it is not well formed. */
function decodeLabel(label: string): string | null {
  const input = label.slice(4);
  const out: number[] = [];
  const split = input.lastIndexOf('-');
  for (let i = 0; i < Math.max(split, 0); i++) out.push(input.charCodeAt(i));
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let at = split > 0 ? split + 1 : 0; at < input.length; ) {
    const start = i;
    for (let w = 1, k = 36; ; k += 36) {
      if (at >= input.length) return null;
      const c = input.charCodeAt(at++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : c >= 65 && c <= 90 ? c - 65 : 36;
      if (digit >= 36) return null;
      i += digit * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      w *= 36 - t;
      if (!Number.isSafeInteger(w) || !Number.isSafeInteger(i)) return null;
    }
    const size = out.length + 1;
    let delta = start === 0 ? Math.floor((i - start) / 700) : (i - start) >> 1;
    delta += Math.floor(delta / size);
    let k = 0;
    for (; delta > 455; k += 36) delta = Math.floor(delta / 35);
    bias = k + Math.floor((36 * delta) / (delta + 38));
    n += Math.floor(i / size);
    i %= size;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** Scripts whose letters pass for Latin ones: Greek, Cyrillic, Armenian, Cherokee and their extensions. */
const LOOKALIKE_RE = /[\u0370-\u03ff\u0400-\u052f\u0530-\u058f\u13a0-\u13ff\u1c80-\u1c8f\u1f00-\u1fff\u2de0-\u2dff\ua640-\ua69f\uab70-\uabbf]/;

/**
 * A host name as a person would write it: `xn--mnchen-3ya.example` as `münchen.example`. A label with any
 * letter from a script whose letters pass for Latin ones stays as it was sent (`xn--…`), whether it mixes
 * scripts or is written wholly in one: that is how a name is made to look like another, and a card must
 * never read as a site it does not open.
 */
export function readableHost(host: string): string {
  return host
    .split('.')
    .map((label) => {
      if (!/^xn--/i.test(label)) return label;
      const decoded = decodeLabel(label.toLowerCase());
      if (!decoded || LOOKALIKE_RE.test(decoded)) return label;
      return decoded;
    })
    .join('.');
}

/** A file name short enough for one line, cut in the middle so that both its start and its ending (the version, the type) stay. */
export function shortName(name: string, max = 34): string {
  if (name.length <= max) return name;
  const tail = Math.ceil((max - 1) * 0.55);
  return `${name.slice(0, max - 1 - tail)}…${name.slice(-tail)}`;
}

/** A web address without its scheme or a trailing slash: what a bare card shows. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '');
    return `${readableHost(parsed.hostname.replace(/^www\./, ''))}${rest}`;
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return readableHost(new URL(url).hostname.replace(/^www\./, ''));
  } catch {
    return '';
  }
}

/** The plainest words for where a card points, used when it has no title yet. */
export function referenceAddress(target: ReferenceTarget): string {
  if (target.kind === 'web') return displayUrl(target.url);
  if (target.kind === 'artifact') return shortName(target.artifact.split('/').pop() || target.artifact);
  return target.anchor || target.document || '';
}

/** What a card shows, with every fallback applied: nothing here is ever empty for a valid card. */
export function referenceCard(object: ReferenceObject): { title: string; description: string; site: string; image: string | null; icon: string | null } {
  const { target } = object;
  return {
    title: object.title || referenceAddress(target),
    description: object.description ?? '',
    // A web card names the site it opens, read from its address: never a name the page or an agent gave it.
    site: target.kind === 'web' ? hostOf(target.url) : (object.site ?? ''),
    image: object.image ?? null,
    icon: object.icon ?? null,
  };
}

const URL_RE = /^https?:\/\/[^\s<>"']+$/i;

/** The web address a paste holds, when the paste is one address and nothing else. */
export function pastedUrl(text: string): string | null {
  const value = text.trim();
  if (!URL_RE.test(value) || value.length > 2048) return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

/** A page's preview: text and absolute http(s) addresses, never markup. */
export interface LinkPreview {
  /** The address the preview is for, after redirects. */
  url: string;
  title?: string;
  description?: string;
  site?: string;
  image?: string;
  icon?: string;
}

/**
 * How the canvas asks for a page's preview. The editor knows nothing about
 * how it is fetched, and calls it only for an address a person pasted:
 * an agent's `add` of a web card never causes a fetch.
 */
export type LinkPreviewPort = (url: string, signal?: AbortSignal) => Promise<LinkPreview | null>;
