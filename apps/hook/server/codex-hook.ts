/**
 * `plannotator codex-hook`: Plannotator's Codex `PostToolUse` hook (HIDDEN_SUBCOMMANDS). It runs after a tool call of a
 * Codex turn, and only when the installed command's shell gate found a reply waiting in the Codex hook mailbox
 * (`CODEX_HOOK_GATE`, packages/shared/codex-hook-command.ts). It claims the replies the Inbox holds for this thread
 * (packages/shared/inbox/codex-hook-mailbox.ts) and hands them to Codex as `additionalContext`, which Codex adds to the
 * turn right after the tool call, before its next model request. Nothing waiting, a payload it cannot read, or any
 * failure: no output and exit 0, so the tool call goes on as if no hook ran.
 */

import { join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { codexHookOutput, takeForCodexHook } from "@plannotator/shared/inbox/codex-hook-mailbox";

/** The longest hook payload read (a tool's whole output can be in it; only the thread id is needed). */
const PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** The thread a PostToolUse payload names (`session_id`, the Codex thread id), or null for any other payload. */
export function codexHookThread(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const record = (parsed ?? {}) as { hook_event_name?: unknown; session_id?: unknown; agent_id?: unknown };
  if (record.hook_event_name !== undefined && record.hook_event_name !== "PostToolUse") return null;
  // A subagent's tool call names its root thread's id as `session_id` (codex-rs/core/src/hook_runtime.rs): the
  // reply is for the root, so it waits for the root's own next tool call.
  if (record.agent_id !== undefined && record.agent_id !== null) return null;
  return typeof record.session_id === "string" && record.session_id ? record.session_id : null;
}

/** What the hook writes to stdout for this payload ("" for nothing). */
export function runCodexHook(payload: string, inboxDir: string, now: number): string {
  const thread = codexHookThread(payload);
  if (!thread) return "";
  try {
    return codexHookOutput(takeForCodexHook(inboxDir, thread, now));
  } catch {
    return "";
  }
}

/** The subcommand: stdin in, the answer out, always exit 0. */
export async function codexHookMain(): Promise<void> {
  let payload = "";
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > PAYLOAD_MAX_BYTES) return;
      chunks.push(chunk);
    }
    payload = Buffer.concat(chunks).toString("utf8");
  } catch {
    return;
  }
  const out = runCodexHook(payload, join(getPlannotatorDataDir(), "inbox"), Date.now());
  if (out) process.stdout.write(out);
}
