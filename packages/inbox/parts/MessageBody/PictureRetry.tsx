/**
 * A picture of a message body that failed to load is tried again (ui's `ImageRetryContext`): an agent may name a
 * picture before it writes it, and the Inbox's image route reads the file on each request. Tried again:
 *
 * - when the message's captured pictures change (`inline_images`: the Inbox read the file after a later read of
 *   the thread, usually the next message);
 * - when its thread gains a message (often the one whose agent just wrote the file);
 * - after a failure, at `DELAYS_MS` while the window is visible (while hidden the next try waits until
 *   the window is shown): at most that many times per drawn body, then only on the changes above.
 *
 * Only this message's own pictures (`retries`), only while one is failed: a body whose pictures all load costs
 * nothing, and each try is one request per failed picture. The placeholder stays until a picture loads.
 */
import { hashKey } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ImageRetryContext, type ImageRetry } from '@plannotator/ui/components/ImageResolverContext';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { useInboxQueryClient } from '../../data/client';
import type { HeldThread } from '../../data/apply/record';
import { inboxKeys } from '../../data/keys';

/** After a failure: tries at about 2 s, 6 s, 14 s, 29 s, 59 s and 2 min, then no more on a timer. */
const DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000];
let delays = DELAYS_MS;

/** For tests: shorter waits (null puts the real ones back). */
export function setPictureRetryDelaysForTests(next: readonly number[] | null): void {
  delays = next ?? DELAYS_MS;
}

const FAILED = 'img[data-image-failed]';

/** A new message in the thread: its count and newest id. */
function threadMark(held: HeldThread | undefined): string {
  const messages = held?.thread?.messages;
  return messages ? `${messages.length}:${messages.at(-1)?.id ?? ''}` : '';
}

export function PictureRetry({ bodyRef, message, retries, children }: { bodyRef: RefObject<HTMLElement | null>; message: InboxMessageWire; retries: (src: string) => boolean; children: ReactNode }) {
  const client = useInboxQueryClient();
  const [failing, setFailing] = useState(false);
  const [tick, setTick] = useState(0);
  const tried = useRef(0);
  const captured = (message.inline_images ?? []).map((image) => image.ref).join('\n');
  const threadId = message.thread_id;

  // Error does not bubble: a capture listener on the body hears each picture that failed.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onError = (event: Event) => {
      if (event.target instanceof HTMLImageElement) setFailing(true);
    };
    body.addEventListener('error', onError, true);
    return () => body.removeEventListener('error', onError, true);
  }, [bodyRef]);

  useEffect(() => {
    if (!failing) return;
    const stillFailed = () => !!bodyRef.current?.querySelector(FAILED);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingToBeSeen = false;
    const schedule = () => {
      const wait = delays[tried.current];
      if (wait !== undefined) timer = setTimeout(fire, wait);
    };
    const fire = () => {
      timer = undefined;
      if (!stillFailed()) return setFailing(false);
      if (document.visibilityState === 'hidden') {
        waitingToBeSeen = true;
        return;
      }
      tried.current += 1;
      setTick((n) => n + 1);
      schedule();
    };
    const onVisible = () => {
      if (waitingToBeSeen && document.visibilityState !== 'hidden') {
        waitingToBeSeen = false;
        fire();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    // The thread gains a message: one more try, timer or not.
    const watched = inboxKeys.thread(threadId);
    const hash = hashKey(watched);
    let mark = threadMark(client.getQueryData<HeldThread>(watched));
    const stopWatching = client.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== hash) return;
      const next = threadMark(event.query.state.data as HeldThread | undefined);
      if (next === mark) return;
      mark = next;
      if (!stillFailed()) return setFailing(false);
      setTick((n) => n + 1);
    });
    schedule();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      stopWatching();
    };
  }, [failing, bodyRef, client, threadId]);

  const retryRef = useRef(retries);
  retryRef.current = retries;
  const value = useMemo<ImageRetry>(() => ({ key: `${tick}\n${captured}`, retries: (src) => retryRef.current(src) }), [tick, captured]);
  return <ImageRetryContext.Provider value={value}>{children}</ImageRetryContext.Provider>;
}
