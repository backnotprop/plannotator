/**
 * The image preview of code review on the Inbox's diffs (review parity B2): the review app's own `ImageDiffPreview`
 * asks `/api/review-image?path&side&snapshot`; these send that read to the Inbox's routes for one diff
 * (packages/server/inbox-review-image.ts), the rest of the query as it was, as `pullRepoFetch` does for All files.
 * Anything else is refused, never fetched. Plain data, passed as `ReaderPart` `images` (lazyParts.tsx), which the
 * reader reads from `ReviewImagesContext`: no review-editor code here, so the pages that pass it load none until the
 * reader's own chunk does.
 *
 * A diff on another linked machine gets none (its door does not carry these routes): its images stay as before.
 */
import { createContext } from 'react';
import { inboxUrl, machineOf, selfMachineId } from './inboxUrl';
import { pullMachine, pullUrl } from './pulls/pullMachines';
import type { GuideReaderImages } from './guide/types';

function imageFetch(route: (query: string) => string): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const asked = /^\/api\/review-image\?(.*)$/.exec(url);
    if (!asked) return Promise.reject(new Error('The image could not be read.'));
    return globalThis.fetch(route(asked[1]!), init);
  }) as typeof fetch;
}

/**
 * A rendered Markdown file's pictures are `<img src>`s, not reads: code review's `/api/review-markdown-image?…` URL
 * turned into the host's route, the rest of the query as it was. Anything else is never asked (an empty picture).
 */
function markdownImageRoute(route: (query: string) => string): (url: string) => string {
  return (url) => {
    const asked = /^\/api\/review-markdown-image\?(.*)$/.exec(url);
    return asked ? route(asked[1]!) : 'data:,';
  };
}

/** Where the reader inside reads its images (`ReaderPart` provides it). Absent: no image previews. */
export const ReviewImagesContext = createContext<GuideReaderImages | undefined>(undefined);

const here = (machine: string | null) => !machine || machine === selfMachineId();

/**
 * A pull request's diff in `scope` (and `from`), read at `head`: the snapshot is that head, so a diff read again at
 * another head never shows the last one's pictures. No head (it moved while the diff was read): none.
 */
export function pullReviewImages(key: string, scope: string, from: string | undefined, head: string | null): GuideReaderImages | undefined {
  if (!head || !here(pullMachine(key))) return undefined;
  const scoped = `scope=${encodeURIComponent(scope)}${from ? `&from=${encodeURIComponent(from)}` : ''}`;
  return {
    // The review app's caches key by snapshot id: this diff's own, never another review's.
    snapshotId: `inbox:pull:${key}:${scope}:${from ?? ''}:${head}`,
    fetchImpl: imageFetch((query) => pullUrl('/pulls/review-image', key, `${scoped}&${query.replace(/(^|&)snapshot=[^&]*/, '$1snapshot=' + head)}`)),
    markdownImageUrl: markdownImageRoute((query) => pullUrl('/pulls/review-markdown-image', key, `${scoped}&${query.replace(/(^|&)snapshot=[^&]*/, '$1snapshot=' + head)}`)),
  };
}

/** A guided review on a message: its patch as the agent sent it, which never changes, so the message is the snapshot. */
export function guideReviewImages(messageId: string): GuideReaderImages | undefined {
  if (!here(machineOf(messageId))) return undefined;
  return {
    snapshotId: `inbox:guide:${messageId}`,
    fetchImpl: imageFetch((query) => inboxUrl(`/messages/${encodeURIComponent(messageId)}/guide/review-image`, query.replace(/(^|&)snapshot=[^&]*/, `$1snapshot=${encodeURIComponent(messageId)}`))),
    markdownImageUrl: markdownImageRoute((query) => inboxUrl(`/messages/${encodeURIComponent(messageId)}/guide/review-markdown-image`, query.replace(/(^|&)snapshot=[^&]*/, `$1snapshot=${encodeURIComponent(messageId)}`))),
  };
}
