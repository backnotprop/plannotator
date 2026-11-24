/**
 * Swarm mode for agents: the `swarm` tool (the `plannotator_inbox` action of that name, and
 * `plannotator inbox call swarm`). An agent in a thread says in one line what it is doing (`doing`) and reads what
 * every agent of the thread is doing: the view (inbox-swarm-view.ts). Any thread, on or off: the result says which.
 * The line is kept in the thread's swarm record (`InboxSwarms`, inbox/swarms.json), never as a message. Every word
 * the agent reads is in packages/shared/inbox/swarm-words.ts.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxSwarms } from "@plannotator/shared/inbox/swarms";
import { INBOX_SWARM_ACTION_LINE, INBOX_SWARM_FIELD_DESCRIPTIONS, inboxSwarmResultText } from "@plannotator/shared/inbox/swarm-words";
import { farThreadWords } from "./inbox-mcp-far-read";
import { guarded, okComplete, PROJECT_PATH_DESCRIPTION } from "./inbox-mcp-result";
import { createInboxSwarmView, type InboxSwarmView } from "./inbox-swarm-view";

export interface InboxSwarmMcpContext {
  store: InboxStore;
  /** The Inbox's one record of swarm threads. Absent (a test, a bare server): read from the store's folder for this call. */
  swarms?: InboxSwarms;
  /** The thread's view with every agent's live state (inbox-swarm-view.ts). Absent: the view without the agents list. */
  swarmView?: (threadId: string) => InboxSwarmView | null;
  /** The name of the linked machine whose list names this thread id, or null. Absent: no machines here. */
  farThreadMachine?: (threadId: string) => string | null;
}

export function registerInboxSwarmTool(server: McpServer, context: InboxSwarmMcpContext): void {
  server.registerTool(
    "swarm",
    {
      title: "Swarm: who is doing what",
      description: INBOX_SWARM_ACTION_LINE,
      inputSchema: z
        .object({
          thread_id: z.string().describe(INBOX_SWARM_FIELD_DESCRIPTIONS.thread_id),
          doing: z.string().optional().describe(INBOX_SWARM_FIELD_DESCRIPTIONS.doing),
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          agent_session: z.string().optional().describe("Your session id; the `plannotator inbox mcp` shim fills it."),
          agent_name: z.string().optional().describe("How the person sees you, e.g. \"Claude Code\"."),
          agent_host: z.string().optional().describe("Your agent host, e.g. claude-code, codex, cursor."),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(() => {
        const id = input.thread_id.trim();
        if (!id) throw new InboxError("validation_error", "thread_id: required.", { field: "thread_id" });
        const threadId = context.store.message(id)?.thread_id ?? null;
        if (!threadId || !context.store.thread(threadId)) {
          const far = context.farThreadMachine?.(id) ?? null;
          if (far) throw new InboxError("thread_on_other_machine", farThreadWords(id, far));
          throw new InboxError("thread_not_found", `No thread ${id}.`);
        }
        const swarms = context.swarms ?? new InboxSwarms(context.store.dir);
        const session = input.agent_session?.trim() || "";
        // `doing` left out, or empty: only look.
        const saved = input.doing !== undefined && input.doing.trim() !== "" ? (swarms.say(threadId, session, input.doing).doing.find((d) => d.session === session)?.text ?? null) : null;
        const viewOf = context.swarmView ?? createInboxSwarmView({ store: context.store, swarms }).swarmViewOf;
        const view = viewOf(threadId) ?? { thread_id: threadId, on: false, members: [] };
        const text = inboxSwarmResultText({ thread_id: threadId, on: view.on, members: view.members, me: session || null, saved });
        return okComplete(text, { thread_id: threadId, on: view.on, members: view.members, ...(saved ? { saved } : {}) });
      }),
  );
}
