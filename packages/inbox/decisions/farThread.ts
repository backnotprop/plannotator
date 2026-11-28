/**
 * Decision mode on a thread that lives on a linked computer (mark `decisions`; inbox-machines.md, "Decision mode on a
 * linked computer's thread"). Every answer goes there through the forward and the outbox as the thread's own does; this
 * is what the dialog needs besides: the computer's name and state for what it says, what a Send held for it says on
 * its chip, and the thread to send from while that computer is away.
 */
import type { MachineView, OutboxView, ThreadModel } from '@plannotator/core/inbox-wire-models';
import { InboxApiError } from '../api';
import { linkedMachineFacts, machineOf } from '../inboxUrl';
import { outboxLine } from '../machines';
import type { HeldPick } from '../heldPicks';

/** A linked computer by id, as the merged list last named it: its name and state (null: not one known here). */
export function farMachine(id: string): Pick<MachineView, 'name' | 'state'> | null {
  const facts = linkedMachineFacts(id);
  return facts ? { name: facts.name, state: facts.state as MachineView['state'] } : null;
}

/**
 * What a group's chip says of its Send's replies held under these outbox keys: why one did not land, else "Will send
 * when Laptop is back" while one waits; null once all were delivered (or none is in the outbox yet): the chip then
 * follows the reply as any.
 */
export function heldSendLine(held: readonly string[] | undefined, outbox: ReadonlyMap<string, OutboxView> | undefined): { tone: 'waiting' | 'failed'; text: string } | null {
  const lines = (held ?? []).flatMap((key) => {
    const entry = outbox?.get(key);
    const line = entry ? outboxLine(entry, farMachine(entry.machine)) : null;
    return line ? [line] : [];
  });
  return lines.find((line) => line.tone === 'failed') ?? lines[0] ?? null;
}

/** A held write that surely never applied there: refused, cancelled, or dropped before it left (unlinked). */
export function outboxNotApplied(entry: OutboxView | undefined): entry is OutboxView {
  return !!entry && (entry.state === 'refused' || entry.state === 'cancelled' || (entry.state === 'dropped' && entry.notice?.kind === 'not_delivered'));
}

/**
 * A Send's fresh reads of the thread failed because its linked computer cannot be reached now: the thread as the dialog
 * holds it, and no reply draft (that computer's cannot be read now), so the reply waits in the outbox as one sent from
 * the thread does. Null for any other failure, or a thread of this Inbox: nothing is sent.
 */
export function awayThreadRead(
  cause: unknown,
  threadId: string,
  held: ThreadModel | null,
  waiting: HeldAnswers = { picks: [], marks: [] },
  /** When the thread's reply box last saved words there, as the list last said (`unsent.reply_at`). */
  replyAt: string | null = null,
): [{ draft: { at: string } | null }, ThreadModel] | null {
  if (!machineOf(threadId) || !(cause instanceof InboxApiError) || cause.code !== 'machine_offline') return null;
  // Words wait in its reply box: the answers go with them from the thread, in one reply, never split from them.
  return held && held.thread.thread_id === threadId ? [{ draft: replyAt ? { at: replyAt } : null }, withHeldAnswers(held, waiting)] : null;
}

/** An action item's Done or Can't do it (null: taken back) held for that computer, by `<message id>/<key>`. */
export interface HeldMark {
  id: string;
  mark: { outcome: 'done' | 'cant'; note?: string } | null;
}

/** What waits in the outbox for that computer, in the order it was made: picks, and action items' marks. */
export interface HeldAnswers {
  picks: readonly HeldPick[];
  marks: readonly HeldMark[];
}

/**
 * The thread as that computer will hold it once what waits for it applies there, in order: so a Send made while it is
 * away carries every answer the person sees on the cards, as one made here does. A held pick makes the next revision
 * there (heldPicks.ts), which the reply names; a held mark is staged in the reply draft there.
 */
export function withHeldAnswers(model: ThreadModel, waiting: HeldAnswers): ThreadModel {
  if (waiting.picks.length === 0 && waiting.marks.length === 0) return model;
  const picks = new Map(waiting.picks.map((pick) => [pick.id, pick]));
  const marks = new Map(waiting.marks.map((held) => [held.id, held.mark]));
  const at = new Date().toISOString();
  const messages = model.thread.messages.map((m) => ({
    ...m,
    questions: m.questions?.map((q) => {
      const pick = picks.get(`${m.id}/${q.key}`);
      return pick ? { ...q, state: pick.answer ? ('picked' as const) : ('open' as const), answer: pick.answer, revision: pick.revision + 1 } : q;
    }),
    actions: m.actions?.map((a) => {
      const id = `${m.id}/${a.key}`;
      if (!marks.has(id)) return a;
      const mark = marks.get(id);
      return mark ? { ...a, state: 'picked' as const, action_result: { outcome: mark.outcome, note: mark.note ?? null, at, by: 'person' as const, staged: true } } : { ...a, state: 'open' as const, action_result: null };
    }),
  }));
  return { ...model, thread: { ...model.thread, messages } };
}
