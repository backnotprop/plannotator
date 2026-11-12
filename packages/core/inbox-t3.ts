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

/**
 * A T3 Code thread id. A thread made in the app is a UUID; T3 derives every
 * other thread's id from what made it, so a retry makes the same thread:
 * `mcp:launch:<sha-256 hex>` (an agent's t3_thread_launch),
 * `thread:project:<project>:<uuid>` (a scheduled task's run),
 * `thread:delegated-task:<command>` and
 * `thread:provider:<driver>:native-thread:<native id>` (T3's IdAllocator:
 * each part `encodeURIComponent`ed, joined with `:`). T3 takes a send into
 * any of them, so each is the thread. The characters are those parts' (what
 * `encodeURIComponent` leaves, `%`, `:`); a provider's native id makes some
 * of them long (300+ characters seen), hence the bound.
 */
const T3_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._~%:!*'()-]{0,1023}$/;

/** A T3 thread id that a shell command line carries as it is: none of the quoting characters `encodeURIComponent` leaves. */
const T3_THREAD_ID_PLAIN = /^[A-Za-z0-9][A-Za-z0-9._~%:-]{0,1023}$/;

export function isT3ThreadId(value: unknown): value is string {
  return typeof value === "string" && T3_THREAD_ID.test(value);
}

/** Whether a T3 thread id can go into a command line (`--session t3:<id>`) unquoted. */
export function isPlainT3ThreadId(value: unknown): value is string {
  return typeof value === "string" && T3_THREAD_ID_PLAIN.test(value);
}
