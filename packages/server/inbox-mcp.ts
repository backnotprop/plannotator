/**
 * Plannotator Inbox: the MCP tools, served statelessly on the Inbox's `/mcp`
 * (packages/server/inbox.ts) and reached by agents through the stdio shim
 * `plannotator inbox mcp`, which fills `project_path` from its working folder
 * and `agent_session` with the agent host session it runs inside, else its own
 * `ses_` id.
 *
 * The tool list is fixed. Success is `structuredContent` plus one line of
 * text (the reply's text in full for wait_for_reply); a refusal is `isError`
 * with `<snake_code>: <message>`. Agents ask, people decide: no tool answers a
 * question, approves or sends on the person's behalf.
 */

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { QUESTION_AUTHORING_GUIDE } from "@plannotator/core/question-block";
import { INBOX_SECTIONS, INBOX_THREAD_NAME_MAX, type InboxGuideRef, type InboxSectionId, type InboxLine, type InboxMessage, type InboxProject } from "@plannotator/core/inbox-types";
import { INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { recordAgentDecision } from "./inbox-decisions";
import type { InboxAttachment } from "@plannotator/core/inbox-types";
import { registerInboxGuideTools } from "./inbox-guides";
import { isInsideFolder, type InboxProjectRoot } from "./inbox-project-root";

/** wait_for_reply's default hold: inside the 45-55 s window hosts' own tool timeouts allow. */
export const INBOX_WAIT_DEFAULT_MS = 50_000;
export const INBOX_WAIT_MAX_SECONDS = 50;

export const INBOX_MCP_TOOLS = ["send_message", "read_thread", "resolve_message", "wait_for_reply", "list_decisions", "record_decision", "get_guide_brief", "submit_guide"] as const;

/** Under Claude Code's 2,048-character cap on server instructions. */
export const INBOX_MCP_INSTRUCTIONS = [
  "Plannotator Inbox: a local window on this machine where the person reads what you send and answers when they can, without holding your session open.",
  "",
  "Use it when the person may not be watching this chat: a decision only they can make (ask it as a :::question block, then go on with other work), finished long work to hand over (a short summary, the files to look at in `attachments`), or when they ask you to. Ask in the chat instead when they are there; do not send routine progress.",
  "",
  "- send_message posts markdown. Your messages join your session's thread until the person resolves it; pass `thread` (a short name) to keep separate work apart, or reply_to to answer a message. Pass an idempotency_key so a retry never posts twice. The question syntax is in send_message's description.",
  "- attachments: paths of files to show the person (a plan, a screenshot, an HTML mock, any file), absolute or relative to project_path. Link one from the body (`[the mock](mock.html)`) to open it beside the thread. The person's annotations come back in their reply.",
  "- wait_for_reply (thread_id) returns the reply as soon as it lands, or { status: \"waiting\", cursor } after about 50 seconds: call it again with that cursor. Call it when you need the answer, after the work that does not depend on it.",
  "- read_thread reads one thread (thread_id) or lists yours. When an open question of yours no longer fits, send with reply_to into its thread with `supersedes` instead of leaving it open. resolve_message archives the thread for the person; use it only when nothing in it is left for them to read or answer.",
  "- list_decisions reads what holds in this project; record_decision records one you settled with the person. `Decision: when answered` in a question block records its answer.",
  "- To walk the person through a code change: get_guide_brief, write the guide, then submit_guide with the exact patch.",
  "",
  "The reply is the person's answer, framed as theirs: their words, then \"Answers to your questions\". No tool answers or approves on the person's behalf.",
].join("\n");

/**
 * Claude Code passes an MCP description to the model up to its first 2,048
 * characters, and the question guide alone is longer, so the lead stays this
 * short: the routing rules live in the server instructions and in `thread`'s
 * own description, and the guide's rules on WHAT to ask still reach the model.
 */
export const SEND_MESSAGE_DESCRIPTION = [
  "Message the person in the Plannotator Inbox (markdown), in your session's open thread (see `thread`). One message per real need.",
  "",
  QUESTION_AUTHORING_GUIDE,
].join("\n");

/**
 * `supersedes`, as an agent reads it (a field description reaches the model
 * whole; send_message's own description is cut at 2,048 characters).
 */
export const SUPERSEDES_DESCRIPTION =
  "Earlier questions in this thread that no longer apply, so the person cannot answer them any more. Withdraw your own questions that are still open (read_thread state open or picked; a sent, skipped or closed one is refused) this way as the thread moves on: when this message replaces them, makes them moot or follows up on them, or the person's reply settled them in words, so they stop keeping the thread at the top of the person's list. \"<message id>/<key>\" for one question (read_thread gives each question's key) or \"<message id>\" for every open question of that message. With exactly one question in this message, it replaces them; otherwise they read \"No longer applies\". To replace one with a particular new question, put `Replaces: <message id>/<key>` in that question's block instead. The person's pick on a superseded question is never sent. Every id must name an open question of the thread this message lands in (use reply_to); otherwise nothing is sent and the refusal, invalid_supersedes, lists the thread's open questions.";

/**
 * The Inbox-only `Stopped:` / `Holds up:` lines, as a whole block. The body
 * field's description carries it; inbox.test.ts parses it with the store's
 * own parser.
 */
export const INBOX_STOP_EXAMPLE = [
  ":::question",
  "Which database password should I use for staging?",
  "",
  "Stopped: can't run the migration without it",
  "Holds up: staging deploy; release notes",
  "",
  "- [ ] The one in 1Password \"staging-db\"",
  "- [ ] Make a new one",
  ":::",
].join("\n");

/**
 * send_message's `body`, as an agent reads it. The `Stopped:` and `Holds up:`
 * lines live here, not in QUESTION_AUTHORING_GUIDE (shared with plan review,
 * where they mean nothing) and not in send_message's own description (cut at
 * 2,048 characters, already filled by the guide): a field description reaches
 * the model whole, and the `plannotator_inbox` tool carries it on its `body`.
 */
const sectionLabel = (id: InboxSectionId): string => INBOX_SECTIONS.find((section) => section.id === id)?.label ?? id;

export const SEND_BODY_DESCRIPTION = [
  "The message, markdown. Question blocks render as answerable cards.",
  "",
  "Two Inbox-only lines a question block can carry, each on its own line after the question:",
  `- \`Stopped: <why>\` only when you truly cannot go on until this is answered: the thread goes first in the person's list, under "${sectionLabel("stopped")}". Otherwise leave the line out. A negative value (\`no\`, \`none\`, \`n/a\`, \`-\`) means no stop, so never write \`Stopped: no\`.`,
  `- \`Holds up: <work>; <work>\` names the work that waits on the answer while you go on: listed under "${sectionLabel("holding")}" (a \`Stopped:\` line wins). A \`none\` entry holds nothing up.`,
  "",
  INBOX_STOP_EXAMPLE,
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
  supersedes: z
    .array(z.string())
    .optional()
    .describe(SUPERSEDES_DESCRIPTION),
  idempotency_key: z.string().optional().describe("Any unique string; sending again with the same key answers the first message instead of posting twice."),
  agent_session: z.string().optional().describe(AGENT_SESSION_DESCRIPTION),
  agent_name: z.string().optional().describe("How the person sees you, e.g. \"Claude Code\"."),
  agent_host: z.string().optional().describe("Your agent host, e.g. claude-code, codex, cursor."),
};

export interface InboxMcpContext {
  store: InboxStore;
  /** The Inbox's base URL, `http://localhost:<port>/`. */
  baseUrl: () => string;
  /** The project for a path an agent named (realpath, git toplevel, a linked worktree folding into its main repository), created on first use. */
  resolveProject: (path: string) => Promise<InboxProject>;
  /**
   * Where a path an agent named files (packages/server/inbox-project-root.ts),
   * the resolution `resolveProject` uses. A message sent from a linked
   * worktree folded into its project keeps that folder as its `base_path`.
   * Absent: only a subfolder of the project's root is kept.
   */
  projectRootOf?: (path: string) => Promise<InboxProjectRoot>;
  /**
   * Record the files a message attaches (realpath, from anywhere on disk, the
   * file rules, a blob of the bytes): `base` resolves relative paths. Absent:
   * attachments are refused.
   */
  recordAttachments?: (paths: readonly string[], project: InboxProject, base: string) => Promise<InboxAttachment[]>;
  /** wait_for_reply's default hold in ms (tests pass a shorter one only through timeout_seconds). */
  waitDefaultMs?: number;
  /**
   * Presence from MCP activity, for "the session that asked has ended": a
   * tool call naming an `agent_session` counts as seen, and an open
   * wait_for_reply holds the session present while it waits
   * (packages/server/inbox-sessions.ts).
   */
  presence?: { seen: (session: string) => void; hold: (session: string) => () => void };
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Whether the caller's connection delivers the person's reply into its
 * session as a turn (`INBOX_WAKES_META_KEY` on the `tools/call`): the
 * Claude Code mod, Pi and OpenCode 2 while their wake runs. The stdio shim,
 * raw MCP clients, OpenCode 1 and older connections do not say so.
 */
export function callerWakes(ctx: unknown): boolean {
  const meta = (ctx as { mcpReq?: { _meta?: Record<string, unknown> } } | undefined)?.mcpReq?._meta;
  return meta?.[INBOX_WAKES_META_KEY] === true;
}

/** The send tools' last sentence for a caller whose reply arrives by itself. */
export const INBOX_REPLY_ARRIVES_TEXT =
  "The person's reply arrives in this session by itself, as a new message once the session is idle: end your turn, or go on with other work; do not call wait_for_reply.";

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
  // A New message reached the session it was addressed to (only that session's
  // wait returns it): delivered, so its connection does not wake it again.
  if (reply.to) store.recordDelivery(reply.id, { host: reply.to.host, session: reply.to.session });
  // The agent now has this reply (not any later one): a Sent row moves to Quiet.
  store.markAgentChecked(reply.thread_id, cursor);
  const questions = reply.reply_to ? store.questionsOf(reply.reply_to) : [];
  const subject = store.threadSubject(reply.thread_id);
  return {
    content: [
      {
        type: "text",
        text: `The person replied in thread ${reply.thread_id}${subject ? ` (${subject})` : ""}:\n\n${reply.body}`,
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
  /** Earlier questions of the thread this message supersedes (`<message id>` or `<message id>/<key>`). */
  supersedes?: string[];
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

/**
 * The folder an agent sent from, when it is not the project's root
 * (`InboxMessage.base_path`): relative image paths in its body, and links to
 * its attachments, start there. Kept when it is a subfolder of the project,
 * or when it lies in a linked worktree of the project's repository (a
 * worktree folds into the main repository's project, but the agent's files
 * are in the worktree, wherever on disk that is).
 */
async function sendBasePath(context: InboxMcpContext, projectPath: string | undefined, project: InboxProject): Promise<string | null> {
  if (!projectPath || !isAbsolute(projectPath)) return null;
  let real: string;
  try {
    real = realpathSync(projectPath);
  } catch {
    return null;
  }
  if (real === project.root) return null;
  if (isInsideFolder(real, project.root)) return real;
  const resolved = await context.projectRootOf?.(projectPath).catch(() => null);
  return resolved && resolved.worktree !== null && resolved.root === project.root ? real : null;
}

/** An agent's message into `project`, routed by the store (send_message, submit_guide). */
export async function sendAgentMessage(
  context: InboxMcpContext,
  project: InboxProject,
  input: AgentSendInput,
  guide?: InboxGuideRef,
  wakes = false,
): Promise<{ structured: Record<string, unknown>; replayed: boolean; questions: number; attachments: number; superseded: number }> {
  const { store } = context;
  let attachments: InboxAttachment[] | undefined;
  if (input.attachments && input.attachments.length > 0) {
    if (!context.recordAttachments) throw new InboxError("validation_error", "attachments: not taken by this Inbox.");
    const base = input.project_path && isAbsolute(input.project_path) ? input.project_path : project.root;
    attachments = await context.recordAttachments(input.attachments, project, base);
  }
  const basePath = await sendBasePath(context, input.project_path, project);
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
    base_path: basePath,
    supersedes: input.supersedes ?? null,
    ...(wakes ? { wakes: true } : {}),
  });
  const message = result.message;
  const landed = store.project(message.project_id)!;
  const questions = (message.questions ?? []).map((q) => ({ key: q.key, kind: q.kind, prompt: q.prompt }));
  const superseded = store.supersededBy(message.id);
  return {
    superseded: superseded.length,
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
      /** The earlier questions this message superseded (`<message id>/<key>`). */
      superseded,
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
          body: z.string().min(1).describe(SEND_BODY_DESCRIPTION),
          ...SEND_ROUTING_FIELDS,
          attachments: z
            .array(z.string())
            .optional()
            .describe(
              "Files to show the person beside your message, e.g. [\"docs/plan.md\", \"/tmp/checkout.png\", \"src/retry.mjs\"]: absolute (anywhere you can read) or relative to project_path. Any regular file, any size. Markdown, plain text, config and data files, Mermaid and Graphviz sources and HTML (its relative images and frames load from its folder) open in Plannotator's viewers; images (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO) show in the message; source code, scripts and other text open as code with line comments; PDFs and anything else are offered as a download. Folders and .env files are refused. The Inbox keeps the version you sent and shows the file as it is now, saying when it changed. The person's annotations, including comments on images and code lines, come back in their reply. Each attachment's kind in the result is markdown, text, html, mermaid, graphviz, code, image, pdf or file; treat any other as file. A markdown link to an attached file in the body, e.g. [the mock](proto/admin.html), opens it beside the thread.",
            ),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, ctx) =>
      guarded(async () => {
        const project = await sendProject(context, input);
        const sent = await sendAgentMessage(context, project, input, undefined, callerWakes(ctx));
        const asked =
          (sent.questions > 0 ? ` asking ${sent.questions} question${sent.questions === 1 ? "" : "s"}` : "") +
          (sent.attachments > 0 ? ` with ${sent.attachments} attachment${sent.attachments === 1 ? "" : "s"}` : "") +
          (sent.superseded > 0 ? `, superseding ${sent.superseded} earlier question${sent.superseded === 1 ? "" : "s"}` : "");
        return ok(
          `${sent.replayed ? "Already sent" : "Sent"} to the Plannotator Inbox${asked} (thread ${sent.structured.thread_id}, ${sent.structured.url}). ${callerWakes(ctx) ? INBOX_REPLY_ARRIVES_TEXT : "Call wait_for_reply with this thread_id for the answer, or go on and read_thread later."}`,
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
        // A thread an agent wrote in after its archive line still takes a reply: listed like an open one.
        if (!input.include_resolved) threads = threads.filter((t) => t.resolved_at === null || t.agent_after_archive === true);
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
      description:
        "Archive the thread a message belongs to for the person; use it only when nothing in it is left for them to read or answer. resolved: false reopens it. Its questions read as closed; the person sees the thread as Archived.",
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
        // An open wait is presence: the session that asked is not "ended" while it waits here.
        const holder = input.agent_session?.trim();
        const release = holder ? context.presence?.hold(holder) : undefined;
        try {
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
              .filter((t) => t.resolved_at === null || t.agent_after_archive === true)
              .map((t) => t.thread_id);
          }
          const caller = input.agent_session?.trim() || null;
          const thresholds = new Map(threadIds.map((id) => [id, input.cursor ?? lastAgentCursor(store, id, caller)]));
          // A New message (step 8) belongs to the session the person picked: it
          // never answers another session's wait.
          const forCaller = (message: InboxMessage) => !message.to || message.to.session === caller;

          const findExisting = (): InboxMessage | null => {
            let best: { message: InboxMessage; seq: number } | null = null;
            for (const [threadId, threshold] of thresholds) {
              for (const message of store.thread(threadId)?.messages ?? []) {
                if (message.author.kind !== "person" || !forCaller(message)) continue;
                const seq = store.messageCursor(message.id) ?? 0;
                if (seq > threshold && (!best || seq < best.seq)) best = { message, seq };
              }
            }
            return best?.message ?? null;
          };

          const existing = findExisting();
          if (existing) return replyResult(store, existing, context.baseUrl());
          // A resolved thread takes no reply: say so now instead of holding the call.
          // (An agent that wrote after the archive line can still get a reply there.)
          if (single && store.message(single)?.resolved_at != null && !store.agentAfterArchive(single)) {
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
                if (message.author.kind === "person" && forCaller(message) && line.seq > threshold && store.messageCursor(message.id) === line.seq) {
                  finish({ kind: "reply", message });
                } else if (message.id === message.thread_id && message.resolved_at !== null && threadIds.length === 1 && !store.agentAfterArchive(message.id)) {
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
        } finally {
          release?.();
        }
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
