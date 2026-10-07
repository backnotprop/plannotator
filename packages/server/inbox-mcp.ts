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

import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { QUESTION_AUTHORING_GUIDE } from "@plannotator/core/question-block";
import { INBOX_THREAD_NAME_MAX, type InboxGuideRef, type InboxLine, type InboxMessage, type InboxProject } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { recordAgentDecision } from "./inbox-decisions";
import type { InboxAttachment } from "@plannotator/core/inbox-types";
import { registerInboxGuideTools } from "./inbox-guides";

/** wait_for_reply's default hold: inside the 45-55 s window hosts' own tool timeouts allow. */
export const INBOX_WAIT_DEFAULT_MS = 50_000;
export const INBOX_WAIT_MAX_SECONDS = 50;

export const INBOX_MCP_TOOLS = ["send_message", "read_thread", "resolve_message", "wait_for_reply", "list_decisions", "record_decision", "get_guide_brief", "submit_guide"] as const;

/** Under Claude Code's 2,048-character cap on server instructions. */
export const INBOX_MCP_INSTRUCTIONS = [
  "Plannotator Inbox: send the person a message and get their answer without holding your session on a review tab. The Inbox runs on this machine; the person reads your message there and answers when they can.",
  "",
  "- send_message posts markdown to the person. Your messages land in one thread, your session's, until the person resolves it; pass `thread` (a short name) to keep separate work in its own thread, or to join another session's thread of that name; reply_to answers one message. Ask what you cannot decide alone as question blocks (:::question, :::question-multi, :::question-text); send_message's description has the syntax. Pass an idempotency_key so a retry never posts twice.",
  "- After sending, either go on with other work or call wait_for_reply with the thread_id. It returns the person's reply as soon as it lands, or { status: \"waiting\", cursor } after about 50 seconds; call it again with that cursor to keep waiting.",
  "- To show the person files (a plan, an HTML prototype, a diagram), pass them in send_message's attachments, e.g. [\"docs/plan.md\"]. They open and annotate them in the Inbox; their annotations come back in the reply after the answers.",
  "- read_thread reads one thread (thread_id) or lists the threads you sent in, in this project.",
  "- resolve_message closes a thread once you have what you needed.",
  "- list_decisions reads what holds in this project: decisions the person recorded from answers, or agents recorded. record_decision records one you settled with the person. Add `Decision: when answered` to a question block to have its answer recorded.",
  "- To walk the person through a code change, call get_guide_brief, write the guide, then submit_guide with the guide and the exact patch: it opens in Plannotator's guide viewer.",
  "",
  "The reply is the person's answer to you, framed as theirs: their words, then an \"Answers to your questions\" section. There is no tool to answer or approve on the person's behalf.",
].join("\n");

/**
 * Claude Code passes an MCP description to the model up to its first 2,048
 * characters, and the question guide alone is longer, so the lead stays this
 * short: the routing rules live in the server instructions and in `thread`'s
 * own description, and the guide's rules on WHAT to ask still reach the model.
 */
export const SEND_MESSAGE_DESCRIPTION = [
  "Message the person in the Plannotator Inbox (markdown), in your session's open thread (see `thread`). The answer comes back via wait_for_reply.",
  "",
  QUESTION_AUTHORING_GUIDE,
].join("\n");

const PROJECT_PATH_DESCRIPTION =
  "Absolute path of the repository or folder you work in; the thread lands in that project's row. The `plannotator inbox mcp` shim fills it from its working folder.";
const AGENT_SESSION_DESCRIPTION =
  "Your session id. The `plannotator inbox mcp` shim fills it. send_message joins your session's thread by it; read_thread's asked_by \"me\" and wait_for_reply without a thread match on it.";

/**
 * The fields every sending tool takes beside its content (send_message and
 * submit_guide): where the message lands and who sent it.
 */
export const SEND_ROUTING_FIELDS = {
  project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
  subject: z.string().optional().describe("A short subject when this starts a thread (ignored when it joins one). Default: the first question's prompt, else the first line."),
  thread: z
    .string()
    .optional()
    .describe(
      `A short thread name (1-${INBOX_THREAD_NAME_MAX} characters, one line). Without it, your messages join your session's open thread in this project (a new one the first time, or once the person resolved it; a thread keeps its first subject). With it, the same name in this project is the same open thread, across sessions (compared without case, spacing or invisible characters). Use it to split separate work, or to join another session's thread. Ignored with reply_to.`,
    ),
  reply_to: z.string().optional().describe("A message id: post this as a reply in that message's thread."),
  idempotency_key: z.string().optional().describe("Any unique string; sending again with the same key answers the first message instead of posting twice."),
  agent_session: z.string().optional().describe(AGENT_SESSION_DESCRIPTION),
  agent_name: z.string().optional().describe("How the person sees you, e.g. \"Claude Code\"."),
  agent_host: z.string().optional().describe("Your agent host, e.g. claude-code, codex, cursor."),
};

export interface InboxMcpContext {
  store: InboxStore;
  /** The Inbox's base URL, `http://localhost:<port>/`. */
  baseUrl: () => string;
  /** The project for a path an agent named (realpath, git toplevel), created on first use. */
  resolveProject: (path: string) => Promise<InboxProject>;
  /**
   * Record the files a message attaches (realpath, inside the project, the
   * file rules, a blob of the bytes): `base` resolves relative paths. Absent:
   * attachments are refused.
   */
  recordAttachments?: (paths: readonly string[], project: InboxProject, base: string) => InboxAttachment[];
  /** wait_for_reply's default hold in ms (tests pass a shorter one only through timeout_seconds). */
  waitDefaultMs?: number;
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function ok(line: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: line }], structuredContent: structured };
}

export function fail(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

export async function guarded(run: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
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

/**
 * The seq of the waiting agent's last message in a thread: replies after it
 * are new to it. A thread can hold several sessions' messages (a named thread,
 * a reply_to into another session's thread), so it is the CALLER's last
 * message when its session wrote in the thread; another session writing after
 * the person replied must not hide that reply. Without a session, or when the
 * session never wrote there, the last agent message of any session.
 */
function lastAgentCursor(store: InboxStore, threadId: string, session: string | null): number {
  const thread = store.thread(threadId);
  let any = 0;
  let mine = 0;
  for (const message of thread?.messages ?? []) {
    if (message.author.kind !== "agent") continue;
    const seq = store.messageCursor(message.id) ?? 0;
    any = Math.max(any, seq);
    if (session && message.author.session === session) mine = Math.max(mine, seq);
  }
  return mine || any;
}

function replyResult(store: InboxStore, reply: InboxMessage, base: string): ToolResult {
  const cursor = store.messageCursor(reply.id) ?? store.cursor();
  // The agent now has this reply (not any later one): a Sent row moves to Quiet.
  store.markAgentChecked(reply.thread_id, cursor);
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

export type AgentSendInput = {
  body: string;
  project_path?: string;
  subject?: string;
  thread?: string;
  reply_to?: string;
  idempotency_key?: string;
  /** Files to attach (send_message only): absolute, or relative to project_path. */
  attachments?: string[];
  agent_session?: string;
  agent_name?: string;
  agent_host?: string;
};

/** The project a send lands in: reply_to's, else the one at project_path. */
export async function sendProject(context: InboxMcpContext, input: { reply_to?: string; project_path?: string }): Promise<InboxProject> {
  if (input.reply_to) {
    const parent = context.store.message(input.reply_to);
    if (!parent) throw new InboxError("message_not_found", `No message ${input.reply_to}.`);
    return context.store.project(parent.project_id)!;
  }
  if (!input.project_path) {
    throw new InboxError("validation_error", "project_path: required for a new thread (the shim fills it from its folder).");
  }
  return context.resolveProject(input.project_path);
}

/** An agent's message into `project`, routed by the store (send_message, submit_guide). */
export function sendAgentMessage(
  context: InboxMcpContext,
  project: InboxProject,
  input: AgentSendInput,
  guide?: InboxGuideRef,
): { structured: Record<string, unknown>; replayed: boolean; questions: number; attachments: number } {
  const { store } = context;
  let attachments: InboxAttachment[] | undefined;
  if (input.attachments && input.attachments.length > 0) {
    if (!context.recordAttachments) throw new InboxError("validation_error", "attachments: not taken by this Inbox.");
    const base = input.project_path && isAbsolute(input.project_path) ? input.project_path : project.root;
    attachments = context.recordAttachments(input.attachments, project, base);
  }
  const result = store.sendMessage({
    project_id: project.id,
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
    thread: input.thread ?? null,
    attachments,
    guide: guide ?? null,
  });
  const message = result.message;
  const landed = store.project(message.project_id)!;
  const questions = (message.questions ?? []).map((q) => ({ key: q.key, kind: q.kind, prompt: q.prompt }));
  return {
    replayed: result.replayed,
    questions: questions.length,
    attachments: message.attachments?.length ?? 0,
    structured: {
      message_id: message.id,
      thread_id: message.thread_id,
      /** True when this message started the thread. */
      new_thread: message.thread_id === message.id,
      thread_name: store.message(message.thread_id)?.thread_name ?? null,
      project: { id: landed.id, name: landed.name, root: landed.root },
      questions,
      attachments: (message.attachments ?? []).map((a) => ({ id: a.id, name: a.name, kind: a.kind, path: a.path })),
      replayed: result.replayed,
      cursor: store.messageCursor(message.id) ?? store.cursor(),
      url: threadUrl(context.baseUrl(), message.thread_id),
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
          ...SEND_ROUTING_FIELDS,
          attachments: z
            .array(z.string())
            .optional()
            .describe(
              "Files for the person to open and annotate beside your message, e.g. [\"docs/plan.md\", \"proto/admin.html\", \"flow.mmd\"]: absolute, or relative to project_path, inside the project. Markdown, plain text, config and data files, Mermaid and Graphviz sources, and HTML (its relative images and frames load from its folder); .env is refused. The Inbox keeps the version you sent and shows the file as it is now, saying when it changed. The person's annotations come back in their reply.",
            ),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        const project = await sendProject(context, input);
        const sent = sendAgentMessage(context, project, input);
        const asked =
          (sent.questions > 0 ? ` asking ${sent.questions} question${sent.questions === 1 ? "" : "s"}` : "") +
          (sent.attachments > 0 ? ` with ${sent.attachments} attachment${sent.attachments === 1 ? "" : "s"}` : "");
        return ok(
          `${sent.replayed ? "Already sent" : "Sent"} to the Plannotator Inbox${asked} (thread ${sent.structured.thread_id}, ${sent.structured.url}). Call wait_for_reply with this thread_id for the answer, or go on and read_thread later.`,
          sent.structured,
        );
      }),
  );

  server.registerTool(
    "read_thread",
    {
      title: "Read a thread, or list your threads",
      description:
        "Read one Inbox thread (thread_id or message_id): every message with its questions and the person's answers. Without an id, list this project's threads, newest activity first, each with its section in the person's list: only the ones you sent in unless asked_by is \"anyone\", and only open ones unless include_resolved.",
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
          store.markAgentChecked(threadId);
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
        let threads = store.listRows({ projectId: project.id, session: askedBy === "me" ? session : null });
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
          threadIds = store
            .listRows({ projectId, session })
            .filter((t) => t.resolved_at === null)
            .map((t) => t.thread_id);
        }
        const caller = input.agent_session?.trim() || null;
        const thresholds = new Map(threadIds.map((id) => [id, input.cursor ?? lastAgentCursor(store, id, caller)]));

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

  // ── Step 3: decisions (the rules: packages/server/inbox-decisions.ts) ──

  server.registerTool(
    "list_decisions",
    {
      title: "List the project's decisions",
      description:
        "List the decisions that hold in this project (state \"current\", the default), or the replaced, retired or all of them, oldest first. Each has text, reason, source (an answer the person sent, an agent's record_decision, or the person's own words), state, version and, for a replaced one, replacement_id.",
      inputSchema: z
        .object({
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          state: z.enum(["current", "replaced", "retired", "all"]).optional().describe("Default \"current\"."),
          agent_session: z.string().optional().describe(AGENT_SESSION_DESCRIPTION),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        if (!input.project_path) throw new InboxError("validation_error", "project_path: required (the shim fills it from its folder).");
        const project = await context.resolveProject(input.project_path);
        const state = input.state ?? "current";
        const decisions = store.decisionsOf(project.id).filter((d) => state === "all" || d.state === state);
        const label = state === "all" ? "" : ` ${state}`;
        return ok(`${decisions.length}${label} decision${decisions.length === 1 ? "" : "s"} in ${project.name}.`, {
          project: { id: project.id, name: project.name, root: project.root },
          decisions,
        });
      }),
  );

  server.registerTool(
    "record_decision",
    {
      title: "Record a decision in the project",
      description:
        "Record a decision that now holds in this project, one you settled with the person (it shows on their Decisions page as recorded by you). text is the decision as one statement, e.g. \"Webhooks are verified before any database write.\"; reason says why. To have the person's answer to a question recorded instead, write `Decision: when answered` in the question block.",
      inputSchema: z
        .object({
          text: z.string().min(1).describe("The decision, one statement."),
          reason: z.string().optional().describe("Why it holds."),
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          idempotency_key: z.string().optional().describe("Any unique string; recording again with the same key answers the first decision."),
          agent_session: z.string().optional().describe(AGENT_SESSION_DESCRIPTION),
          agent_name: z.string().optional().describe("How the person sees you, e.g. \"Claude Code\"."),
          agent_host: z.string().optional().describe("Your agent host, e.g. claude-code, codex, cursor."),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        if (!input.project_path) throw new InboxError("validation_error", "project_path: required (the shim fills it from its folder).");
        const project = await context.resolveProject(input.project_path);
        const { decision, replayed } = recordAgentDecision(store, {
          project_id: project.id,
          text: input.text,
          reason: input.reason ?? null,
          agent: { host: input.agent_host?.trim() || null, session: input.agent_session?.trim() || null, name: input.agent_name?.trim() || null },
          idempotency_key: input.idempotency_key ?? null,
        });
        return ok(`${replayed ? "Already recorded" : "Recorded"} in ${project.name}'s decisions (${decision.id}).`, {
          decision,
          project: { id: project.id, name: project.name, root: project.root },
          replayed,
          url: `${context.baseUrl()}#decisions=${project.id}&decision=${decision.id}`,
        });
      }),
  );

  // Guided reviews (step 5): packages/server/inbox-guides.ts.
  registerInboxGuideTools(server, context);

  return server;
}
