/**
 * Where an issue / PR / MR hover card's data comes from (`components/RefHoverCard`).
 *
 * A host seam in the `configurePlannotatorUI` style: the default is NO
 * transport, so a host that installs none (every `@plannotator/ui` consumer
 * that does not opt in) draws no card and makes no request: byte for byte as
 * before. A host that can fetch installs one with `setRefCardTransport` or
 * `configurePlannotatorUI({ refCardTransport })`: the Inbox over its
 * `/api/inbox/ref` route, plan review, annotate and code review over
 * `GET /api/ref` (`refCardRouteTransport` below).
 *
 * The client keeps answers for `REF_CARD_CLIENT_FRESH_MS` per ref and shares
 * one request between hovers of the same ref. The server keeps its own cache;
 * this one only spares the round trip while a person moves between links.
 */

import { forgeRefKey, parseForgeRefUrl, type ForgeRef, type ForgeRefCardResult } from '@plannotator/core/forge-ref-card';

export type { ForgeRef, ForgeRefCardResult } from '@plannotator/core/forge-ref-card';

/** Fetch the card for a link. Resolve null when the host does not read that link. */
export type RefCardTransport = (href: string, ref: ForgeRef, signal: AbortSignal) => Promise<ForgeRefCardResult | null>;

let transport: RefCardTransport | null = null;

export function setRefCardTransport(next: RefCardTransport | null): void {
  transport = next;
  cache.clear();
}

export function getRefCardTransport(): RefCardTransport | null {
  return transport;
}

/**
 * A transport over a server route answering like Plannotator's `GET /api/ref`
 * (and the Inbox's `/api/inbox/ref`): `?url=<link>` → `{ ok, data | error,
 * fetchedAt }`. A 404 means the route is not there (an older server) or is off
 * (a session other devices can reach): the transport then stops asking for
 * the life of the page and answers null. Any other failure answers null.
 */
export function refCardRouteTransport(route: string): RefCardTransport {
  let off = false;
  return async (href, _ref, signal) => {
    if (off) return null;
    const res = await fetch(`${route}?url=${encodeURIComponent(href)}`, { signal, headers: { accept: 'application/json' } });
    if (res.status === 404) {
      off = true;
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return body && typeof body === 'object' && typeof (body as { ok?: unknown }).ok === 'boolean' ? (body as ForgeRefCardResult) : null;
  };
}

export const REF_CARD_CLIENT_FRESH_MS = 30_000;

const cache = new Map<string, { at: number; promise: Promise<ForgeRefCardResult | null> }>();

/** The ref a link names, when a transport is installed to fetch it; else null (no card). */
export function refCardTarget(href: string | null | undefined): ForgeRef | null {
  if (!transport || !href) return null;
  return parseForgeRefUrl(href);
}

/** The card for a link, through the installed transport (shared and cached per ref). */
export function loadRefCard(href: string, ref: ForgeRef): Promise<ForgeRefCardResult | null> {
  const t = transport;
  if (!t) return Promise.resolve(null);
  const key = forgeRefKey(ref);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < REF_CARD_CLIENT_FRESH_MS) return hit.promise;
  // Never aborted by one hover leaving: another hover may share it, and the server caches it anyway.
  const controller = new AbortController();
  const promise = t(href, ref, controller.signal).catch(() => null);
  cache.set(key, { at: Date.now(), promise });
  void promise.then((r) => {
    if (!r) cache.delete(key);
  });
  return promise;
}
