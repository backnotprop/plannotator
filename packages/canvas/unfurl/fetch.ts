/**
 * Fetching a page's preview, on a server. A browser cannot read another
 * site's page, which is the only reason this is not done in the page.
 *
 * It behaves the way link previews do everywhere, with the usual limits,
 * none of which the person ever sees: http and https only, a few redirects,
 * a time cap, a size cap (only the start of the page is read), and no
 * address on the machine's own network unless the host's policy says so
 * (`allowPrivate`). Each host name is resolved, checked, and then connected
 * to at the address that was checked. When a page
 * gives nothing, or cannot be reached, the answer is still a preview: the
 * bare address, so the card always has something to show.
 *
 * `fetch` and the address lookup are passed in, so the same code runs under
 * Bun, under Node (the Pi server) and in a test with no network.
 */
import { isIpAddress, isPrivateAddress } from './address';
import { type LinkPreview, parseLinkPreview } from './parse';

export { isPrivateAddress };

/** The addresses a host name resolves to. */
export type HostLookup = (hostname: string) => Promise<string[]>;

/**
 * Connect to `address` and ask it for `url`: the request goes to the address
 * that was checked, not to whatever the name resolves to a moment later
 * (which is how DNS rebinding gets past a check).
 */
export type PinnedFetch = (url: URL, address: string, init: RequestInit) => Promise<Response>;

export interface UnfurlOptions {
  fetch?: typeof fetch;
  /**
   * Absent: the system resolver (`node:dns`, which Bun has too). `false`
   * turns the lookup off, on purpose: then only addresses written as numbers
   * are checked.
   */
  lookup?: HostLookup | false;
  /** Absent: Bun's own way when running under Bun with no `fetch` given; otherwise the request goes by name. */
  pin?: PinnedFetch;
  /**
   * The host's policy for this machine and its private network. Default
   * false: such an address gets no preview, and a picture or icon address
   * that points there is dropped from the preview. Set true only by a server
   * that one person runs for themselves on their own machine (the local
   * Plannotator server), where pasting `http://localhost:3000` should give a
   * card. A hosted server leaves it false. It is safe there only because a
   * preview is fetched for an address a person pasted, never for one an
   * agent put in a card: see `LinkPreviewPort`.
   */
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

const systemLookup: HostLookup = async (hostname) => {
  const dns = await import('node:dns/promises');
  return (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);
};

/** Bun: connect by address, name the host for the request and for the certificate. */
const bunPin: PinnedFetch = (url, address, init) => {
  const direct = new URL(url.href);
  direct.hostname = address.includes(':') ? `[${address}]` : address;
  const headers = new Headers(init.headers);
  headers.set('host', url.host);
  return fetch(direct.href, { ...init, headers, tls: { serverName: url.hostname } } as RequestInit);
};

interface Resolved {
  /** The address to connect to, when one is known. */
  address: string | null;
  private: boolean;
}

const LOCAL_NAME_RE = /(^|\.)(localhost|local|internal|home\.arpa|lan)$/;

/** Where a host is, and whether that is private. A name that will not resolve is treated as private. */
export async function resolveHost(url: URL, options: Pick<UnfurlOptions, 'lookup'> = {}): Promise<Resolved> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIpAddress(hostname)) return { address: hostname, private: isPrivateAddress(hostname) };
  const named = LOCAL_NAME_RE.test(hostname);
  if (options.lookup === false) return { address: null, private: named };
  try {
    const addresses = await (options.lookup ?? systemLookup)(hostname);
    if (addresses.length === 0) return { address: null, private: true };
    // Any private address among them makes the name private; connect to the first.
    return { address: addresses[0], private: named || addresses.some(isPrivateAddress) };
  } catch {
    return { address: null, private: true };
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

/** A preview, and whether the site really answered (a bare fallback after a failure is not worth keeping). */
interface Unfurled {
  preview: LinkPreview | null;
  real: boolean;
}

async function unfurl(address: string, options: UnfurlOptions): Promise<Unfurled> {
  const first = parseWebUrl(address);
  if (!first) return { preview: null, real: true };
  const { timeoutMs, maxBytes, maxRedirects } = { ...UNFURL_DEFAULTS, ...options };
  const pin = options.pin ?? (!options.fetch && typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? bunPin : null);
  const doFetch = options.fetch ?? fetch;
  const bare = (url: URL): LinkPreview => ({ url: url.href, site: url.hostname.replace(/^www\./, '') });
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const init: RequestInit = {
    redirect: 'manual',
    signal,
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en' },
  };
  /** A picture or icon address the page named: kept only when a viewer's browser may be sent there. */
  const reachable = async (value: string | undefined): Promise<string | undefined> => {
    const url = value ? parseWebUrl(value) : null;
    if (!url) return undefined;
    return options.allowPrivate || !(await resolveHost(url, options)).private ? url.href : undefined;
  };

  let url = first;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const where = await resolveHost(url, options);
      if (where.private && !options.allowPrivate) return { preview: hop === 0 ? null : bare(first), real: true };
      const response = pin && where.address ? await pin(url, where.address, init) : await doFetch(url.href, init);
      if (response.status >= 300 && response.status < 400) {
        const next = parseWebUrl(new URL(response.headers.get('location') ?? '', url).href);
        response.body?.cancel().catch(() => {});
        if (!next) return { preview: bare(url), real: true };
        url = next;
        continue;
      }
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        return { preview: bare(url), real: false };
      }
      if (/^image\//i.test(type)) {
        // A picture's address previews as the picture itself.
        response.body?.cancel().catch(() => {});
        return { preview: { ...bare(url), image: url.href, title: decodeURIComponent(url.pathname.split('/').pop() || '') || undefined }, real: true };
      }
      if (!/html|xml/i.test(type)) {
        response.body?.cancel().catch(() => {});
        return { preview: bare(url), real: true };
      }
      const preview = parseLinkPreview(await readStart(response, maxBytes), url.href);
      const [image, icon] = await Promise.all([reachable(preview.image), reachable(preview.icon)]);
      delete preview.image;
      delete preview.icon;
      if (image) preview.image = image;
      if (icon) preview.icon = icon;
      return { preview, real: true };
    }
    return { preview: bare(url), real: true };
  } catch {
    return { preview: bare(first), real: false };
  }
}

/**
 * The preview for `address`. Null only when the address itself is not one a
 * preview can be made for (not http(s), or private while the host's policy
 * says no). Any other trouble (a timeout, an error page, a page with no
 * metadata, a PDF) gives the bare preview: `{ url }` with the site's name.
 */
export async function unfurlUrl(address: string, options: UnfurlOptions = {}): Promise<LinkPreview | null> {
  return (await unfurl(address, options)).preview;
}

/**
 * A small cache in front of `unfurlUrl`: the same address asked twice is
 * fetched once. A fallback made because the site failed or timed out is not
 * kept, so the next paste tries again.
 */
export function createUnfurler(options: UnfurlOptions & { cacheSize?: number; cacheMs?: number } = {}): (address: string) => Promise<LinkPreview | null> {
  const size = options.cacheSize ?? 300;
  const ttl = options.cacheMs ?? 30 * 60 * 1000;
  const cache = new Map<string, { at: number; value: Promise<Unfurled> }>();
  return async (address) => {
    const key = parseWebUrl(address)?.href;
    if (!key) return null;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) {
      cache.delete(key);
      cache.set(key, hit);
      return (await hit.value).preview;
    }
    const value = unfurl(key, options);
    cache.set(key, { at: Date.now(), value });
    if (cache.size > size) cache.delete(cache.keys().next().value as string);
    const answer = await value;
    if (!answer.real && cache.get(key)?.value === value) cache.delete(key);
    return answer.preview;
  };
}
