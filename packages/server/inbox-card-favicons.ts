/**
 * A web link's favicon on the opened card (user feedback #10; the owner's
 * answer, 2026-11-02: favicons only for links the person added, fetched by
 * the Inbox, served from its own origin). The window's CSP stays
 * `img-src 'self' data: blob:`, so it never loads a remote image itself: a
 * remote image in an agent's text stays blocked, and a link an agent added
 * never makes this computer ask its host for anything (the route refuses it
 * before this module is reached).
 *
 * What is fetched: `https://<host>/favicon.ico` and nothing else (no page,
 * no `<link rel=icon>`), with no cookies or credentials, the referrer and
 * user agent of the Inbox's own fetch only.
 * - https only, on the link's own host; a redirect may stay on that host
 *   (same name and port, https), at most 3 hops; any other is a miss.
 * - Never a host that is an IP literal, `localhost`, a one-label name or
 *   `.local`, or a name that resolves to a loopback, private, link-local,
 *   CGNAT, multicast or reserved address. TLS checks the certificate against
 *   the name, so a name that resolves elsewhere between the check and the
 *   fetch (rebinding) still fails there.
 * - One deadline for the whole fetch, redirects and body (3 s); at most
 *   64 KB, by `content-length` or counted as it streams.
 * - Only an image: the response's `content-type` must be `image/*`, and its
 *   bytes must sniff as ICO, PNG, GIF, JPEG, WebP, BMP or AVIF; never SVG
 *   (served from the Inbox's origin, an SVG opened as a page could run script).
 * Results are cached per host, misses included: a hit for a day, a miss for
 * an hour, at most 500 hosts (the oldest dropped first), and one fetch at a
 * time per host.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sniffImageContentType } from "@plannotator/shared/review-image";

/** Why a favicon is not served. */
export type CardFaviconMiss = "not_https" | "not_public" | "redirect_off_host" | "too_many_redirects" | "status" | "not_image" | "too_big" | "timeout" | "unavailable";

export type CardFaviconResult = { ok: true; type: string; body: Uint8Array<ArrayBuffer> } | { ok: false; miss: CardFaviconMiss };

export interface CardFaviconOptions {
  /** Tests: the fetch used (default the runtime's). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Tests: a name's addresses (default `dns.lookup`, every address). */
  lookup?: (hostname: string) => Promise<string[]>;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  hitTtlMs?: number;
  missTtlMs?: number;
  maxHosts?: number;
}

export const CARD_FAVICON_TIMEOUT_MS = 3000;
export const CARD_FAVICON_MAX_BYTES = 64 * 1024;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_HOSTS = 500;
const MAX_REDIRECTS = 3;
const SERVED_TYPES = new Set(["image/x-icon", "image/png", "image/gif", "image/jpeg", "image/webp", "image/bmp", "image/avif"]);

export interface CardFavicons {
  /** The favicon of `https://<host>/` (`host` as a URL writes it: name and any port). */
  get(host: string): Promise<CardFaviconResult>;
}

export function createCardFavicons(options: CardFaviconOptions = {}): CardFavicons {
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  const lookup = options.lookup ?? (async (hostname: string) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? CARD_FAVICON_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? CARD_FAVICON_MAX_BYTES;
  const hitTtl = options.hitTtlMs ?? HIT_TTL_MS;
  const missTtl = options.missTtlMs ?? MISS_TTL_MS;
  const maxHosts = options.maxHosts ?? MAX_HOSTS;
  const cache = new Map<string, { at: number; result: CardFaviconResult }>();
  const inFlight = new Map<string, Promise<CardFaviconResult>>();

  const remember = (host: string, result: CardFaviconResult) => {
    cache.delete(host);
    cache.set(host, { at: now(), result });
    while (cache.size > maxHosts) cache.delete(cache.keys().next().value!);
  };

  async function load(host: string): Promise<CardFaviconResult> {
    let start: URL;
    try {
      start = new URL(`https://${host}/favicon.ico`);
    } catch {
      return { ok: false, miss: "not_https" };
    }
    if (start.host !== host || start.username || start.password) return { ok: false, miss: "not_https" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Every wait (the name's lookup, the response, each chunk of its body) ends at the one deadline.
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
    aborted.catch(() => {});
    const deadline = <T,>(work: Promise<T>): Promise<T> => Promise.race([work, aborted]);
    try {
      if (!(await deadline(isPublicName(start.hostname, lookup)))) return { ok: false, miss: "not_public" };
      let url = start;
      for (let hop = 0; ; hop++) {
        const response = await deadline(
          fetchImpl(url.href, {
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            headers: { accept: "image/*" },
            signal: controller.signal,
          }),
        );
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => {});
          const location = response.headers.get("location");
          if (!location) return { ok: false, miss: "status" };
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            return { ok: false, miss: "redirect_off_host" };
          }
          if (next.protocol !== "https:" || next.host !== start.host || next.username || next.password) return { ok: false, miss: "redirect_off_host" };
          if (hop + 1 > MAX_REDIRECTS) return { ok: false, miss: "too_many_redirects" };
          url = next;
          continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => {});
          return { ok: false, miss: "status" };
        }
        const declared = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!declared.startsWith("image/") || declared === "image/svg+xml") {
          await response.body?.cancel().catch(() => {});
          return { ok: false, miss: "not_image" };
        }
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > maxBytes) {
          await response.body?.cancel().catch(() => {});
          return { ok: false, miss: "too_big" };
        }
        const body = await readCapped(response, maxBytes, deadline);
        if (!body) return { ok: false, miss: "too_big" };
        const type = sniffImageContentType(body);
        if (!type || !SERVED_TYPES.has(type)) return { ok: false, miss: "not_image" };
        return { ok: true, type, body };
      }
    } catch {
      return { ok: false, miss: controller.signal.aborted ? "timeout" : "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get(host) {
      const key = host.toLowerCase();
      const cached = cache.get(key);
      if (cached && now() - cached.at < (cached.result.ok ? hitTtl : missTtl)) return cached.result;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const run = load(key)
        .then((result) => {
          remember(key, result);
          return result;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, run);
      return run;
    },
  };
}

/** The body, or null once it passes `max` bytes (the rest is not read). */
async function readCapped(response: Response, max: number, deadline: <T>(work: Promise<T>) => Promise<T>): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await deadline(reader.read());
    } catch (error) {
      reader.cancel().catch(() => {});
      throw error;
    }
    const { done, value } = chunk;
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Whether `hostname` is a public DNS name: not an IP literal or a local name, and every address it resolves to public. */
async function isPublicName(hostname: string, lookup: (hostname: string) => Promise<string[]>): Promise<boolean> {
  const name = hostname.replace(/\.$/, "").toLowerCase();
  if (!name.includes(".") || name.startsWith("[") || isIP(name) !== 0) return false;
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal") || name.endsWith(".home.arpa")) return false;
  let addresses: string[];
  try {
    addresses = await lookup(name);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(isPublicAddress);
}

/** Whether an IP address is a public unicast one (not loopback, private, link-local, CGNAT, multicast or reserved). */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicV4(address);
  if (version !== 6) return false;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicV4(mapped[1]!);
  if (lower.startsWith("::ffff:")) return false;
  if (lower === "::" || lower === "::1") return false;
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, 64:ff9b::/96 NAT64, 2001:db8::/32 documentation.
  if (/^f[c-d]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8:")) return false;
  return true;
}

function isPublicV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number) as [number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT (Tailscale's addresses among them)
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && address.startsWith("192.0.0.")) || (b === 0 && address.startsWith("192.0.2.")))) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}
