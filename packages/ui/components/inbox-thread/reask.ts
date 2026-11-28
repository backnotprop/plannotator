/**
 * Re-ask (approval "inbox-reask", 2026-10-20): the person asks the agent
 * that asked for its questions still open in the thread again, together in
 * one new message, with fresh context. The agent's new message replaces the
 * old cards (`Replaces:` lines) or closes those that no longer apply
 * (`supersedes`); until then the old ones stay open.
 *
 * Pure: which sessions a Re-ask goes to, and the words around it. One note
 * per session (owner's rule 3): a thread where two sessions asked gets two.
 * Picks the person made and has not sent go with the note as answers
 * (owner's rule 2); only the rest are asked again.
 */

import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { agentName, plural } from '@plannotator/core/inbox-format';
import { isReaskNote, isWaiting, itemsOf, type ReaskTarget } from '@plannotator/core/inbox-reask';

// Which sessions a Re-ask goes to lives in core (the server's Re-ask all takes the same ones); kept here by name.
export { reaskTargets, type ReaskTarget } from '@plannotator/core/inbox-reask';

/**
 * Re-ask is offered when a question or action item waits in the thread (open,
 * or a question picked and not sent; owner, 2026-10-23: "re-ask should show
 * for even 1 question back in a thread") and some session has an open one it
 * can be asked for again. `messages`: the thread's live ones.
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
 * "the open question", "the 3 open questions", "the open action item", "the 2
 * open questions and 1 action item": what a Re-ask asks about.
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
  // One open question or action item: singular words, nothing to put "together".
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

/** The note's line in the thread. `picks`: answers that went with it; `actions`: how many of `asked` are action items. */
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

/**
 * The note a question was last asked again in, while it is still open.
 * `messageId`: the message that holds the question (not the question's own
 * `message_id`, which a record may lack).
 */
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
