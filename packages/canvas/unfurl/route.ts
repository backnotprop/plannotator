/**
 * The link preview as an HTTP route and as the client that calls it.
 *
 *   GET <path>?url=<address>   →   200 { url, title?, description?, site?, image?, icon? }
 *                                  204 when the address cannot be previewed
 *
 * `createUnfurlHandler` is a plain `(Request) => Response`, so either server
 * runtime can mount it. It throws when its options cannot keep private
 * addresses out (`unfurlFault`): under Node it needs a `pin`. In this change only the development demo does
 * (`demo/vite.config.ts`). When it becomes a product endpoint it goes into
 * both the Bun server and the Pi server, per the two-runtimes rule.
 *
 * The other half, the `LinkPreviewPort` an editor is given, is
 * `routeLinkPreview` in `react/link-preview.ts`. Nothing under `unfurl/` is
 * meant for a browser bundle.
 */
import { type UnfurlOptions, createUnfurler } from './fetch';

/**
 * Whether a request's `Host` header names this machine itself: `localhost`,
 * `127.0.0.1` or `[::1]`, with any port. A server that listens on loopback
 * and answers for its person alone checks this before a route that reads
 * the local network (`allowPrivate: true`): a page on another site can make
 * the browser call a name that it has pointed at 127.0.0.1 (DNS rebinding),
 * and then read the answer as its own. Such a request still says the other
 * site's name here.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (typeof host !== 'string' || host.length > 255) return false;
  const name = host.trim().toLowerCase().replace(/:\d{1,5}$/, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

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
