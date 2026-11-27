/** The reply pill's list (approval "inbox-reply-recipient"): who it offers, named and ordered by replyRecipients.ts. */
import { inboxCanRemove, inboxRemovedNow, type InboxThread } from '@plannotator/core/inbox-types';
import type { TaggableModel } from '../api';
import type { AskingSession } from '../components/ReplyRoute';
import { canTakeAlone, latestBy, recipientRows, recipientState, sessionFolder, type RecipientPerson, type RecipientRow } from '../replyRecipients';
import { tookOverReply } from '../sendTargets';
import { activeHandoff } from '../tags';
import type { ReplyStart } from './replyStart';

/**
 * The thread's agents, the session a hand-off or takeover gave the thread, and, when the agent asked has ended, the
 * live sessions in its place and, last, the start row (`start`). A renamed session is its given name (`givenNameOf`). `gone`: sessions a Send was refused for as not
 * live any more, ended in the list from then on. `rcptDefault`: the session the words go to unless aimed.
 */
export function replyRecipientList(input: {
  participants: readonly RecipientPerson[];
  thread: InboxThread;
  askerEnded: boolean;
  asking: AskingSession | null;
  live: { sessions: readonly { host: string; session: string }[] } | null;
  taggable: TaggableModel | null;
  gone: ReadonlyMap<string, string | null>;
  rcptDefault: string | null;
  start: ReplyStart | null;
  /** The name the person gave a session (Rename… on its sidebar row), or null. */
  givenNameOf?: (session: string) => string | null;
  /** The thread's machine takes Remove (this Inbox's own thread, or a linked one with the `remove-agent` mark). */
  removeOn?: boolean;
}): RecipientRow[] {
  const { thread, askerEnded, asking, live, taggable, gone, rcptDefault } = input;
  const people: RecipientPerson[] = [...input.participants];
  // An agent the person removed is in no row until they write to it again (core inbox-removed.ts).
  const removed = inboxRemovedNow(thread.messages);
  const add = (host: string | null, session: string) => {
    if (!removed.has(session) && !people.some((p) => p.session === session)) people.push({ host, session });
  };
  /** Remove on a row (approval "inbox-remove-agent-from-thread"): one of the thread's agents, never the last one. */
  const removable = (session: string) =>
    !!input.removeOn && input.participants.length > 1 && input.participants.some((p) => p.session === session) && inboxCanRemove(thread.messages, session);
  const handed = activeHandoff(thread) ?? tookOverReply(thread);
  if (handed?.to) add(handed.to.host, handed.to.session);
  // The agent asked has ended: the live sessions take its place in the list (its project's, and writers from other folders).
  if (askerEnded) for (const s of live?.sessions ?? []) add(s.host, s.session);
  // One that ended as a Send went to it stays in the list, ended.
  for (const [session, host] of gone) add(host, session);
  const ended = new Set([...(askerEnded && asking ? [asking.session] : []), ...gone.keys()]);
  const rows = recipientRows(
    people,
    // A live session of the project's list that the `@` list has not read: the thread's folder (the list is its project's).
    (session) => sessionFolder(session, thread, taggable) ?? (gone.has(session) || live?.sessions.some((s) => s.session === session) ? thread.project.name : null),
    (session) => recipientState(session, taggable, ended),
    input.givenNameOf,
  ).map((row) => ({ ...row, alone: canTakeAlone(row.state, row.session === rcptDefault || latestBy(thread, row.session) !== undefined), ...(removable(row.session) ? { removable: true } : {}) }));
  return askerEnded && input.start ? [...rows, input.start.row] : rows;
}
