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
 * The other half, the `LinkPreviewPort` an editor is given, is
 * `routeLinkPreview` in `react/link-preview.ts`. Nothing under `unfurl/` is
 * meant for a browser bundle.
 */
import { type UnfurlOptions, createUnfurler } from './fetch';

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
