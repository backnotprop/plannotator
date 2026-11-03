/**
 * Thread steps for agents (approval "inbox-thread-steps", 2026-11-03): the
 * `steps` tool, send_message's `steps` field, and the lines read_thread adds.
 * One silent call sends the session's whole list for a thread; it writes no
 * message and notifies no one (the store's "thread steps").
 *
 * Served only while the person has steps on (config.json `inboxSteps`, the
 * MCP context's `stepsOn`): off, `steps` is not in tools/list, send_message
 * has no `steps` field, and read_thread says nothing of steps, so agents get
 * no added words. A call from a session that listed the tool while it was on
 * answers `steps_off` with nothing written.
 *
 * Reached by the `plannotator_inbox` tool's action "steps" (the Claude Code
 * mod, Pi, OpenCode, DeepSeek Harness), the stdio shim, `plannotator inbox
 * call steps` and `plannotator inbox steps` (apps/hook/server/inbox-steps-command.ts).
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { inboxStoredAgentName } from "@plannotator/core/inbox-format";
import {
  INBOX_STEP_STATUSES,
  INBOX_STEP_TEXT_MAX,
  INBOX_STEPS_MAX,
  inboxAgentName,
  inboxStepStatusOf,
  inboxStepsProgress,
  normalizeInboxSteps,
  type InboxAuthor,
  type InboxSteps,
} from "@plannotator/core/inbox-types";
import { INBOX_STEPS_FIELD_DESCRIPTION, INBOX_STEPS_LEAD } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { shortTime } from "./inbox-mcp-read";
import { guarded, okComplete } from "./inbox-mcp-result";

/** What a `steps` call gets while the person has steps off: nothing is written. */
export const INBOX_STEPS_OFF_TEXT =
  "steps_off: The person's thread steps are off, so nothing was written. They turn them on in the Plannotator Inbox's Settings → Capabilities; agents get the steps action in their next session.";

/** One step as an agent sends it: the schema advertises the limits, the store words the refusals. */
const STEP_ITEM = z
  .object({
    step: z.string().max(INBOX_STEP_TEXT_MAX),
    status: z.preprocess((value) => inboxStepStatusOf(value) ?? value, z.enum(INBOX_STEP_STATUSES)),
    note: z.string().max(INBOX_STEP_TEXT_MAX).optional(),
  })
  .strict();

/** The `steps` field: the steps tool's, and send_message's while steps are on. */
export const STEPS_FIELD = z.array(STEP_ITEM).max(INBOX_STEPS_MAX).describe(INBOX_STEPS_FIELD_DESCRIPTION);

export interface InboxStepsMcpContext {
  store: InboxStore;
  /** Whether the person has steps on, read on every request. Absent: off. */
  stepsOn?: () => boolean;
}

/** The author a call's filled fields name (the session keeps the list). */
export function stepsAgent(input: { agent_session?: string; agent_host?: string; agent_name?: string }): InboxAuthor {
  return { kind: "agent", host: input.agent_host?.trim() || null, session: input.agent_session?.trim() || null, name: inboxStoredAgentName(input.agent_name) };
}

/** "2 of 5 done; doing: Replay the failures" for a list. */
export function stepsProgressText(record: Pick<InboxSteps, "steps">): string {
  const { done, total, doing } = inboxStepsProgress(record.steps);
  return `${done} of ${total} done${doing ? `; doing: ${doing}` : ""}`;
}

/** Checks a list before a send, so a refused list never leaves a message sent without it. */
export function checkStepsInput(steps: unknown): void {
  const checked = normalizeInboxSteps(steps, [], new Date(0).toISOString());
  if ("error" in checked) throw new InboxError("validation_error", checked.error, { field: checked.field });
}

/**
 * A thread's lists as read_thread shows them, the reader's own first: one
 * head line per list, then one line per step. Empty while steps are off or
 * the thread has none.
 */
export function threadStepsText(store: InboxStore, threadId: string, reader: string | null): string[] {
  const lists = store.threadSteps(threadId).sort((a, b) => Number(b.agent.session === reader) - Number(a.agent.session === reader));
  const out: string[] = [];
  for (const list of lists) {
    const whose = list.agent.session === reader ? "Your steps" : `Steps of ${inboxAgentName(list.agent)} (${list.agent.session})`;
    out.push(`${whose} (${stepsProgressText(list)}; updated ${shortTime(list.updated_at)}):`);
    for (const step of list.steps) {
      const when = step.status === "done" ? ` (${shortTime(step.at)})` : "";
      out.push(`- ${step.status}: ${step.step}${step.note ? ` · ${step.note}` : ""}${when}`);
    }
  }
  return out;
}

/** The session's progress in a thread for a list row and the compaction line, or undefined (off, or no list). */
export function rowSteps(context: InboxStepsMcpContext, threadId: string, session: string | null): { done: number; total: number } | undefined {
  if (!session || !context.stepsOn?.()) return undefined;
  const list = context.store.stepsOf(threadId, session);
  if (!list) return undefined;
  const { done, total } = inboxStepsProgress(list.steps);
  return total > 0 ? { done, total } : undefined;
}

export function registerInboxStepsTool(server: McpServer, context: InboxStepsMcpContext): void {
  server.registerTool(
    "steps",
    {
      title: "Keep your steps in a thread",
      description: INBOX_STEPS_LEAD,
      inputSchema: z
        .object({
          thread_id: z.string().describe("The thread (or a message id in it)."),
          steps: STEPS_FIELD,
          agent_session: z.string().optional().describe("Your session id; the `plannotator inbox mcp` shim fills it. The list is your session's."),
          agent_name: z.string().optional().describe("How the person sees you, e.g. \"Claude Code\"."),
          agent_host: z.string().optional().describe("Your agent host, e.g. claude-code, codex, cursor."),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        // Turned off after this session listed the tool: refused, nothing written.
        if (!context.stepsOn?.()) throw new InboxError("steps_off", INBOX_STEPS_OFF_TEXT.replace(/^steps_off: /, ""));
        const { record, changed } = context.store.setThreadSteps({ thread_id: input.thread_id, agent: stepsAgent(input), steps: input.steps });
        // No record: an empty list from a session that never had one here; nothing written.
        const steps = record?.steps ?? [];
        const threadId = record?.thread_id ?? context.store.message(input.thread_id)?.thread_id ?? input.thread_id;
        const verb = steps.length === 0 ? (changed ? "Cleared your steps" : "No steps to clear") : changed ? "Steps saved" : "Steps unchanged";
        const progress = steps.length > 0 ? `: ${stepsProgressText({ steps })}` : "";
        return okComplete(`${verb} in thread ${threadId}${progress}. Nothing was sent to the person.`, {
          thread_id: threadId,
          changed,
          ...inboxStepsProgress(steps),
          steps,
        });
      }),
  );
}
