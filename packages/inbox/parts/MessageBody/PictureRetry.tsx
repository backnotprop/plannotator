/**
 * A picture of a message body that failed to load is tried again (ui's `ImageRetryContext`): an agent may name a
 * picture before it writes it, and the Inbox's image route reads the file on each request. Tried again:
 *
 * - when the message's captured pictures change (`inline_images`: the Inbox read the file after a later read of
 *   the thread, usually the next message), at any age;
 * - only while the message is recent (`RECENT_MS`), at most `DELAYS_MS.length` times per drawn body in all:
 *   - when its thread gains a message (often the one whose agent just wrote the file);
 *   - after a failure, at `DELAYS_MS`.
 *   Either waits while the window is hidden, and then makes one try when it is shown.
 *
 * Only this message's own pictures (`retries`: never a remote, `data:` or `blob:` one), only while one of them is
 * failed: a body whose pictures load, or whose only failed picture is one it never tries, keeps no timer and no
 * subscription. Each try is one request per failed picture, at most four at a time in the window (ui's
 * `imageRetryProbe.ts`). The placeholder stays until a picture loads.
 */
import { hashKey } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ImageRetryContext, type ImageRetry } from '@plannotator/ui/components/ImageResolverContext';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { useInboxQueryClient } from '../../data/client';
import type { HeldThread } from '../../data/apply/record';
import { inboxKeys } from '../../data/keys';
import { debugLogOn } from '../../debugLog';

/** After a failure: tries at about 2 s, 6 s, 14 s, 29 s, 59 s and 2 min, then no more on a timer. */
const DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000];
let delays = DELAYS_MS;

/**
 * Only a message sent this recently can still have a picture on its way: its agent writes the file within seconds
 * or minutes of the send, and the timer's tries end about 2 minutes after a failure. An older message's failed
 * picture is not asked for again on a timer or a new message (an old thread full of missing pictures costs
 * nothing); a captured record, a reopen or a reload still shows it once the file is there.
 */
export const RECENT_MS = 10 * 60_000;

/** For tests: shorter waits (null puts the real ones back). The number of waits is the budget of tries. */
export function setPictureRetryDelaysForTests(next: readonly number[] | null): void {
  delays = next ?? DELAYS_MS;
}

const FAILED = 'img[data-image-failed]';

/** The thread's message count: an id that changes in place (a reply's held copy, then the saved one) is no gain. */
function messageCount(held: HeldThread | undefined): number {
  return held?.thread?.messages?.length ?? 0;
}

export function PictureRetry({ bodyRef, message, retries, children }: { bodyRef: RefObject<HTMLElement | null>; message: InboxMessageWire; retries: (src: string) => boolean; children: ReactNode }) {
  const client = useInboxQueryClient();
  const [failing, setFailing] = useState(false);
  const [tick, setTick] = useState(0);
  const tried = useRef(0);
  const retryRef = useRef(retries);
  retryRef.current = retries;
  const captured = (message.inline_images ?? []).map((image) => image.ref).join('\n');
  const threadId = message.thread_id;
  const messageId = message.id;
  const sentAt = Date.parse(message.created_at);

  // Error does not bubble: a capture listener on the body hears each picture that failed. Before paint, so one that
  // fails right after it is drawn is heard; and one already failed (a body shown again) counts at once.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (failedHere(body, retryRef.current)) setFailing(true);
    const onError = (event: Event) => {
      const img = event.target;
      if (img instanceof HTMLImageElement && ours(img, retryRef.current)) setFailing(true);
    };
    body.addEventListener('error', onError, true);
    return () => body.removeEventListener('error', onError, true);
  }, [bodyRef]);

  useEffect(() => {
    if (!failing) return;
    // A future time (a clock ahead of the window's) counts as now.
    const left = Math.min(sentAt + RECENT_MS - Date.now(), RECENT_MS);
    if (!(left > 0) || tried.current >= delays.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingToBeSeen = false;
    let stopped = false;
    const schedule = () => {
      const wait = delays[tried.current];
      if (wait !== undefined) timer = setTimeout(() => attempt('timer'), wait);
    };
    const attempt = (why: 'timer' | 'thread' | 'shown') => {
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const body = bodyRef.current;
      if (!body || !failedHere(body, retryRef.current)) {
        stop();
        return setFailing(false);
      }
      if (document.visibilityState === 'hidden') {
        waitingToBeSeen = true;
        return;
      }
      waitingToBeSeen = false;
      tried.current += 1;
      noteTry(messageId, why);
      setTick((n) => n + 1);
      if (tried.current >= delays.length) stop();
      else schedule();
    };
    const onVisible = () => {
      if (waitingToBeSeen && document.visibilityState !== 'hidden') attempt('shown');
    };
    document.addEventListener('visibilitychange', onVisible);
    // The thread gains a message: a try now (one of the same budget), timer or not.
    const watched = inboxKeys.thread(threadId);
    const hash = hashKey(watched);
    let seen = messageCount(client.getQueryData<HeldThread>(watched));
    const stopWatching = client.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== hash) return;
      const count = messageCount(event.query.state.data as HeldThread | undefined);
      if (count <= seen) return;
      seen = count;
      attempt('thread');
    });
    const aged = setTimeout(() => stop(), left);
    function stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      clearTimeout(aged);
      document.removeEventListener('visibilitychange', onVisible);
      stopWatching();
    }
    schedule();
    return stop;
  }, [failing, bodyRef, client, threadId, messageId, sentAt]);

  const value = useMemo<ImageRetry>(() => ({ key: `${tick}\n${captured}`, retries: (src) => retryRef.current(src) }), [tick, captured]);
  return <ImageRetryContext.Provider value={value}>{children}</ImageRetryContext.Provider>;
}

/**
 * Each try, while the Inbox's debug log is on (as perfMarks.ts): a `pn:picture-retry` mark whose detail says the
 * message and what asked (`timer`, `thread`: a new message, `shown`: the window shown again). The browser test reads
 * it to tell the paths apart. Debug off: one boolean check.
 */
function noteTry(message: string, why: 'timer' | 'thread' | 'shown'): void {
  if (!debugLogOn() || typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  performance.mark('pn:picture-retry', { detail: { message, why } });
}

/** A picture this body tries again: one of this message's own image-route URLs. */
function ours(img: Element, retries: (src: string) => boolean): boolean {
  const src = img.getAttribute('src');
  return !!src && retries(src);
}

function failedHere(body: HTMLElement, retries: (src: string) => boolean): boolean {
  for (const img of body.querySelectorAll(FAILED)) if (ours(img, retries)) return true;
  return false;
}
