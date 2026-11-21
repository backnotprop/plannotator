/**
 * Re-ask (approval "inbox-reask", 2026-10-20): which sessions of a thread a
 * Re-ask goes to. Pure, on the thread's wire messages, so the window's Re-ask
 * (packages/ui/components/inbox-thread/reask.ts re-exports it) and the
 * server's Re-ask all (packages/shared/inbox/reask-all.ts) take the same
 * sessions by the same rule. Moved here unchanged from the window.
 */

import type { InboxMessageWire, InboxQuestion } from './inbox-types';
import { isInboxPermissionSession } from './inbox-permission';
import { agentName } from './inbox-format';

/** One session's part of a Re-ask. */
export interface ReaskTarget {
  /**
   * `reask`: a note asking the session for its open questions again (its
   * unsent picks go with it). `picks`: the session has nothing open, only
   * picks not sent: a plain reply carries them as answers, so a Re-ask never
   * strands them.
   */
  kind: 'reask' | 'picks';
  /** The session's latest message with a question still open or picked: the note answers it. */
  message: InboxMessageWire;
  session: string | null;
  host: string | null;
  /** "Claude Code": the agent as the thread names it. */
  name: string;
  /** Open questions with no pick, and open action items: asked again. */
  open: number;
  /** How many of `open` are action items. */
  actions: number;
  /** Picked and not sent: they go with the note (or the plain reply) as answers. */
  picked: number;
  /**
   * For `picks`: the one plain reply that carries them, as a Send does (one
   * reply per session, approval "inbox-explicit-skip"): it answers the
   * session's latest message holding a pick, and names the message of every
   * pick on another one.
   */
  replies: { message: InboxMessageWire; questions: { message_id?: string; key: string; revision: number }[] }[];
}

export const isReaskNote = (m: InboxMessageWire): boolean => m.author.kind === 'person' && (m.reask?.length ?? 0) > 0;

/**
 * What a Re-ask can ask about in a message: its questions and its action
 * items (the window keeps those in `actions`; owner, #2059: Re-ask includes
 * open action items). An action item the person marked (Done or Can't do it,
 * inside its Undo window) reads "picked" but waits on nobody: it is left out.
 */
export const itemsOf = (m: InboxMessageWire): InboxQuestion[] => [...(m.questions ?? []), ...(m.actions ?? [])];
export const isWaiting = (q: InboxQuestion) => q.state === 'open' || (q.state === 'picked' && q.kind !== 'action');

/** The session an agent's message belongs to for a Re-ask: its host and session, or the message alone when it named none. */
export const reaskSessionKey = (m: InboxMessageWire): string =>
  m.author.kind === 'agent' && m.author.session ? `${m.author.host ?? ''}\u0000${m.author.session}` : `\u0001${m.id}`;

/**
 * The sessions a Re-ask would go to now. A session is left out while a note
 * of its waits (rule 2a): no message after it from the session the note went
 * to (the note's `to` when the person sent it to another session because
 * this one ended, else this session), and a question it lists still open.
 * Once that session wrote, or nothing it lists is open, what is left can be
 * asked again. Also left out right after it
 * answered a note (every question it still has open sits in its one message
 * that answered the note, and it has not written since), and when nothing of
 * its waits. `live` says which
 * messages still take answers (not closed by an archive).
 */
export function reaskTargets(messages: readonly InboxMessageWire[], live: (message: InboxMessageWire) => boolean = () => true): ReaskTarget[] {
  const groups = new Map<string, InboxMessageWire[]>();
  for (const m of messages) {
    // A launched session's permission prompt is never asked again (the store refuses it): it is answered, or answered in Terminal.
    if (m.author.kind !== 'agent' || !live(m) || isInboxPermissionSession(m.author.session)) continue;
    // An agent that named no session: each message is its own.
    const key = reaskSessionKey(m);
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  const wroteAfter = (note: InboxMessageWire, by: { host: string | null; session: string | null }) => {
    const at = messages.indexOf(note);
    return messages.slice(at + 1).some((m) => m.author.kind === 'agent' && m.author.session === by.session && (m.author.host ?? '') === (by.host ?? ''));
  };
  // Ids are built from the message that holds each question, never from the
  // question's own `message_id`, so a question record without one (or a stale
  // one) can never point a rule at a message that is not there.
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
    // A note to this session (an answer to one of its messages), or one sent to it from an ended session.
    const notes = messages.filter((m) => isReaskNote(m) && ((m.reply_to && ids.has(m.reply_to)) || (own.session && m.to?.session === own.session)));
    // A note waits until its session wrote again, and only while a question it lists is still open (rule 2a).
    const waits = (note: InboxMessageWire) =>
      !wroteAfter(note, note.to && note.to.session !== own.session ? { host: note.to.host, session: note.to.session } : own) &&
      (note.reask ?? []).some((id) => openIds.has(id));
    if (notes.some(waits)) continue;
    // The session's messages that still hold a question waiting on the person
    // (open, or picked and not sent), in thread order. Every rule below reads
    // these messages, not the questions' `message_id`, so the message a rule
    // names is always one of the session's own.
    const holders = group.filter((m) => itemsOf(m).some(isWaiting));
    const target = holders.at(-1);
    if (!target) continue;
    const waiting = holders.flatMap((m) => itemsOf(m).filter(isWaiting));
    const open = waiting.filter((q) => q.state === 'open').length;
    const actions = waiting.filter((q) => q.state === 'open' && q.kind === 'action').length;
    const base = { message: target, session: own.session, host: own.host, name: agentName(first.author), open, actions, picked: waiting.length - open };
    if (open === 0) {
      // Only picks: one plain reply carries them all (owner's rule: picks go, never stranded).
      const questions = holders.flatMap((m) =>
        (m.questions ?? [])
          .filter((q) => q.state === 'picked')
          .map((q) => (m.id === target.id ? { key: q.key, revision: q.revision } : { message_id: m.id, key: q.key, revision: q.revision })),
      );
      targets.push({ ...base, kind: 'picks', replies: questions.length > 0 ? [{ message: target, questions }] : [] });
      continue;
    }
    // Just answered a note: everything still waiting is in that one message,
    // that message replies to the note, and the session has not written since.
    if (holders.length === 1 && !wroteAfter(target, own)) {
      const answers = target.reply_to ? messages.find((m) => m.id === target.reply_to) : undefined;
      if (answers && isReaskNote(answers)) continue;
    }
    targets.push({ ...base, kind: 'reask', replies: [] });
  }
  return targets;
}
