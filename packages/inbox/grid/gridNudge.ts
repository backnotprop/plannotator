/**
 * Nudge (approval "inbox-agent-grid", round 4): one press on a stale line sends its agent the nudge's words as the
 * person's reply in the work's own thread (the reply route; on another computer's thread, through its forward and the
 * outbox: held while that computer is away, written once). No dialog, no confirmation. The reply's idempotency key
 * (grid-nudge-key.ts) names the thread, its quiet stretch on the thread's clock, the three-hour turn and the nudges taken
 * back, so a second press, a second window or a held copy writes one nudge, and a press after a Take back writes anew.
 *
 * The line says "Nudged just now" at once from this window's press; a nudge held for an away computer is in the
 * outbox, which every window of this Inbox holds (gridInput.ts), and a sent one in the thread's row
 * (`grid_nudge.last`), so it reads the same everywhere and after a reload.
 */
import { useCallback, useState } from 'react';
import type { GridAction, GridLine } from '../../shared/inbox/grid';
import { gridNudgeWords } from '../../shared/inbox/grid-nudge';
import { gridNudgeKey } from '../../shared/inbox/grid-nudge-key';
import { apiPost, InboxApiError, InboxHeldError } from '../api';
import { inboxUrl } from '../inboxUrl';

export type GridNudgeAction = Extract<GridAction, { kind: 'nudge' }>;

/** A nudge this window sent: when, which press (`press`), and how it went (`held`: the outbox's words; `failed`: why it was not sent). */
export interface GridNudgeSent {
  at: number;
  press: string;
  held: string | null;
  failed: string | null;
}

export const gridNudgeOf = (line: GridLine): GridNudgeAction | null => line.actions.find((a): a is GridNudgeAction => a.kind === 'nudge') ?? null;

/** Which press an action is, on this computer's clock: the same stretch, turn and take-backs are the same press. */
export const gridNudgePress = (action: GridNudgeAction): string => gridNudgeKey({ thread: action.thread, quietFrom: action.quietFrom, turn: action.turn, taken: action.taken });

/** The nudge's request: the reply route on the thread's own computer, its words and its mark. `clock`: that computer's clock against this one's (ms ahead). */
export function sendGridNudge(line: GridLine, action: GridNudgeAction, words: string, clock: number): Promise<unknown> {
  // On the thread's own clock, so windows on computers whose clocks differ make one key.
  const from = action.quietFrom + clock;
  return apiPost(inboxUrl(`/messages/${encodeURIComponent(action.to)}/reply`, undefined, line.machine), {
    idempotency_key: gridNudgeKey({ thread: action.thread, quietFrom: from, turn: action.turn, taken: action.taken }),
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
      const mark: GridNudgeSent = { at: now, press: gridNudgePress(action), held: null, failed: null };
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
