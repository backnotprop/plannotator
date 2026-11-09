/**
 * The Inbox's transport for issue, PR and MR hover cards and the Links side's
 * states (`/api/inbox/ref`). A window the route refuses (a phone through the
 * device door, where the route is not on the allowlist) asks once, not once a
 * row: until the route has answered, one request runs at a time, and the first
 * refusal (401, 403, 404) stops every ask for the life of the page.
 */

import type { RefCardTransport } from '@plannotator/ui/utils/refCard';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';

const REFUSED = new Set([401, 403, 404]);

export function inboxRefTransport(get: (href: string, signal: AbortSignal) => Promise<Response>): RefCardTransport {
  let off = false;
  let answered = false;
  /** The ask in flight while the route has not answered yet. */
  let probe: Promise<unknown> | null = null;
  return async (href, _ref, signal) => {
    while (!answered && probe) {
      await probe.catch(() => {});
      if (off) return null;
    }
    if (off) return null;
    const ask = get(href, signal);
    if (!answered) {
      const mine = ask.then((res) => {
        if (REFUSED.has(res.status)) off = true;
        else if (res.ok) answered = true;
      });
      probe = mine;
      void mine.finally(() => {
        if (probe === mine) probe = null;
      });
    }
    const res = await ask;
    if (!res.ok) return null;
    return (await res.json()) as ForgeRefCardResult;
  };
}
