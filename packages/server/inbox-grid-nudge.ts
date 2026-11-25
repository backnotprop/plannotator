/**
 * What a list row carries for Grid's Nudge (approval "inbox-agent-grid", round 4), on this Inbox's own rows of a read
 * that asks for Grid (`InboxListRow.grid_nudge`, core `InboxGridNudgeRow`). A linked computer's rows carry their own,
 * from there, so a nudge from here goes into that computer's thread through the reply route's usual forward (held
 * while that computer is away, written once by its idempotency key).
 *
 * The nudge is an ordinary reply from the person (the reply route, its wake), its words the window's. Its reply target
 * is the message a reply typed in the thread would answer, by one rule with the window (core `inboxWordsMessage`: a
 * takeover's reply, a hand-off's new owner, else the newest agent message that is not a permission prompt's or a
 * routine's change line, never a removed agent's), and `agent` is the session that reply reaches, so the button names
 * the agent the nudge goes to. `seq` is the thread's newest seq, which the nudge sends as what the person saw (a linked
 * computer's reply must carry it). `taken`: the thread's nudges taken back, so the next press is a new write.
 *
 * Cost: a row is worked out only when it can go stale (nothing of it waits on the person) or was worked out before,
 * and then only when its thread changed since (`threadVersion`): the whole thread is read once per change, so a
 * hand-off or a removal however far back counts, and an unchanged list read costs one lookup per row.
 */
import { inboxWordsMessage, inboxWordsRecipient, type InboxGridNudgeRow, type InboxListRow, type InboxMessage } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { gridNudgeKeyRead } from "@plannotator/shared/inbox/grid-nudge-key";

export interface GridNudgeStore {
  threadMessageIds(threadId: string): readonly string[];
  message(id: string): InboxMessage | null;
  messageCursor(id: string): number | null;
  threadVersion(threadId: string): string;
}

/** A row that can never be stale: something of it waits on the person (Grid's Needs you). */
export function gridNudgeNeverStale(row: Pick<InboxListRow, "waiting_since" | "section" | "questions">): boolean {
  return !!row.waiting_since || (row.questions?.open ?? 0) > 0 || row.section === "stopped" || row.section === "holding";
}

/** One thread's `grid_nudge`, read from all its messages. */
export function gridNudgeOfThread(store: Pick<GridNudgeStore, "threadMessageIds" | "message" | "messageCursor">, threadId: string): InboxGridNudgeRow | undefined {
  const ids = store.threadMessageIds(threadId);
  if (ids.length === 0) return undefined;
  const all = ids.flatMap((id) => store.message(id) ?? []);
  const messages = all.filter((message) => !message.taken_back_at);
  const target = inboxWordsMessage(messages, () => false);
  if (!target) return undefined;
  let last: InboxGridNudgeRow["last"] = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.author.kind !== "person" || !message.nudge) continue;
    const answer = messages.slice(i + 1).find((later) => later.author.kind === "agent");
    last = { at: message.created_at, quiet_from: message.nudge.quiet_from, answered_at: answer?.created_at ?? null };
    break;
  }
  const taken = all.filter((message) => message.nudge && message.taken_back_at).length;
  // What the person saw of the thread when the row was read: a nudge carries it (`seen_through_seq`), so one the agent
  // has moved past since is refused (409 thread_moved_on), here and on a linked computer (Rule 11).
  const seq = store.messageCursor(ids.at(-1)!) ?? 0;
  return { to: target.id, seq, agent: inboxWordsRecipient(target), taken, last };
}

/** Movement this close after a stretch's start is that start (the window's clock arithmetic, a ms rounding). */
const MOVED_SLACK_MS = 5_000;

/**
 * Refuse a nudge (409 `thread_moved_on`, nothing written) whose work moved after its quiet stretch began: a step, a PR
 * put on the thread, or a check run this Inbox saw start or end (`checks_at`). A nudge held while this computer was
 * away is delivered hours after its press, and its words ("quiet for 3 h 48 min") would then be wrong. An agent's
 * message since is refused by `seen_through_seq` already. A replay of the same key answers what it wrote.
 */
export function gridNudgeRefusal(
  store: {
    message(id: string): InboxMessage | null;
    replyByKey(messageId: string, key: string): InboxMessage | null;
    allThreadPulls(): readonly { thread_id: string; pull: string; added_at: string }[];
    allSteps(): readonly { thread_id: string; steps: readonly { at: string }[] }[];
  },
  pulls: { live(key: string): { checks_at?: string | null } | undefined },
  messageId: string,
  body: { idempotency_key?: unknown; nudge?: unknown },
): void {
  const quiet = (body.nudge as { quiet_from?: unknown } | null)?.quiet_from;
  const from = typeof quiet === "string" ? Date.parse(quiet) : Number.NaN;
  const target = store.message(messageId);
  if (!Number.isFinite(from) || !target) return;
  const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (key && store.replyByKey(messageId, key)) return;
  const thread = target.thread_id;
  const marks: string[] = [];
  for (const pull of store.allThreadPulls()) {
    if (pull.thread_id !== thread) continue;
    marks.push(pull.added_at);
    const checks = pulls.live(pull.pull)?.checks_at;
    if (checks) marks.push(checks);
  }
  for (const list of store.allSteps()) if (list.thread_id === thread) for (const step of list.steps) marks.push(step.at);
  if (marks.some((mark) => Date.parse(mark) > from + MOVED_SLACK_MS)) {
    throw new InboxError("thread_moved_on", "The work moved on after this nudge was pressed, so it was not sent.");
  }
}

/**
 * A nudge for another machine's thread (its key, grid-nudge-key.ts): the thread it names, and a nudge for the same
 * thread already waiting in the outbox for that machine under another key (`pending`: the machine's pending entries),
 * which answers this one instead: nothing more is held. Null for a write that is not a Grid nudge.
 */
export function gridNudgeHeld<E extends { key: string }>(pending: readonly E[], key: string): { thread: string; held: E | null } | null {
  const press = gridNudgeKeyRead(key);
  if (!press) return null;
  return { thread: press.thread, held: pending.find((entry) => entry.key !== key && gridNudgeKeyRead(entry.key)?.thread === press.thread) ?? null };
}

/** The reader the list's Grid decoration calls per row, kept for the server's life (its cache). */
export function gridNudgeReader(store: GridNudgeStore): (row: InboxListRow) => InboxGridNudgeRow | undefined {
  const cache = new Map<string, { version: string; value: InboxGridNudgeRow | undefined }>();
  return (row) => {
    const kept = cache.get(row.thread_id);
    if (!kept && gridNudgeNeverStale(row)) return undefined;
    const version = store.threadVersion(row.thread_id);
    if (kept?.version === version) return kept.value;
    const value = gridNudgeOfThread(store, row.thread_id);
    cache.set(row.thread_id, { version, value });
    return value;
  };
}
