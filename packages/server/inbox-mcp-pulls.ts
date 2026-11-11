/**
 * A thread's PRs for agents (approval "inbox-pr-binding", 2026-11-08): the
 * `thread_pulls` tool, send_message's `pulls` field, and the lines
 * read_thread adds. The thread's agent owns the list; the person can change
 * it too (the window's popover), and the agent hears of that on its next
 * wake. Always on: no switch, and nothing runs for a thread without PRs.
 *
 * Who may change a thread's PRs: the person, and an agent in the thread
 * (`store.isThreadMember`). Anyone else is refused, nothing written. Reading
 * them (read_thread, `thread_pulls` with neither `add` nor `remove`) is open
 * to any agent that may read the thread.
 *
 * Reached by the `plannotator_inbox` tool's action "thread_pulls" (the
 * Claude Code mod, Pi, OpenCode, DeepSeek Harness, Cline), the stdio shim,
 * `plannotator inbox call thread_pulls` and `plannotator inbox pulls`
 * (apps/hook/server/inbox-pulls-command.ts).
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { inboxStoredAgentName } from "@plannotator/core/inbox-format";
import {
  inboxAgentName,
  inboxThreadPullText,
  INBOX_THREAD_PULLS_MAX,
  INBOX_THREAD_PULLS_REMOVED_MS,
  parseInboxThreadPullRefs,
  type InboxThreadPull,
  type InboxThreadPullActor,
  type InboxThreadPullChecks,
  type InboxThreadPullRef,
  type InboxThreadPullReview,
} from "@plannotator/core/inbox-types";
import {
  INBOX_PULLS_FIELD_DESCRIPTION,
  INBOX_THREAD_PULLS_ADD_DESCRIPTION,
  INBOX_THREAD_PULLS_DESCRIPTION,
  INBOX_THREAD_PULLS_REMOVE_DESCRIPTION,
} from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore, InboxThreadPullsChange } from "@plannotator/shared/inbox/store";
import { sessionWho, shortTime, type SessionNameOf } from "./inbox-mcp-read";
import { guarded, okComplete } from "./inbox-mcp-result";
import { noteSessionRead } from "./inbox-session-reads";

/** What a change by an agent outside the thread answers: nothing is written. */
export const INBOX_NOT_IN_THREAD_TEXT = "Only the person or an agent in this thread can change its PRs. Send in the thread first, or ask the person.";

/** send_message's `pulls` field (the approved words). */
export const PULLS_FIELD = z.array(z.string()).describe(INBOX_PULLS_FIELD_DESCRIPTION);

/** What the tools need of the state reader: what it knows now (checks), and a read of the PRs just added. */
export interface InboxPullsMcpLive {
  live(key: string): { checks: InboxThreadPullChecks | null; review: InboxThreadPullReview | null } | undefined;
  refresh(pulls: readonly InboxThreadPull[]): Promise<void>;
}

export interface InboxPullsMcpContext {
  store: InboxStore;
  /** The state reader (packages/server/inbox-thread-pulls.ts). Absent: states as stored, no read. */
  pulls?: InboxPullsMcpLive;
  now?: () => number;
  /** Another session's name, as the person's window shows it (inbox-mcp-read.ts `sessionWho`). */
  sessionName?: SessionNameOf;
}

/** The agent a call's filled fields name. */
export function pullsActor(input: { agent_session?: string; agent_host?: string; agent_name?: string }): InboxThreadPullActor | null {
  const session = input.agent_session?.trim();
  if (!session) return null;
  return { kind: "agent", session, host: input.agent_host?.trim() || null, name: inboxStoredAgentName(input.agent_name) };
}

/** A list of refs read, or a validation_error naming the field (nothing is changed). */
export function checkPullRefs(values: unknown, field: string): InboxThreadPullRef[] {
  const parsed = parseInboxThreadPullRefs(values, field);
  if ("error" in parsed) throw new InboxError("validation_error", parsed.error, { field: parsed.field });
  if (parsed.refs.length > INBOX_THREAD_PULLS_MAX) {
    throw new InboxError("validation_error", `${field}: at most ${INBOX_THREAD_PULLS_MAX} PRs (this list has ${parsed.refs.length}); nothing was changed.`, { field });
  }
  return parsed.refs;
}

function who(actor: InboxThreadPullActor, reader: string | null, at: string, withTime: boolean, names?: SessionNameOf): string {
  if (actor.kind === "person") return `the person ${shortTime(at)}`;
  if (actor.session === reader) return "you";
  return `${sessionWho(inboxAgentName({ kind: "agent", host: actor.host, name: actor.name }), actor.session, names?.(actor.session))}${withTime ? ` ${shortTime(at)}` : ""}`;
}

function stateWords(pull: InboxThreadPull, live: InboxPullsMcpContext["pulls"]): string {
  const state = pull.state === "unknown" ? "state unknown" : pull.state;
  const checks = pull.state === "open" || pull.state === "draft" ? live?.live(pull.pull)?.checks : null;
  return checks ? `${state} · checks ${checks}` : state;
}

/**
 * A thread's PRs as read_thread and `thread_pulls` show them: a head line,
 * one line per PR (its ref, state and who added it), then each PR removed in
 * the last 7 days that is not back, with who removed it. Empty for a thread
 * that never had one.
 */
export function threadPullsText(context: InboxPullsMcpContext, threadId: string, reader: string | null): string[] {
  const { store } = context;
  const now = context.now?.() ?? Date.now();
  const live = store.threadPulls(threadId);
  const removed = store.threadPullsRemoved(threadId, new Date(now - INBOX_THREAD_PULLS_REMOVED_MS).toISOString());
  if (live.length === 0 && removed.length === 0) return [];
  const out = [live.length > 0 ? `PRs (${live.length}):` : "PRs: none on this thread now."];
  for (const pull of live) out.push(`- ${inboxThreadPullText(pull)} ${stateWords(pull, context.pulls)} · added by ${who(pull.added_by, reader, pull.added_at, false, context.sessionName)}`);
  for (const pull of removed) out.push(`Removed by ${who(pull.removed_by!, reader, pull.removed_at!, false, context.sessionName)}: ${inboxThreadPullText(pull)}`);
  return out;
}

/** The structured list a tool answers with. */
function structuredPulls(context: InboxPullsMcpContext, pulls: readonly InboxThreadPull[]) {
  return pulls.map((pull) => ({
    ref: inboxThreadPullText(pull),
    url: pull.url,
    state: pull.state,
    ...(context.pulls?.live(pull.pull)?.checks ? { checks: context.pulls.live(pull.pull)!.checks } : {}),
    title: pull.title,
    added_by: pull.added_by,
    added_at: pull.added_at,
  }));
}

/**
 * Change a thread's PRs for an agent: refused (`not_in_thread`, nothing
 * written) unless the session is in the thread. The PRs just added are read
 * at once, so the answer can say their state.
 */
export async function changePullsAsAgent(
  context: InboxPullsMcpContext,
  input: { thread_id: string; add: InboxThreadPullRef[]; remove: InboxThreadPullRef[] | "all"; actor: InboxThreadPullActor | null },
): Promise<InboxThreadPullsChange> {
  const { store } = context;
  const root = store.message(input.thread_id?.trim?.() ?? "")?.thread_id;
  if (!root) throw new InboxError("thread_not_found", `No thread or message ${input.thread_id}.`, { field: "thread_id" });
  if (!input.actor || input.actor.kind !== "agent" || !store.isThreadMember(root, input.actor.session)) {
    throw new InboxError("not_in_thread", INBOX_NOT_IN_THREAD_TEXT, { field: "thread_id" });
  }
  const change = store.changeThreadPulls({ thread_id: root, add: input.add, remove: input.remove, by: input.actor });
  if (change.added.length > 0 && context.pulls) {
    // Bounded: a slow forge never holds the answer for long (the state then says unknown, and loads on the next pass).
    await Promise.race([context.pulls.refresh(change.added), new Promise((resolve) => setTimeout(resolve, 4000))]);
  }
  return change;
}

/** One line of what a change did, for a tool's answer: "Added …. Removed …. Not on this thread: …." */
export function pullsChangeText(change: Pick<InboxThreadPullsChange, "added" | "already" | "removed" | "missing">): string {
  const refs = (pulls: readonly { pull: string; url: string }[]) => pulls.map((pull) => inboxThreadPullText(pull)).join(", ");
  return [
    change.added.length > 0 ? `Added ${refs(change.added)}.` : "",
    change.already.length > 0 ? `Already on this thread: ${refs(change.already)}.` : "",
    change.removed.length > 0 ? `Removed ${refs(change.removed)}.` : "",
    change.missing.length > 0 ? `Not on this thread: ${change.missing.map((ref) => inboxThreadPullText({ pull: ref.key, url: ref.url })).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function registerInboxThreadPullsTool(server: McpServer, context: InboxPullsMcpContext): void {
  const { store } = context;
  server.registerTool(
    "thread_pulls",
    {
      title: "A thread's pull/merge requests",
      description: INBOX_THREAD_PULLS_DESCRIPTION,
      inputSchema: z
        .object({
          thread_id: z.string().describe("Thread or message id."),
          add: z.array(z.string()).optional().describe(INBOX_THREAD_PULLS_ADD_DESCRIPTION),
          remove: z.array(z.string()).optional().describe(INBOX_THREAD_PULLS_REMOVE_DESCRIPTION),
          project_path: z.string().optional(),
          agent_session: z.string().optional(),
          agent_name: z.string().optional(),
          agent_host: z.string().optional(),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        const root = store.message(input.thread_id?.trim() ?? "")?.thread_id;
        if (!root) throw new InboxError("thread_not_found", `No thread or message ${input.thread_id}.`, { field: "thread_id" });
        // Every ref is read before anything is written: one bad ref changes nothing.
        const add = input.add ? checkPullRefs(input.add, "add") : [];
        const all = input.remove?.length === 1 && input.remove[0]!.trim().toLowerCase() === "all";
        const remove = all ? "all" : input.remove ? checkPullRefs(input.remove, "remove") : [];
        const reader = input.agent_session?.trim() || null;
        let changed = "";
        let change: InboxThreadPullsChange | null = null;
        if (add.length > 0 || remove === "all" || remove.length > 0) {
          change = await changePullsAsAgent(context, { thread_id: root, add, remove, actor: pullsActor(input) });
          changed = pullsChangeText(change);
        }
        // The session has now seen the thread's PRs: the next wake says only what the person changed after this.
        noteSessionRead(store, reader, root, context.now?.() ?? Date.now());
        const lines = threadPullsText(context, root, reader);
        const head = `Thread ${root}${changed ? `: ${changed}` : ""}${change ? " Nothing was sent to the person." : ""}`;
        return okComplete([head, ...(lines.length > 0 ? lines : ["No PRs on this thread."])].join("\n"), {
          thread_id: root,
          ...(change ? { changed: change.added.length + change.removed.length > 0 } : {}),
          pulls: structuredPulls(context, store.threadPulls(root)),
        });
      }),
  );
}
