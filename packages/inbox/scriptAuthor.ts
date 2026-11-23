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
import { inboxAgentName, inboxSessionlessSend, type InboxListRow } from '@plannotator/core/inbox-types';

/** What the person sees for a script's post, in place of "An agent". */
export const SCRIPT_AUTHOR_NAME = 'Script';

type Author = { kind: string; host?: string | null; session?: string | null; name?: string | null } | null | undefined;

/** A message from a script: the core's own rule (no session, host or name, and not sent through a waking connection). */
export function isScriptPost(message: { author: Author; wakes?: boolean } | null | undefined): boolean {
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
export function messageAuthorName(message: { author: Author; wakes?: boolean }): string {
  return isScriptPost(message) ? SCRIPT_AUTHOR_NAME : inboxAgentName(message.author);
}

/** The row's agent (`rowAgent`) as the person sees it. */
export function rowAuthorName(agent: Author): string {
  return isScriptAuthor(agent) ? SCRIPT_AUTHOR_NAME : inboxAgentName(agent);
}

/**
 * The row's tiles stand for a script: no session in the thread (`participants` lists sessions only) and the row's
 * agent is a script's post.
 */
export function rowIsScript(row: Pick<InboxListRow, 'participants'>, agent: Author): boolean {
  return !(row.participants?.length) && isScriptAuthor(agent);
}
