/**
 * Snooze for agents: the `snooze_thread` tool (the `plannotator_inbox` action of
 * that name, and `plannotator inbox call snooze_thread`). An agent the person
 * asked can snooze a thread, on this machine or a linked one, and end the
 * snooze. It is the person's Snooze, by the same rules: `InboxStore.setSnooze`
 * here, the forward and the outbox for another machine's thread. It writes no
 * message and reads as nothing in `read_thread` (approval "inbox-snooze").
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { MachineSnoozeAnswer } from "./inbox-machines";
import { guarded, okComplete } from "./inbox-mcp-result";

export const INBOX_SNOOZE_DESCRIPTION = "Only when the person asks: snooze a thread until a time, or end its snooze.";

export interface InboxSnoozeMcpContext {
  store: InboxStore;
  /** A thread only a linked machine holds, through the forward and the outbox. Null: no linked machine lists it. Absent: no machines here. */
  snoozeOnMachine?: (threadId: string, until: string | null) => Promise<MachineSnoozeAnswer | null>;
  /** A snooze went through (the one-time announcement never shows, as for the person's own). */
  snoozeMade?: () => void;
}

const line = (threadId: string, until: string | null, where = "") => (until === null ? `Thread ${threadId}${where} is not snoozed.` : `Thread ${threadId}${where} is snoozed until ${until}.`);

const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * An agent's `until` is an ISO 8601 time with its zone: `Date.parse` alone takes a time with no zone (read in this
 * Inbox's zone, not the person's) and guesses at "12/25/2026" or "Nov 12". The person's own window always sends one.
 */
function refuseAgentUntil(until: string): void {
  const match = ISO_WITH_ZONE.exec(until);
  const day = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || !day || Number.isNaN(Date.parse(until)) || day.getUTCMonth() + 1 !== Number(match[2]) || day.getUTCDate() !== Number(match[3])) {
    throw new InboxError("validation_error", "until: an ISO 8601 time with its zone, like 2026-11-05T08:00:00-05:00.", { field: "until" });
  }
}

export function registerInboxSnoozeTool(server: McpServer, context: InboxSnoozeMcpContext): void {
  server.registerTool(
    "snooze_thread",
    {
      title: "Snooze a thread",
      description: INBOX_SNOOZE_DESCRIPTION,
      inputSchema: z
        .object({
          thread_id: z.string().describe("Thread or message id."),
          until: z.union([z.string(), z.null()]).describe("Only if the person asks. How: plannotator inbox --help"),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        if (!input.thread_id.trim()) throw new InboxError("validation_error", "thread_id: required.", { field: "thread_id" });
        if (input.until !== null) refuseAgentUntil(input.until);
        const threadId = context.store.message(input.thread_id)?.thread_id ?? null;
        if (threadId) {
          if (input.until === null) {
            context.store.clearSnooze(threadId);
            return okComplete(line(threadId, null), { thread_id: threadId, snoozed: null });
          }
          const snooze = context.store.setSnooze(threadId, input.until);
          context.snoozeMade?.();
          return okComplete(line(threadId, snooze.until), { thread_id: threadId, snoozed: { until: snooze.until, at: snooze.at } });
        }
        const far = await context.snoozeOnMachine?.(input.thread_id, input.until);
        if (!far) throw new InboxError("thread_not_found", `No thread ${input.thread_id}.`);
        if (input.until !== null) context.snoozeMade?.();
        if (far.held) return okComplete(far.held, { thread_id: input.thread_id, machine: far.machine, held: true });
        return okComplete(line(input.thread_id, far.snoozed?.until ?? null, ` on ${far.name}`), { thread_id: input.thread_id, machine: far.machine, snoozed: far.snoozed });
      }),
  );
}
