import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { MachineSnoozeAnswer } from "./inbox-machines";
import { guarded, okComplete } from "./inbox-mcp-result";

export const INBOX_SNOOZE_DESCRIPTION = "Only when the person asks: snooze a thread until a time, or end its snooze.";

export interface InboxSnoozeMcpContext {
  store: InboxStore;
  snoozeOnMachine?: (threadId: string, until: string | null) => Promise<MachineSnoozeAnswer | null>;
  snoozeMade?: () => void;
}

const line = (threadId: string, until: string | null, where = "") => (until === null ? `Thread ${threadId}${where} is not snoozed.` : `Thread ${threadId}${where} is snoozed until ${until}.`);

const ended = (threadId: string, where = "") => `Thread ${threadId}${where}: snooze ended.`;

const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An agent's `until` must be an ISO 8601 time with a zone: `Date.parse` alone reads a zone-less time in this Inbox's zone and guesses at formats like "12/25/2026". */
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
            const running = context.store.snoozedThreads().has(threadId);
            context.store.clearSnooze(threadId);
            if (running) return okComplete(ended(threadId), { thread_id: threadId, snoozed: null, ended: ended(threadId) });
            return okComplete(line(threadId, null), { thread_id: threadId, snoozed: null });
          }
          const snooze = context.store.setSnooze(threadId, input.until);
          context.snoozeMade?.();
          return okComplete(line(threadId, snooze.until), { thread_id: threadId, snoozed: { until: snooze.until, at: snooze.at } });
        }
        const far = await context.snoozeOnMachine?.(input.thread_id, input.until);
        if (!far) throw new InboxError("thread_not_found", `No thread ${input.thread_id}.`);
        if (input.until !== null) context.snoozeMade?.();
        if (far.held) return okComplete(far.held, { thread_id: input.thread_id, machine: far.machine, held: far.held });
        if (far.ended) {
          const words = ended(input.thread_id, ` on ${far.name}`);
          return okComplete(words, { thread_id: input.thread_id, machine: far.machine, snoozed: null, ended: words });
        }
        return okComplete(line(input.thread_id, far.snoozed?.until ?? null, ` on ${far.name}`), { thread_id: input.thread_id, machine: far.machine, snoozed: far.snoozed });
      }),
  );
}
