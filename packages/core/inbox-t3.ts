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
 * `mcp:<uuid>` and `mcp:launch:<sha-256 hex>` (an agent's t3_thread_launch),
 * `mcp:<uuid>:fork`, `import:<provider>:<session>` (an imported session),
 * `thread:mcp:<namespace>:<request>:<n>` (create_threads),
 * `thread:project:<project>:<uuid>` (a scheduled task's run),
 * `thread:delegated-task:<command>`, `thread:subagent:<16 hex>` and
 * `thread:provider:<driver>:native-thread:<native id>` (T3's IdAllocator:
 * each part `encodeURIComponent`ed, joined with `:`). T3 takes a send into
 * any of them, so each is the thread. The characters are those parts' (what
 * `encodeURIComponent` leaves, `%`, `:`); a short plain word passes too, as
 * T3's own rule takes any. An encoded request id of up to 256 characters
 * makes a create_threads id run past 2,000, hence the bound.
 */
const T3_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._~%:!*'()-]{0,4095}$/;

/** A T3 thread id that a shell command line carries as it is: none of the quoting characters `encodeURIComponent` leaves. */
const T3_THREAD_ID_PLAIN = /^[A-Za-z0-9][A-Za-z0-9._~%:-]{0,4095}$/;

export function isT3ThreadId(value: unknown): value is string {
  return typeof value === "string" && T3_THREAD_ID.test(value);
}

/** Whether a T3 thread id can go into a command line (`--session t3:<id>`) unquoted. */
export function isPlainT3ThreadId(value: unknown): value is string {
  return typeof value === "string" && T3_THREAD_ID_PLAIN.test(value);
}

/**
 * Why the T3 wake cannot put a person's reply into its T3 thread now, as the
 * thread's own machine knows it (`InboxMessage.t3_wait`): no sign-in is saved
 * (`sign_in`), T3 refused the saved one as lapsed or revoked
 * (`sign_in_again`), its mode does not cover the thread (`access`), or T3
 * does not answer (`closed`). It never carries the grant or its URL.
 */
export type InboxT3WaitReason = "sign_in" | "sign_in_again" | "access" | "closed";

export const INBOX_T3_WAIT_REASONS: readonly InboxT3WaitReason[] = ["sign_in", "sign_in_again", "access", "closed"];

export function isInboxT3WaitReason(value: unknown): value is InboxT3WaitReason {
  return typeof value === "string" && (INBOX_T3_WAIT_REASONS as readonly string[]).includes(value);
}

/** The sign-in command (`plannotator t3 --help`); the URL is T3's Copy MCP URL. */
export const INBOX_T3_LOGIN_COMMAND = "plannotator t3 login --url <T3 MCP URL>";

/** In T3, where the URL the sign-in command takes is. */
export const INBOX_T3_URL_WHERE = "In T3: Settings → Environments, the environment's menu, Copy MCP URL.";

/**
 * The line under a reply that waits on T3, and the command to copy beside it.
 * Proposed words: the owner approves them word for word before release.
 */
export function inboxT3WaitLine(reason: InboxT3WaitReason): { text: string; command: string | null } {
  switch (reason) {
    case "sign_in":
      return { text: "Waiting for T3 Code. Sign in to T3 once and replies go in by themselves:", command: INBOX_T3_LOGIN_COMMAND };
    case "sign_in_again":
      return { text: "Waiting for T3 Code. Your T3 sign-in ran out. Sign in again and this goes in by itself:", command: INBOX_T3_LOGIN_COMMAND };
    case "access":
      return { text: "Waiting for T3 Code. Your T3 sign-in can't send into this thread. Sign in again and choose at least the thread's mode:", command: INBOX_T3_LOGIN_COMMAND };
    case "closed":
      return { text: "Waiting for T3 Code. T3 isn't answering. Open T3 and this goes in by itself.", command: null };
  }
}
