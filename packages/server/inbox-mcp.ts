/**
 * Plannotator Inbox: the MCP tools, served statelessly on the Inbox's `/mcp`
 * (packages/server/inbox.ts) and reached by agents through the stdio shim
 * `plannotator inbox mcp`, which fills `project_path` from its working folder
 * and `agent_session` with its own `ses_` id.
 *
 * The tool list is fixed. Success is `structuredContent` plus one line of
 * text (the reply's text in full for wait_for_reply); a refusal is `isError`
 * with `<snake_code>: <message>`. Agents ask, people decide: no tool answers a
 * question, approves or sends on the person's behalf.
 */

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { QUESTION_AUTHORING_GUIDE } from "@plannotator/core/question-block";
import type { InboxLine, InboxMessage, InboxProject, InboxThreadSummary } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** wait_for_reply's default hold: inside the 45-55 s window hosts' own tool timeouts allow. */
export const INBOX_WAIT_DEFAULT_MS = 50_000;
export const INBOX_WAIT_MAX_SECONDS = 50;

export const INBOX_MCP_TOOLS = ["send_message", "read_thread", "resolve_message", "wait_for_reply"] as const;

/** Under Claude Code's 2,048-character cap on server instructions. */
export const INBOX_MCP_INSTRUCTIONS = [
  "Plannotator Inbox: send the person a message and get their answer without holding your session on a review tab. The Inbox runs on this machine; the person reads your message there and answers when they can.",
  "",
  "- send_message posts markdown to the person, as a new thread or a reply (reply_to). Ask what you cannot decide alone as question blocks (:::question, :::question-multi, :::question-text); send_message's description has the syntax. Pass an idempotency_key so a retry never posts twice.",
  "- After sending, either go on with other work or call wait_for_reply with the thread_id. It returns the person's reply as soon as it lands, or { status: \"waiting\", cursor } after about 50 seconds; call it again with that cursor to keep waiting.",
  "- read_thread reads one thread (thread_id) or lists your threads in this project.",
  "- resolve_message closes a thread once you have what you needed.",
  "",
  "The reply is the person's answer to you, framed as theirs: their words, then an \"Answers to your questions\" section. There is no tool to answer or approve on the person's behalf.",
].join("\n");

const SEND_MESSAGE_DESCRIPTION = [
  "Send the person a markdown message in the Plannotator Inbox: a new thread, or a reply in one (reply_to). Returns the message and thread ids; the answer comes back through wait_for_reply or read_thread.",
  "",
  QUESTION_AUTHORING_GUIDE,
].join("\n");

const PROJECT_PATH_DESCRIPTION =
  "Absolute path of the repository or folder you work in; the thread lands in that project's row. The `plannotator inbox mcp` shim fills it from its working folder.";
const AGENT_SESSION_DESCRIPTION =
  "Your session id. The `plannotator inbox mcp` shim fills it; read_thread's asked_by \"me\" and wait_for_reply without a thread match on it.";

export interface InboxMcpContext {
  store: InboxStore;
  /** The Inbox's base URL, `http://localhost:<port>/`. */
  baseUrl: () => string;
  /** The project for a path an agent named (realpath, git toplevel), created on first use. */
  resolveProject: (path: string) => Promise<InboxProject>;
  /** wait_for_reply's default hold in ms (tests pass a shorter one only through timeout_seconds). */
  waitDefaultMs?: number;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(line: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: line }], structuredContent: structured };
}

function fail(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

async function guarded(run: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InboxError) return fail(error.code, error.message);
    return fail("internal_error", error instanceof Error ? error.message : String(error));
  }
}

function threadUrl(base: string, threadId: string): string {
  return `${base}#thread=${threadId}`;
}

function threadOf(store: InboxStore, input: { thread_id?: string; message_id?: string }): string | null {
  if (input.thread_id) {
    const root = store.message(input.thread_id);
    if (!root || root.thread_id !== root.id) throw new InboxError("thread_not_found", `No thread ${input.thread_id}.`);
    return root.id;
  }
  if (input.message_id) {
    const message = store.message(input.message_id);
    if (!message) throw new InboxError("message_not_found", `No message ${input.message_id}.`);
    return message.thread_id;
  }
  return null;
}

/** Threads whose root the given agent session sent. */
function threadsAskedBy(store: InboxStore, session: string, projectId: string | null): InboxThreadSummary[] {
  const projects = projectId ? [projectId] : store.listProjects().map((p) => p.id);
  return projects
    .flatMap((id) => store.threadsOf(id))
    .filter((t) => t.author.kind === "agent" && t.author.session === session);
}

/** The seq of the last agent message in a thread: replies after it are new to the agent. */
function lastAgentCursor(store: InboxStore, threadId: string): number {
  const thread = store.thread(threadId);
  let cursor = 0;
  for (const message of thread?.messages ?? []) {
    if (message.author.kind === "agent") cursor = Math.max(cursor, store.messageCursor(message.id) ?? 0);
  }
  return cursor;
}

function replyResult(store: InboxStore, reply: InboxMessage, base: string): ToolResult {
  const cursor = store.messageCursor(reply.id) ?? store.cursor();
  const questions = reply.reply_to ? store.questionsOf(reply.reply_to) : [];
  const root = store.message(reply.thread_id);
  return {
    content: [
      {
        type: "text",
        text: `The person replied in thread ${reply.thread_id}${root?.subject ? ` (${root.subject})` : ""}:\n\n${reply.body}`,
      },
    ],
    structuredContent: {
      status: "replied",
      thread_id: reply.thread_id,
      reply: { message_id: reply.id, reply_to: reply.reply_to, body: reply.body, created_at: reply.created_at },
      questions,
      cursor,
      url: threadUrl(base, reply.thread_id),
    },
  };
}

export function createInboxMcpServer(context: InboxMcpContext): McpServer {
  const { store } = context;
  const server = new McpServer(
    { name: "plannotator-inbox", version: "1.0.0" },
    { instructions: INBOX_MCP_INSTRUCTIONS, capabilities: { tools: {} } },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to the person",
      description: SEND_MESSAGE_DESCRIPTION,
      inputSchema: z
        .object({
          body: z.string().min(1).describe("The message, markdown. Question blocks render as answerable cards."),
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          subject: z.string().optional().describe("A short subject for a new thread. Default: the first question's prompt, else the first line."),
          reply_to: z.string().optional().describe("A message id: post this as a reply in that message's thread."),
          idempotency_key: z.string().optional().describe("Any unique string; sending again with the same key answers the first message instead of posting twice."),
          agent_session: z.string().optional().describe(AGENT_SESSION_DESCRIPTION),
          agent_name: z.string().optional().describe("How the person sees you, e.g. \"Claude Code\"."),
          agent_host: z.string().optional().describe("Your agent host, e.g. claude-code, codex, cursor."),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        let projectId: string;
        if (input.reply_to) {
          const parent = store.message(input.reply_to);
          if (!parent) throw new InboxError("message_not_found", `No message ${input.reply_to}.`);
          projectId = parent.project_id;
        } else {
          if (!input.project_path) {
            throw new InboxError("validation_error", "project_path: required for a new thread (the shim fills it from its folder).");
          }
          projectId = (await context.resolveProject(input.project_path)).id;
        }
        const result = store.sendMessage({
          project_id: projectId,
          author: {
            kind: "agent",
            host: input.agent_host?.trim() || null,
            session: input.agent_session?.trim() || null,
            name: input.agent_name?.trim() || null,
          },
          body: input.body,
          subject: input.subject ?? null,
          reply_to: input.reply_to ?? null,
          idempotency_key: input.idempotency_key ?? null,
        });
        const message = result.message;
        const project = store.project(message.project_id)!;
        const questions = (message.questions ?? []).map((q) => ({ key: q.key, kind: q.kind, prompt: q.prompt }));
        const url = threadUrl(context.baseUrl(), message.thread_id);
        const asked = questions.length > 0 ? ` asking ${questions.length} question${questions.length === 1 ? "" : "s"}` : "";
        return ok(
          `${result.replayed ? "Already sent" : "Sent"} to the Plannotator Inbox${asked} (thread ${message.thread_id}, ${url}). Call wait_for_reply with this thread_id for the answer, or go on and read_thread later.`,
          {
            message_id: message.id,
            thread_id: message.thread_id,
            project: { id: project.id, name: project.name, root: project.root },
            questions,
            replayed: result.replayed,
            cursor: store.messageCursor(message.id) ?? store.cursor(),
            url,
          },
        );
      }),
  );

  server.registerTool(
    "read_thread",
    {
      title: "Read a thread, or list your threads",
      description:
        "Read one Inbox thread (thread_id or message_id): every message with its questions and the person's answers. Without an id, list this project's threads, newest first: only the ones you asked unless asked_by is \"anyone\", and only open ones unless include_resolved.",
      inputSchema: z
        .object({
          thread_id: z.string().optional(),
          message_id: z.string().optional(),
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          asked_by: z.enum(["me", "anyone"]).optional().describe("Default \"me\" when your session is known."),
          include_resolved: z.boolean().optional(),
          limit: z.number().int().min(1).max(100).optional().describe("Threads to list (default 20)."),
          agent_session: z.string().optional().describe(AGENT_SESSION_DESCRIPTION),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        const threadId = threadOf(store, input);
        if (threadId) {
          const thread = store.thread(threadId)!;
          const replies = thread.messages.filter((m) => m.author.kind === "person").length;
          return ok(
            `Thread ${threadId}${thread.subject ? ` (${thread.subject})` : ""}: ${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"}, ${replies} from the person${thread.resolved_at ? ", resolved" : ""}.`,
            { thread, url: threadUrl(context.baseUrl(), threadId) },
          );
        }
        if (!input.project_path) throw new InboxError("validation_error", "project_path: required to list threads (or pass thread_id).");
        const project = await context.resolveProject(input.project_path);
        const session = input.agent_session?.trim() || null;
        const askedBy = input.asked_by ?? (session ? "me" : "anyone");
        if (askedBy === "me" && !session) throw new InboxError("validation_error", "asked_by: \"me\" needs agent_session.");
        let threads = askedBy === "me" ? threadsAskedBy(store, session!, project.id) : store.threadsOf(project.id);
        if (!input.include_resolved) threads = threads.filter((t) => t.resolved_at === null);
        const limit = input.limit ?? 20;
        const total = threads.length;
        threads = threads.slice(0, limit);
        return ok(`${total} thread${total === 1 ? "" : "s"} in ${project.name}${total > limit ? `, showing ${limit}` : ""}.`, {
          project: { id: project.id, name: project.name, root: project.root },
          threads,
          total,
        });
      }),
  );

  server.registerTool(
    "resolve_message",
    {
      title: "Resolve a thread",
      description: "Close the thread a message belongs to once you have what you needed (resolved: false reopens it). Its questions read as closed.",
      inputSchema: z
        .object({
          message_id: z.string().describe("Any message id in the thread, or the thread id."),
          resolved: z.boolean().optional().describe("Default true."),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(() => {
        const summary = store.resolveThread(input.message_id, input.resolved ?? true);
        return ok(`Thread ${summary.thread_id} is ${summary.resolved_at ? "resolved" : "open"}.`, { thread: summary });
      }),
  );

  server.registerTool(
    "wait_for_reply",
    {
      title: "Wait for the person's reply",
      description:
        "Wait for the person's reply in a thread (thread_id or message_id), or in any open thread you asked when neither is given. Returns the reply as soon as it lands, or { status: \"waiting\", cursor } after about 50 seconds: call again with that cursor to keep waiting. Without a cursor, any reply after your last message in the thread counts.",
      inputSchema: z
        .object({
          thread_id: z.string().optional(),
          message_id: z.string().optional(),
          cursor: z.number().int().min(0).optional().describe("The cursor a previous call returned."),
          timeout_seconds: z.number().int().min(1).max(INBOX_WAIT_MAX_SECONDS).optional().describe("Wait at most this long (default 50)."),
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          agent_session: z.string().optional().describe(AGENT_SESSION_DESCRIPTION),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, ctx) =>
      guarded(async () => {
        const single = threadOf(store, input);
        let threadIds: string[];
        if (single) {
          threadIds = [single];
        } else {
          const session = input.agent_session?.trim();
          if (!session) throw new InboxError("validation_error", "thread_id: required (or agent_session, to wait on every thread you asked).");
          const projectId = input.project_path ? (await context.resolveProject(input.project_path)).id : null;
          threadIds = threadsAskedBy(store, session, projectId)
            .filter((t) => t.resolved_at === null)
            .map((t) => t.thread_id);
        }
        const thresholds = new Map(threadIds.map((id) => [id, input.cursor ?? lastAgentCursor(store, id)]));

        const findExisting = (): InboxMessage | null => {
          let best: { message: InboxMessage; seq: number } | null = null;
          for (const [threadId, threshold] of thresholds) {
            for (const message of store.thread(threadId)?.messages ?? []) {
              if (message.author.kind !== "person") continue;
              const seq = store.messageCursor(message.id) ?? 0;
              if (seq > threshold && (!best || seq < best.seq)) best = { message, seq };
            }
          }
          return best?.message ?? null;
        };

        const existing = findExisting();
        if (existing) return replyResult(store, existing, context.baseUrl());
        // A resolved thread takes no reply: say so now instead of holding the call.
        if (single && store.message(single)?.resolved_at != null) {
          return ok(`Thread ${single} is resolved; no reply will come.`, { status: "resolved", thread_id: single, cursor: store.cursor() });
        }

        const waitMs = input.timeout_seconds ? input.timeout_seconds * 1000 : (context.waitDefaultMs ?? INBOX_WAIT_DEFAULT_MS);
        const signal: AbortSignal | undefined = ctx?.mcpReq?.signal;
        const outcome = await new Promise<{ kind: "reply"; message: InboxMessage } | { kind: "resolved"; threadId: string } | { kind: "timeout" }>(
          (resolve) => {
            let done = false;
            const finish = (value: Parameters<typeof resolve>[0]) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              unsubscribe();
              signal?.removeEventListener("abort", onAbort);
              resolve(value);
            };
            const onAbort = () => finish({ kind: "timeout" });
            const timer = setTimeout(() => finish({ kind: "timeout" }), waitMs);
            const unsubscribe = store.subscribe((line: InboxLine) => {
              if (line.kind !== "message") return;
              const message = line.record;
              const threshold = thresholds.get(message.thread_id);
              if (threshold === undefined) return;
              if (message.author.kind === "person" && line.seq > threshold && store.messageCursor(message.id) === line.seq) {
                finish({ kind: "reply", message });
              } else if (message.id === message.thread_id && message.resolved_at !== null && threadIds.length === 1) {
                finish({ kind: "resolved", threadId: message.id });
              }
            });
            signal?.addEventListener("abort", onAbort);
          },
        );
        if (outcome.kind === "reply") return replyResult(store, outcome.message, context.baseUrl());
        const cursor = store.cursor();
        if (outcome.kind === "resolved") {
          return ok(`The person resolved thread ${outcome.threadId} without a reply.`, { status: "resolved", thread_id: outcome.threadId, cursor });
        }
        return ok(
          `No reply yet. Call wait_for_reply again with cursor ${cursor} to keep waiting, or go on and check later.`,
          { status: "waiting", cursor, thread_ids: threadIds },
        );
      }),
  );

  return server;
}
