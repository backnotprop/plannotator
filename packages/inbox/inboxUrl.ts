/**
 * The one place the Inbox window writes a server URL. Every `/api/inbox/...`
 * request, EventSource and attachment `src` goes through `inboxUrl`, so a later
 * change (routing another machine's threads) touches this file alone.
 * `tests/inbox-url-helper.test.ts` fails on a raw `/api/inbox` string elsewhere.
 */

/** `path` is the part after `/api/inbox` and starts with `/`; `query` is already encoded, without the `?`. */
export function inboxUrl(path: string, query?: string): string {
  return `/api/inbox${path}${query ? `?${query}` : ''}`;
}
