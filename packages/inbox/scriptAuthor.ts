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
import { inboxAgentName, inboxSessionlessSend, type InboxAuthor, type InboxListRow, type InboxRowDelivery } from '@plannotator/core/inbox-types';

/** What the person sees for a script's post, in place of "An agent". */
export const SCRIPT_AUTHOR_NAME = 'Script';

type Author = { kind: string; host?: string | null; session?: string | null; name?: string | null } | null | undefined;
type AgentMessage = { author: Author; wakes?: boolean };

/** A message from a script: the core's own rule (no session, host or name, and not sent through a waking connection). */
export function isScriptPost(message: AgentMessage | null | undefined): boolean {
  return !!message?.author && inboxSessionlessSend({ author: message.author, wakes: message.wakes });
}

/**
 * By its author alone, where no message is at hand (a list row, a mark): the same rule without `wakes`. A waking
 * connection (the Claude Code mod, Pi, OpenCode 2) always names its session and host, so the two never differ.
 */
export function isScriptAuthor(author: Author): boolean {
  return isScriptPost({ author });
}

/** A message's author as the person sees it: "Script" for a script's post, else `inboxAgentName`. */
export function messageAuthorName(message: AgentMessage): string {
  return isScriptPost(message) ? SCRIPT_AUTHOR_NAME : inboxAgentName(message.author);
}

/**
 * A thread no session wrote in, started by a script: every agent message in it is a script's post. Its one name
 * there is "Script" (the heads, the reply box, the read line, the archived foot), as `threadAskerName` gives it.
 */
export function scriptOnlyThread(messages: readonly AgentMessage[]): boolean {
  return isScriptPost(messages[0]) && messages.every((m) => m.author?.kind !== 'agent' || isScriptPost(m));
}

/** The thread's first agent named (Thread.tsx `asker`): "Script" in a thread only a script wrote in. */
export function threadAskerName(messages: readonly AgentMessage[]): string {
  return scriptOnlyThread(messages) ? SCRIPT_AUTHOR_NAME : inboxAgentName(messages[0]?.author);
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
