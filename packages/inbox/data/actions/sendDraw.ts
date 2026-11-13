/**
 * A Send drawn in its thread the moment it is pressed (live rule R5: your own action at once), while its replies,
 * and the saves they wait for, are on their way. Its pending mutation is the drawing (as rows.ts's row writes are):
 *  - the reply that carries the words lands: the pane draws it from the Send's answer, then the drawing goes;
 *  - the Send stops or fails (a refusal, no answer, a guard): the drawing goes by itself (a lost answer: once the
 *    thread read says whether the reply went, sendLanded.ts), and the words never left
 *    the box, which says why (Thread.tsx's Send keeps them there until a reply carrying them landed).
 * Only the words are drawn ("Sending…" in place of the delivery line, as a reply held for another machine is,
 * HeldWrites.tsx): the server writes the rest of the reply (its answers, tags, files), so they show once it lands.
 *
 * Safe to draw before the server answers: each reply of a Send carries an idempotency key kept across retries, and
 * a Send whose answer was lost looks for its reply by that key before it sends again, so what is drawn never posts
 * twice; the drawing only says what is on its way.
 */
import { useMutation, useMutationState } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useInboxQueryClient } from '../client';
import { inboxKeys } from '../keys';

export interface SendDrawn {
  threadId: string;
  /** One per drawing: its key on screen. */
  key: string;
  words: string;
  /** The person's replies in the thread when it was pressed: once as many beyond these as the Send's replies (`goesAs`, one until known), the one with the words landed. */
  repliesBefore: number;
}

interface SendDraw extends SendDrawn {
  until: Promise<void>;
}

/** One drawing on its way: `landed` once the sent reply is drawn from the answer, `stopped` when nothing (or not the words) went. */
export interface SendDrawing {
  landed: () => void;
  stopped: () => void;
  goesAs: (replies: number) => number;
}

/** The person's replies in a thread (a Send's reply landed: one more). */
export const personReplies = (thread: { messages: readonly { author: { kind: string } }[] }): number => thread.messages.filter((m) => m.author.kind === 'person').length;

const NOTHING: SendDrawing = { landed: () => {}, stopped: () => {}, goesAs: (replies) => replies };
let drawings = 0;
const repliesOf = new Map<string, number>();

export function useDrawSend(): (drawn: Omit<SendDrawn, 'key'>) => SendDrawing {
  const client = useInboxQueryClient();
  const { mutate } = useMutation<void, Error, SendDraw>({ mutationKey: inboxKeys.sendDraw(), mutationFn: (draw) => draw.until }, client);
  return useCallback(
    (drawn) => {
      if (drawn.words === '') return NOTHING;
      let landed = () => {};
      let stopped = () => {};
      const key = `send-${++drawings}`;
      const until = new Promise<void>((resolve, reject) => {
        landed = () => resolve();
        stopped = () => reject(new Error('send stopped'));
      }).finally(() => repliesOf.delete(key));
      mutate({ ...drawn, key, until });
      const goesAs = (replies: number) => {
        repliesOf.set(key, replies);
        return replies;
      };
      return { landed, stopped, goesAs };
    },
    [mutate],
  );
}

/** The Sends drawn in this thread now, oldest first; one whose reply is in the thread already is not drawn twice. */
export function useSendsDrawn(threadId: string, personReplies: number): readonly SendDrawn[] {
  const client = useInboxQueryClient();
  const drawn = useMutationState({ filters: { mutationKey: inboxKeys.sendDraw(), status: 'pending' }, select: (m) => m.state.variables as SendDraw }, client);
  return useMemo(() => drawn.filter((d) => d.threadId === threadId && personReplies < d.repliesBefore + (repliesOf.get(d.key) ?? 1)), [drawn, threadId, personReplies]);
}
