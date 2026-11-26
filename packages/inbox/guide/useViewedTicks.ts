/**
 * A review's Viewed ticks in its pane: what its Inbox keeps, each tick shown at once, and the held ones (its machine
 * away) laid over (`viewedWithHeld`). A tick is never kept unconfirmed: one that failed goes back at once; one held
 * goes back when its outbox entry settles as anything but delivered (refused there, dropped with its link). A newer
 * tick of the same file wins over an older one's answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OutboxView } from '@plannotator/core/inbox-wire-models';
import { InboxHeldError, inboxApi } from '../api';
import { viewedWithHeld } from './heldViewed';

type Save = (messageId: string, path: string, viewed: boolean) => Promise<{ viewed: string[] }>;
type Tick = { path: string; on: boolean; seq: number };

export function useViewedTicks(
  messageId: string,
  kept: readonly string[] | null | undefined,
  outbox: ReadonlyMap<string, OutboxView> | null | undefined,
  onError: (words: string) => void,
  save: Save = inboxApi.saveGuideViewed,
): { shown: string[]; toggle: (path: string) => void } {
  const [viewed, setViewed] = useState<string[]>(() => [...(kept ?? [])]);
  useEffect(() => setViewed([...(kept ?? [])]), [messageId]); // eslint-disable-line react-hooks/exhaustive-deps
  const seq = useRef(0);
  /** Each file's newest tick. */
  const newest = useRef(new Map<string, number>());
  /** Held ticks by their outbox entry's key. */
  const held = useRef(new Map<string, Tick>());
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

  const undo = useCallback((tick: Tick) => {
    if (newest.current.get(tick.path) !== tick.seq) return;
    setViewed((now) => (tick.on ? now.filter((p) => p !== tick.path) : [...now.filter((p) => p !== tick.path), tick.path]));
  }, []);
  const settle = useCallback(() => {
    for (const [key, tick] of held.current) {
      const entry = outboxRef.current?.get(key);
      if (!entry || entry.state === 'queued' || entry.state === 'sending') continue;
      held.current.delete(key);
      if (entry.state !== 'delivered') undo(tick);
    }
  }, [undo]);
  useEffect(settle, [outbox, settle]);

  const shown = useMemo(() => viewedWithHeld(viewed, outbox, messageId), [viewed, outbox, messageId]);
  const toggle = useCallback(
    (path: string) => {
      // One file's change, never the whole list: a tick that waits never undoes another made since.
      const tick = { path, on: !shown.includes(path), seq: ++seq.current };
      newest.current.set(path, tick.seq);
      setViewed((now) => (tick.on ? [...now.filter((p) => p !== path), path] : now.filter((p) => p !== path)));
      save(messageId, path, tick.on).then(
        (saved) => setViewed(saved.viewed),
        (cause: unknown) => {
          // Held for a machine that is away: not a failure. It shows (the outbox's entry) until it settles.
          if (cause instanceof InboxHeldError) {
            held.current.set(cause.outbox.key, tick);
            settle();
            return;
          }
          undo(tick);
          onError(cause instanceof Error ? cause.message : 'The Viewed tick was not saved.');
        },
      );
    },
    [shown, messageId, save, onError, settle, undo],
  );
  return { shown, toggle };
}
