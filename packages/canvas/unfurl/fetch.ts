/**
 * Fetching a page's preview, on a server. A browser cannot read another
 * site's page, which is the only reason this is not done in the page.
 *
 * It behaves the way link previews do everywhere, with the usual limits,
 * none of which the person ever sees: http and https only, a few redirects,
 * a time cap, a size cap (only the start of the page is read), and no
 * address on the machine's own network unless the host says so. When a page
 * gives nothing, or cannot be reached, the answer is still a preview: the
 * bare address, so the card always has something to show.
 *
 * `fetch` and the address lookup are passed in, so the same code runs under
 * Bun, under Node (the Pi server) and in a test with no network.
 */
import { type LinkPreview, parseLinkPreview } from './parse';

export interface UnfurlOptions {
  fetch?: typeof fetch;
  /** The addresses a host name resolves to. Absent: only literal addresses are checked. */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Let a preview be fetched from this machine or its private network. */
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export const UNFURL_DEFAULTS = { timeoutMs: 6000, maxBytes: 512 * 1024, maxRedirects: 5 } as const;

/** An agent string sites answer with their public preview. No contact detail, nothing about the person. */
const USER_AGENT = 'Mozilla/5.0 (compatible; Plannotator link preview)';

export function parseWebUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** Whether an IP address (v4 or v6 text) is this machine, a private network or otherwise not the public internet. */
export function isPrivateAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = (mapped ? mapped[1] : value).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (!value.includes(':')) return false;
  return value === '::' || value === '::1' || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || value.startsWith('ff');
}

const isIpLiteral = (hostname: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':');

async function isPrivateHost(url: URL, options: UnfurlOptions): Promise<boolean> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  if (isIpLiteral(hostname)) return isPrivateAddress(hostname);
  if (!options.lookup) return false;
  try {
    const addresses = await options.lookup(hostname);
    return addresses.length === 0 || addresses.some(isPrivateAddress);
  } catch {
    return true;
  }
}

/** Read at most `maxBytes` of a response as text. */
async function readStart(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value.subarray(0, Math.max(0, maxBytes - total)));
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk.subarray(0, bytes.length - at), at);
    at += chunk.byteLength;
    if (at >= bytes.length) break;
  }
  const charset = response.headers.get('content-type')?.match(/charset=([^;]+)/i)?.[1]?.trim();
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/**
 * The preview for `address`. Null only when the address itself is not one a
 * preview can be made for (not http(s), or on a private network). Any other
 * trouble (a timeout, an error page, a page with no metadata, a PDF) gives
 * the bare preview: `{ url }` with the site's name.
 */
export async function unfurlUrl(address: string, options: UnfurlOptions = {}): Promise<LinkPreview | null> {
  const first = parseWebUrl(address);
  if (!first) return null;
  const doFetch = options.fetch ?? fetch;
  const { timeoutMs, maxBytes, maxRedirects } = { ...UNFURL_DEFAULTS, ...options };
  const bare = (url: URL): LinkPreview => ({ url: url.href, site: url.hostname.replace(/^www\./, '') });
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let url = first;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (!options.allowPrivate && (await isPrivateHost(url, options))) return hop === 0 ? null : bare(first);
      const response = await doFetch(url.href, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en' },
      });
      if (response.status >= 300 && response.status < 400) {
        const next = parseWebUrl(new URL(response.headers.get('location') ?? '', url).href);
        response.body?.cancel().catch(() => {});
        if (!next) return bare(url);
        url = next;
        continue;
      }
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !/html|xml/i.test(type)) {
        response.body?.cancel().catch(() => {});
        // A picture's address previews as the picture itself.
        return /^image\//i.test(type) && response.ok ? { ...bare(url), image: url.href, title: decodeURIComponent(url.pathname.split('/').pop() || '') || undefined } : bare(url);
      }
      return parseLinkPreview(await readStart(response, maxBytes), url.href);
    }
    return bare(url);
  } catch {
    return bare(first);
  }
}

/** A small cache in front of `unfurlUrl`: the same address asked twice is fetched once. */
export function createUnfurler(options: UnfurlOptions & { cacheSize?: number; cacheMs?: number } = {}): (address: string, signal?: AbortSignal) => Promise<LinkPreview | null> {
  const size = options.cacheSize ?? 300;
  const ttl = options.cacheMs ?? 30 * 60 * 1000;
  const cache = new Map<string, { at: number; value: Promise<LinkPreview | null> }>();
  return (address, signal) => {
    const key = parseWebUrl(address)?.href;
    if (!key) return Promise.resolve(null);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.value;
    }
    // The fetch is not tied to one caller's signal: a second caller may be waiting on it.
    void signal;
    const value = unfurlUrl(key, options);
    cache.set(key, { at: Date.now(), value });
    if (cache.size > size) cache.delete(cache.keys().next().value as string);
    return value;
  };
}
