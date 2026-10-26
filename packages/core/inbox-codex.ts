/**
 * The Codex wake's pure parts (packages/server/inbox-codex-wake.ts runs it):
 * what a Codex thread id looks like, which Codex CLI can queue a message, and
 * how a Codex MCP tool call names its thread. Browser-safe, no I/O.
 *
 * A person's reply to a Codex thread goes in as a new turn through
 * `codex queue --thread <id> --message <text>` (Codex CLI 0.149+): an idle
 * thread starts the turn at once, a busy one when its turn ends, a closed one
 * when it is resumed. Codex's MCP client names the thread on every tool call
 * (`params._meta.threadId`), and Codex sets CODEX_THREAD_ID in the commands
 * its shell runs, so the session is learned without the agent saying it.
 */

/** The first Codex CLI with `codex queue` (rust-v0.149.0): the Codex wake needs it. */
export const INBOX_CODEX_QUEUE_MIN_VERSION = "0.149.0";

/** The host id a Codex session is recorded under. */
export const INBOX_CODEX_HOST = "codex";

/** How the person sees a Codex session. */
export const INBOX_CODEX_NAME = "Codex";

/** Codex's MCP client name (`initialize`'s `clientInfo.name`). */
export const INBOX_CODEX_MCP_CLIENT = "codex-mcp-client";

/** The `_meta` key Codex puts its turn's details under on every MCP tool call. */
export const INBOX_CODEX_TURN_META_KEY = "x-codex-turn-metadata";

/** A Codex thread id: a UUID (Codex makes v7 ones). Nothing else is ever passed to `codex queue`. */
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCodexThreadId(value: unknown): value is string {
  return typeof value === "string" && CODEX_THREAD_ID.test(value);
}

/** `codex-cli 0.160.0` (also `0.164.0-alpha.11.1`, the ChatGPT app's) as [major, minor, patch]; null for anything else. */
export function parseCodexCliVersion(text: unknown): [number, number, number] | null {
  if (typeof text !== "string") return null;
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)\b/m.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether that Codex CLI has `codex queue` (INBOX_CODEX_QUEUE_MIN_VERSION or later). */
export function codexCliQueues(version: readonly [number, number, number] | null): boolean {
  if (!version) return false;
  const min = INBOX_CODEX_QUEUE_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== min[i]!) return version[i]! > min[i]!;
  }
  return true;
}

/**
 * The Codex thread an MCP tool call came from: `params._meta.threadId`, when
 * the caller is Codex (its `clientInfo.name`, or its turn metadata on the
 * call) and the id is a Codex thread id. Null otherwise.
 */
export function codexThreadOfCall(meta: unknown, clientName?: string | null): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  const fromCodex = clientName === INBOX_CODEX_MCP_CLIENT || (!!record[INBOX_CODEX_TURN_META_KEY] && typeof record[INBOX_CODEX_TURN_META_KEY] === "object");
  if (!fromCodex) return null;
  return isCodexThreadId(record.threadId) ? record.threadId : null;
}

/**
 * What started the Codex turn a tool call belongs to (`turn_trigger`: `user`
 * in the TUI and the apps, `exec` in `codex exec`), or null when the call
 * does not say.
 */
export function codexTurnTrigger(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const turn = (meta as Record<string, unknown>)[INBOX_CODEX_TURN_META_KEY];
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
  const trigger = (turn as Record<string, unknown>).turn_trigger;
  return typeof trigger === "string" ? trigger : null;
}

/**
 * Whether a Codex tool call comes from a thread the Inbox can wake: it names
 * its thread, and the turn is not a `codex exec` run (exec exits after its
 * turn, so nothing would ever run a queued message; its agent keeps
 * `wait_for_reply`).
 */
export function codexCallWakes(meta: unknown, session: unknown): boolean {
  const thread = codexThreadOfCall(meta);
  return thread !== null && thread === session && codexTurnTrigger(meta) !== "exec";
}

/** When the Codex turn a tool call belongs to started (ms since the epoch), from its turn metadata; null when it does not say. */
export function codexTurnStartedAt(meta: unknown): number | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const turn = (meta as Record<string, unknown>)[INBOX_CODEX_TURN_META_KEY];
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
  const at = (turn as Record<string, unknown>).turn_started_at_unix_ms;
  return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
}
