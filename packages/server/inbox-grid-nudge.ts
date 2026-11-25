/**
 * What a list row carries for Grid's Nudge (approval "inbox-agent-grid", round 4), on this Inbox's own rows of a read
 * that asks for Grid: the message a nudge replies to, and the thread's last nudge. A linked computer's rows carry their
 * own, from there, so a nudge from here goes into that computer's thread through the reply route's usual forward (held
 * while that computer is away, written once by its idempotency key).
 *
 * The nudge is an ordinary reply from the person (the reply route, its wake), its words the window's. Its reply target
 * is the one a typed reply's words take (core `inboxWordsDefault`: the newest agent message that is not a permission
 * prompt's or a routine's change line), else the thread's first message (a thread the person started that no agent
 * answered: the reply goes to the session it names). Only the thread's last `GRID_NUDGE_WALK` messages are read, so a
 * list read costs O(rows), not O(messages).
 */
import { inboxWordsDefault, type InboxListRow, type InboxMessage } from "@plannotator/core/inbox-types";

/** How many of a thread's newest messages the reader looks at. */
export const GRID_NUDGE_WALK = 60;

export type GridNudgeRow = NonNullable<InboxListRow["grid_nudge"]>;

export function gridNudgeReader(store: { threadMessageIds(threadId: string): readonly string[]; message(id: string): InboxMessage | null }): (threadId: string) => GridNudgeRow | undefined {
  return (threadId) => {
    const ids = store.threadMessageIds(threadId);
    if (ids.length === 0) return undefined;
    const recent = ids.slice(-GRID_NUDGE_WALK).flatMap((id) => {
      const message = store.message(id);
      return message && !message.taken_back_at ? [message] : [];
    });
    const target = inboxWordsDefault(recent, () => false) ?? store.message(ids[0]!);
    if (!target) return undefined;
    let last: GridNudgeRow["last"] = null;
    for (let i = recent.length - 1; i >= 0; i--) {
      const message = recent[i]!;
      if (message.author.kind !== "person" || !message.nudge) continue;
      const answer = recent.slice(i + 1).find((later) => later.author.kind === "agent");
      last = { at: message.created_at, quiet_from: message.nudge.quiet_from, answered_at: answer?.created_at ?? null };
      break;
    }
    return { to: target.id, last };
  };
}
