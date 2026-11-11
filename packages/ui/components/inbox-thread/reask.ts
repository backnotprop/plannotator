import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { isInboxPermissionSession } from '@plannotator/core/inbox-permission';
import { agentName, plural } from '@plannotator/core/inbox-format';

/** One session's part of a Re-ask. */
export interface ReaskTarget {
  kind: 'reask' | 'picks';
  message: InboxMessageWire;
  session: string | null;
  host: string | null;
  name: string;
  open: number;
  actions: number;
  picked: number;
  replies: { message: InboxMessageWire; questions: { message_id?: string; key: string; revision: number }[] }[];
}

const isReaskNote = (m: InboxMessageWire): boolean => m.author.kind === 'person' && (m.reask?.length ?? 0) > 0;

const itemsOf = (m: InboxMessageWire): InboxQuestion[] => [...(m.questions ?? []), ...(m.actions ?? [])];
const isWaiting = (q: InboxQuestion) => q.state === 'open' || (q.state === 'picked' && q.kind !== 'action');

/** The sessions a Re-ask would go to now. */
export function reaskTargets(messages: readonly InboxMessageWire[], live: (message: InboxMessageWire) => boolean = () => true): ReaskTarget[] {
  const groups = new Map<string, InboxMessageWire[]>();
  for (const m of messages) {
    // A launched session's permission prompt is never asked again (the store refuses it): it is answered, or answered in Terminal.
    if (m.author.kind !== 'agent' || !live(m) || isInboxPermissionSession(m.author.session)) continue;
    const key = m.author.session ? `${m.author.host ?? ''}\u0000${m.author.session}` : `\u0001${m.id}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  const wroteAfter = (note: InboxMessageWire, by: { host: string | null; session: string | null }) => {
    const at = messages.indexOf(note);
    return messages.slice(at + 1).some((m) => m.author.kind === 'agent' && m.author.session === by.session && (m.author.host ?? '') === (by.host ?? ''));
  };
  // Ids are built from the message that holds each question, never from the question's own
  // `message_id`, so a question record without one (or a stale one) can never point a rule at a
  // message that is not there.
  const openIds = new Set(
    messages.flatMap((m) => (m.author.kind === 'agent' && live(m) ? itemsOf(m).filter((q) => q.state === 'open').map((q) => `${m.id}/${q.key}`) : [])),
  );
  const targets: ReaskTarget[] = [];
  for (const group of groups.values()) {
    const ids = new Set(group.map((m) => m.id));
    const first = group[0];
    if (!first) continue;
    const author = first.author.kind === 'agent' ? first.author : null;
    const own = { host: author?.host ?? null, session: author?.session ?? null };
    const notes = messages.filter((m) => isReaskNote(m) && ((m.reply_to && ids.has(m.reply_to)) || (own.session && m.to?.session === own.session)));
    const waits = (note: InboxMessageWire) =>
      !wroteAfter(note, note.to && note.to.session !== own.session ? { host: note.to.host, session: note.to.session } : own) &&
      (note.reask ?? []).some((id) => openIds.has(id));
    if (notes.some(waits)) continue;
    const holders = group.filter((m) => itemsOf(m).some(isWaiting));
    const target = holders.at(-1);
    if (!target) continue;
    const waiting = holders.flatMap((m) => itemsOf(m).filter(isWaiting));
    const open = waiting.filter((q) => q.state === 'open').length;
    const actions = waiting.filter((q) => q.state === 'open' && q.kind === 'action').length;
    const base = { message: target, session: own.session, host: own.host, name: agentName(first.author), open, actions, picked: waiting.length - open };
    if (open === 0) {
      const questions = holders.flatMap((m) =>
        (m.questions ?? [])
          .filter((q) => q.state === 'picked')
          .map((q) => (m.id === target.id ? { key: q.key, revision: q.revision } : { message_id: m.id, key: q.key, revision: q.revision })),
      );
      targets.push({ ...base, kind: 'picks', replies: questions.length > 0 ? [{ message: target, questions }] : [] });
      continue;
    }
    if (holders.length === 1 && !wroteAfter(target, own)) {
      const answers = target.reply_to ? messages.find((m) => m.id === target.reply_to) : undefined;
      if (answers && isReaskNote(answers)) continue;
    }
    targets.push({ ...base, kind: 'reask', replies: [] });
  }
  return targets;
}

/**
 * Re-ask is offered when a question or action item waits in the thread and some session has an
 * open one it can be asked for again.
 */
export function reaskOffered(targets: readonly ReaskTarget[], messages?: readonly InboxMessageWire[]): boolean {
  const waiting = messages
    ? messages.reduce((n, m) => n + (m.author.kind === 'agent' ? itemsOf(m).filter(isWaiting).length : 0), 0)
    : targets.reduce((n, t) => n + t.open + t.picked, 0);
  return waiting >= 1 && targets.some((t) => t.kind === 'reask' && t.open > 0);
}

/** "Claude Code", "Claude Code and Pi", or "2 sessions" when two share a name. */
export function reaskWho(targets: readonly ReaskTarget[]): string {
  const names = targets.filter((t) => t.kind === 'reask').map((t) => t.name);
  if (names.length === 1) return names[0]!;
  if (new Set(names).size < names.length) return `${names.length} sessions`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * "the open question", "the 3 open questions", "the open action item", "the 2 open questions and
 * 1 action item": what a Re-ask asks about.
 */
export function reaskItems(open: number, actions: number): string {
  const questions = open - actions;
  if (actions === 0) return open === 1 ? 'the open question' : `the ${open} open questions`;
  if (questions === 0) return actions === 1 ? 'the open action item' : `the ${actions} open action items`;
  return `the ${plural(questions, 'open question')} and ${plural(actions, 'action item')}`;
}

/** The button's tooltip: what pressing it does. */
export function reaskTooltip(targets: readonly ReaskTarget[]): string {
  const open = targets.reduce((n, t) => n + t.open, 0);
  const actions = targets.reduce((n, t) => n + (t.actions ?? 0), 0);
  const picks = targets.reduce((n, t) => n + t.picked, 0);
  const several = targets.filter((t) => t.kind === 'reask').length > 1;
  const pickWords = picks > 0 ? ` Your ${plural(picks, 'pick')} ${picks === 1 ? 'is' : 'are'} sent too.` : '';
  if (open === 1) {
    const item = actions === 1 ? 'the open action item' : 'the open question';
    return `Ask ${reaskWho(targets)} to ask ${item} again, with fresh context. If it no longer applies, it is closed; until then it stays open here.${pickWords}`;
  }
  if (actions > 0) {
    const items = reaskItems(open, actions).replace(/^the /, several ? 'their ' : 'the ');
    return `Ask ${reaskWho(targets)} to ask ${items} again, ${several ? 'each together in one message' : 'together in one message'} with fresh context. Those that no longer apply are closed; until then they stay open here.${pickWords}`;
  }
  const what = `${several ? 'their' : 'the'} ${open} open questions again, ${several ? 'each together in one message' : 'together in one message'} with fresh context`;
  return `Ask ${reaskWho(targets)} to ask ${what}. Questions that no longer apply are closed; until then they stay open here.${pickWords}`;
}

export function reaskNoteSentence(agent: string, asked: number, picks: number, actions = 0): string {
  if (actions > 0) {
    const items = reaskItems(asked, actions);
    const line =
      asked === 1
        ? `You asked ${agent} to ask ${items} again. It stays open here until it does.`
        : `You asked ${agent} to ask ${items} again, together in one message. They stay open here until it does.`;
    return picks > 0 ? `${line} Your ${plural(picks, 'pick')} went with it.` : line;
  }
  const head =
    asked === 1
      ? `You asked ${agent} to ask the open question again. It stays open here until it does.`
      : `You asked ${agent} to ask the ${asked} open questions again, together in one message. They stay open here until it does.`;
  return picks > 0 ? `${head} Your ${plural(picks, 'pick')} went with it.` : head;
}

/** The note a question was last asked again in, while it is still open. */
export function reaskedIn(
  messages: readonly InboxMessageWire[],
  messageId: string,
  question: Pick<InboxQuestion, 'key' | 'state'>,
): InboxMessageWire | null {
  if (question.state !== 'open') return null;
  const id = `${messageId}/${question.key}`;
  return [...messages].reverse().find((m) => isReaskNote(m) && (m.reask ?? []).includes(id)) ?? null;
}

/** Who a Re-ask note went to: the agent of the message it answers, else `fallback` (the thread's asker). */
export function reaskNoteAgent(answered: InboxMessageWire['author'] | undefined, fallback: string): string {
  return answered?.kind === 'agent' ? agentName(answered) : fallback;
}
