/**
 * The T3 Code wake's pure parts (packages/server/inbox-t3-wake.ts runs it).
 *
 * T3 Code runs agents (Claude through the Agent SDK, where the Claude Code
 * mod stands down) and sets T3CODE_THREAD_ID in every process an agent
 * starts, its MCP servers included. The stdio shim sends as that thread, and
 * the Inbox puts the person's reply into it through T3's own MCP API, so it
 * shows in T3 as a turn like anything the person typed.
 */

/** The host id a T3 Code thread is recorded under. */
export const INBOX_T3_HOST = "t3";

/** How the person sees a T3 Code thread. */
export const INBOX_T3_NAME = "T3 Code";

/** The variable T3 Code sets in every process an agent of the thread starts. */
export const INBOX_T3_THREAD_ENV = "T3CODE_THREAD_ID";

/** A T3 Code thread id: a UUID. */
const T3_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isT3ThreadId(value: unknown): value is string {
  return typeof value === "string" && T3_THREAD_ID.test(value);
}
