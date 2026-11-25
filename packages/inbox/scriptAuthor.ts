/**
 * A script's post (the owner, 2026-11-23: "inform the user with the right icon and let them know, hey, one of your
 * agents created this thread with the script"): an agent message sent with no session, no host and no name, which the
 * core calls a sessionless send (`inboxSessionlessSend`): `plannotator inbox call send_message` from a cron job, a
 * hook or a plain shell, or a raw MCP call naming none of them. The window names its author "Script" and draws a
 * terminal mark where an agent's icon would be.
 *
 * The window's words only: what an agent reads (read_thread, wake lines, tool results) still names it as
 * `inboxAgentName` does, "An agent". An agent with a session but no known name or host is not a script and keeps
 * "An agent" here too.
 */
import { INBOX_SCRIPT_AUTHOR_NAME, inboxAgentName, inboxScriptAuthor, type InboxAuthor, type InboxListRow, type InboxRowDelivery } from '@plannotator/core/inbox-types';

/** What the person sees for a script's post, in place of "An agent". */
export const SCRIPT_AUTHOR_NAME = INBOX_SCRIPT_AUTHOR_NAME;

type Author = { kind: string; host?: string | null; session?: string | null; name?: string | null } | null | undefined;
type AgentMessage = { author: Author; wakes?: boolean };

/**
 * A message from a script, by its author alone (`inboxScriptAuthor`: no session, host or name), as its mark and its
 * row are: so the name and the terminal always agree, in the thread and on its row. Routing's own rule also reads
 * `wakes` (`inboxSessionlessSend`); a waking connection always names its session and host, so they differ only for
 * a record no connection writes, which is then named and drawn as a script everywhere the person looks.
 */
export function isScriptPost(message: AgentMessage | null | undefined): boolean {
  return isScriptAuthor(message?.author);
}

/** By its author alone, where no message is at hand (a list row, a mark). */
export function isScriptAuthor(author: Author): boolean {
  return inboxScriptAuthor(author);
}

/** A message's author as the person sees it: "Script" for a script's post, else `inboxAgentName`. */
export function messageAuthorName(message: AgentMessage): string {
  return isScriptPost(message) ? SCRIPT_AUTHOR_NAME : inboxAgentName(message.author);
}

/**
 * The thread's first agent named (Thread.tsx `asker`: the read line, the archived foot, New message, the file panes):
 * "Script" in a thread only a script wrote in; in one a script started and a session took over, the first agent that
 * is not a script's post (the one a reply reaches, as the row names it, `rowWho`); else the root's author.
 */
export function threadAskerName(messages: readonly AgentMessage[]): string {
  if (!isScriptPost(messages[0])) return inboxAgentName(messages[0]?.author);
  const session = messages.find((m) => m.author?.kind === 'agent' && !isScriptPost(m));
  return session ? inboxAgentName(session.author) : SCRIPT_AUTHOR_NAME;
}

/** An author named as the window names a script's post ("Script"), where only the author is at hand (a mark, a toast). */
export function authorName(author: Author): string {
  return isScriptAuthor(author) ? SCRIPT_AUTHOR_NAME : inboxAgentName(author);
}

/**
 * The row's tiles stand for a script: no session in the thread (`participants` lists sessions only; the server lists
 * a script's thread's one session too, store.ts `listRow`) and the row's agent is a script's post.
 */
export function rowIsScript(row: Pick<InboxListRow, 'participants'>, agent: Author): boolean {
  return !(row.participants?.length) && isScriptAuthor(agent);
}

/**
 * The agent a row stands for, as its tiles draw it: the row's agent (`rowAgent`), or, for a thread a script started
 * that a session took over, that session (the first in `participants`), never the script.
 */
export function rowWho(row: Pick<InboxListRow, 'participants'>, agent: InboxAuthor): InboxAuthor {
  const first = isScriptAuthor(agent) ? row.participants?.[0] : undefined;
  return first ? { kind: 'agent', host: first.host, session: first.session, name: first.name ?? null } : agent;
}

/** The row's agent named as its tiles name it (`rowWho`): "Script" only where they draw the terminal. */
export function rowAgentName(row: Pick<InboxListRow, 'participants'>, agent: InboxAuthor): string {
  return rowIsScript(row, agent) ? SCRIPT_AUTHOR_NAME : inboxAgentName(rowWho(row, agent));
}

/** Whom a row's delivery went to, named as the thread names it ("Script" for a script's post), with no "(another session)". */
export function deliveryAgentName(d: Pick<InboxRowDelivery, 'host' | 'name' | 'script'>): string {
  return d.script ? SCRIPT_AUTHOR_NAME : inboxAgentName({ kind: 'agent', host: d.host, name: d.name });
}

/**
 * Whom the person's reply goes to, or who writes next, on a row ("Send now: put your reply into …", "until … writes
 * again", the sent and Re-ask lines). In a thread a script started, the delivery the reply routing chose names it
 * (the script itself only where no session takes the reply, `InboxRowDelivery.script`); with no delivery, the row's
 * agent as its tiles name it. Every other row names its agent as it always did.
 */
export function rowRecipientName(row: Pick<InboxListRow, 'participants' | 'delivery'>, agent: InboxAuthor): string {
  if (isScriptAuthor(agent) && row.delivery) return deliveryAgentName(row.delivery);
  return rowAgentName(row, agent);
}
