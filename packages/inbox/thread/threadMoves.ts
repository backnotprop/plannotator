/**
 * The lines that say who a thread is with now, drawn in its run of messages (parts/ThreadMoveLine.tsx): "You handed
 * this thread to …" and "You added … to this thread" above the reply that did it (approval "inbox-tag-handoff"), and
 * "You removed … from this thread" where the person removed an agent (approval "inbox-remove-agent-from-thread"):
 * after the thread's last message at that time, so before the next one, or at the thread's end.
 */
import type { InboxRemoval, InboxThread } from '@plannotator/core/inbox-types';
import { agentName, handoffName, messageTags, namesList } from '../tags';

export interface ThreadMove {
  kind: 'handoff' | 'added' | 'removed';
  names: string;
  host: string | null;
  /** A removal's own time and session (a hand-off or an add takes its reply's time). */
  at?: string;
  session?: string;
}

/**
 * `nameOf(session, fallback, kind)`: the name the thread shows a session by (the given name, the header's, …), else
 * `fallback`. Returns the lines above each message (by its id), in the order they happened, and the removals after
 * the thread's last message.
 */
export function threadMovesOf(
  thread: InboxThread,
  nameOf: (session: string, fallback: string, kind: ThreadMove['kind']) => string,
): { byMessage: Map<string, ThreadMove[]>; end: ThreadMove[] } {
  const byMessage = new Map<string, ThreadMove[]>();
  const put = (id: string, move: ThreadMove) => byMessage.set(id, [...(byMessage.get(id) ?? []), move]);
  // The removals first: one came before the message it is drawn above.
  const end: ThreadMove[] = [];
  const root = thread.messages.find((m) => m.id === thread.thread_id) ?? thread.messages[0];
  const index = new Map(thread.messages.map((m, at) => [m.id, at]));
  for (const removal of (root?.removed ?? []) as InboxRemoval[]) {
    const move: ThreadMove = { kind: 'removed', names: nameOf(removal.session, agentName(removal.host, removal.name), 'removed'), host: removal.host, at: removal.at, session: removal.session };
    const after = index.get(removal.after);
    const next = after === undefined ? thread.messages.find((m) => m.created_at > removal.at) : thread.messages[after + 1];
    if (next) put(next.id, move);
    else end.push(move);
  }
  const joined = new Set<string>();
  for (const m of thread.messages) {
    if (m.author.kind !== 'person') continue;
    const handed = !!(m.handoff && !m.handoff.undone_at && m.to);
    if (handed) put(m.id, { kind: 'handoff', names: nameOf(m.to!.session, handoffName(m), 'handoff'), host: m.to!.host });
    const added = messageTags(m).filter((t) => t.joined && !joined.has(t.session));
    for (const t of added) joined.add(t.session);
    // One line per reply: a hand-off's says it, an add's only when it handed nothing.
    if (added.length > 0 && !handed) put(m.id, { kind: 'added', names: namesList(added.map((t) => nameOf(t.session, t.label || agentName(t.host, t.name), 'added'))), host: added[0]!.host });
  }
  return { byMessage, end };
}
