/**
 * Nudge (approval "inbox-agent-grid", round 4): one press on a stale line sends its agent the nudge's words as the
 * person's reply in the work's own thread (the reply route; on another computer's thread, through its forward and the
 * outbox: held while that computer is away, written once). No dialog, no confirmation. The reply is keyed by the
 * line's quiet stretch (`GridAction` "nudge"'s `key`), so a second press, a second window or a held copy writes one
 * nudge. The line says "Nudged just now" at once; once the thread's row carries the nudge (`grid_nudge.last`), the
 * row says it.
 */
import { useCallback, useState } from 'react';
import type { GridAction, GridLine } from '../../shared/inbox/grid';
import { gridNudgeWords } from '../../shared/inbox/grid-nudge';
import { apiPost, InboxApiError, InboxHeldError } from '../api';
import { inboxUrl } from '../inboxUrl';

export type GridNudgeAction = Extract<GridAction, { kind: 'nudge' }>;

/** A nudge this window sent: when, under which key, and how it went (`held`: the words a held write says; `failed`: why it was not sent). */
export interface GridNudgeSent {
  at: number;
  key: string;
  held: string | null;
  failed: string | null;
}

export const gridNudgeOf = (line: GridLine): GridNudgeAction | null => line.actions.find((a): a is GridNudgeAction => a.kind === 'nudge') ?? null;

/** The nudge's request: the reply route on the thread's own computer, its words and its mark. `clock`: that computer's clock against this one's (ms ahead). */
export function sendGridNudge(line: GridLine, action: GridNudgeAction, words: string, clock: number): Promise<unknown> {
  // The key on the thread's own clock, so windows on computers whose clocks differ still write one nudge.
  const from = action.quietFrom + clock;
  return apiPost(inboxUrl(`/messages/${encodeURIComponent(action.to)}/reply`, undefined, line.machine), {
    idempotency_key: `grid-nudge-${action.thread}-${from}-${action.key.slice(action.key.lastIndexOf('-') + 1)}`,
    words,
    questions: [],
    // What the person saw (the row's newest seq there): an agent message since refuses it, and a linked computer's reply must carry it.
    seen_through_seq: action.seq,
    nudge: { quiet_from: new Date(from).toISOString() },
  });
}

/**
 * The nudges this window sent, by line, and the press. `at` says a time as the line does; `clockOf` gives a computer's
 * clock against this one's; `onSent` is told as the press goes (the motion's nudge along the bar).
 */
export function useGridNudge(at: (ms: number) => string, clockOf: (machine: string | null) => number, onSent: (line: string) => void) {
  const [sent, setSent] = useState<ReadonlyMap<string, GridNudgeSent>>(() => new Map());
  const put = (id: string, value: GridNudgeSent) => setSent((was) => new Map(was).set(id, value));
  const nudge = useCallback(
    (line: GridLine) => {
      const action = gridNudgeOf(line);
      if (!action) return;
      const now = Date.now();
      const mark: GridNudgeSent = { at: now, key: action.key, held: null, failed: null };
      put(line.id, mark);
      onSent(line.id);
      sendGridNudge(line, action, gridNudgeWords(line, now, at), clockOf(line.machine)).then(
        () => undefined,
        (cause: unknown) => {
          if (cause instanceof InboxHeldError) put(line.id, { ...mark, held: cause.message });
          else put(line.id, { ...mark, failed: cause instanceof InboxApiError ? cause.message : 'The nudge was not sent.' });
        },
      );
    },
    [at, clockOf, onSent],
  );
  return { sent, nudge };
}
