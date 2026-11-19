/**
 * The link preview as an HTTP route and as the client that calls it.
 *
 *   GET <path>?url=<address>   →   200 { url, title?, description?, site?, image?, icon? }
 *                                  204 when the address cannot be previewed
 *
 * `createUnfurlHandler` is a plain `(Request) => Response`, so either server
 * runtime can mount it. In this change only the development demo does
 * (`demo/vite.config.ts`). When it becomes a product endpoint it goes into
 * both the Bun server and the Pi server, per the two-runtimes rule.
 *
 * `routeLinkPreview` is the other half: the `LinkPreviewPort` an editor is
 * given, which asks that route.
 */
import { type UnfurlOptions, createUnfurler } from './fetch';
import type { LinkPreview } from './parse';

/** How the canvas asks for a page's preview. The editor knows nothing about how it is fetched. */
export type LinkPreviewPort = (url: string, signal?: AbortSignal) => Promise<LinkPreview | null>;

export function createUnfurlHandler(options: UnfurlOptions & { cacheSize?: number; cacheMs?: number } = {}): (request: Request) => Promise<Response> {
  const unfurl = createUnfurler(options);
  return async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
    const address = new URL(request.url).searchParams.get('url') ?? '';
    const preview = await unfurl(address);
    if (!preview) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(preview), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=600', 'x-content-type-options': 'nosniff' } });
  };
}

/** A `LinkPreviewPort` over a server route. A failed request is no preview, never an error for the person. */
export function routeLinkPreview(path: string): LinkPreviewPort {
  return async (url, signal) => {
    try {
      const response = await fetch(`${path}?url=${encodeURIComponent(url)}`, { signal });
      if (response.status !== 200) return null;
      return (await response.json()) as LinkPreview;
    } catch {
      return null;
    }
  };
}
