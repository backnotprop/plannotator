/**
 * Plannotator Inbox: the MCP tools, served statelessly on the Inbox's `/mcp`
 * (packages/server/inbox.ts) and reached by agents through the stdio shim
 * `plannotator inbox mcp`, which fills `project_path` from its working folder
 * and `agent_session` with the agent host session it runs inside, else its own
 * `ses_` id.
 *
 * The tool list is fixed. Success is `structuredContent` plus one line of
 * text; a refusal is `isError` with `<snake_code>: <message>`. Agents ask,
 * people decide: no tool answers a question, approves or sends on the
 * person's behalf.
 */

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { QUESTION_AUTHORING_GUIDE } from "@plannotator/core/question-block";
import { inboxStoredAgentName } from "@plannotator/core/inbox-format";
import { inboxQuestionKeysWithRecommendedMarker } from "@plannotator/core/inbox-questions";
import { INBOX_ACTION_EXAMPLE, INBOX_ACTION_GUIDE, INBOX_DONE_DESCRIPTION } from "@plannotator/core/inbox-actions";
import { checkInboxSubject, INBOX_CARD_ACTION_ON, inboxTidyMcpLine, INBOX_NAME_THIS_THREAD_HINT, INBOX_SECTIONS, isInboxNote, INBOX_THREAD_NAME_MAX, type InboxGuideRef, type InboxSectionId, type InboxMessage, type InboxProject } from "@plannotator/core/inbox-types";
import { INBOX_AGENT_RULES, INBOX_PEEK_META_KEY, INBOX_REF_LINK_RULE, INBOX_REPLY_TO_CHECK, INBOX_WAKES_META_KEY, INBOX_WORKING_FOLDER_META_KEY } from "@plannotator/shared/inbox/connection";
import { inboxSectionOf } from "@plannotator/shared/inbox/list";
import { bodyShowsLocalImages, captureInboxInlineImages, type InlineImageFailure } from "@plannotator/shared/inbox/inline-images";
import { inboxMessageRemoteImageRefsInOrder } from "@plannotator/shared/inbox/message-images";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxSendResult, InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxAttachment, InboxListRow } from "@plannotator/core/inbox-types";
import { registerInboxGuideTools } from "./inbox-guides";
import { lastContactOf, noteSessionRead, staleThreadOf, staleThreadText } from "./inbox-session-reads";
import { INBOX_BODY_CUT_BYTES, INBOX_EARLIER_PERSON_BYTES, INBOX_THREAD_WINDOW, clip, shortTime, sizeText, windowedThread, windowedThreadText } from "./inbox-mcp-read";
import { registerInboxSearchTool } from "./inbox-mcp-search";
import { registerInboxCardTool } from "./inbox-mcp-cards";
export { INBOX_BOARD_OFF_TEXT } from "./inbox-mcp-cards";
import { fail, guarded, ok, okComplete, PROJECT_PATH_DESCRIPTION, type ToolResult } from "./inbox-mcp-result";

// The result helpers live in inbox-mcp-result.ts (no import cycle for the tool modules); re-exported for older importers.
export { fail, guarded, ok, okComplete, PROJECT_PATH_DESCRIPTION, type ToolResult };
import type { InboxSearchIndex } from "@plannotator/shared/inbox/search";
import { isInsideFolder, type InboxProjectRoot } from "./inbox-project-root";

export const INBOX_MCP_TOOLS = ["send_message", "read_thread", "search", "resolve_message", "get_guide_brief", "submit_guide", "card"] as const;

/**
 * The tools this Inbox serves with the Board on: every one, except `card`
 * while INBOX_CARD_ACTION_ON holds it back in the code.
 */
export const INBOX_SERVED_TOOLS: readonly (typeof INBOX_MCP_TOOLS)[number][] = INBOX_MCP_TOOLS.filter((name) => name !== "card" || INBOX_CARD_ACTION_ON);

/**
 * The tools an Inbox serves by default: the Board is off until the person
 * turns it on (config.json `inboxBoard`, approval "inbox-board" 2026-10-26),
 * so `card` is not in its tools/list.
 */
export const INBOX_DEFAULT_SERVED_TOOLS: readonly (typeof INBOX_MCP_TOOLS)[number][] = INBOX_SERVED_TOOLS.filter((name) => name !== "card");


/**
 * Under Claude Code's 2,048-character cap on server instructions. Room for
 * INBOX_THREAD_RULE (in INBOX_AGENT_RULES) came from the attachments line's
 * examples, which the field's own description gives.
 */
export const INBOX_MCP_INSTRUCTIONS = [
  "Plannotator Inbox: a local window where the person reads what you send and answers later, without blocking your session.",
  "",
  INBOX_AGENT_RULES,
  "",
  "- send_message posts markdown. Messages join your session's thread until the person resolves it; pass `thread` (a short name) to keep separate work apart, or reply_to (an id from the Inbox, never from memory) to answer a message. Question syntax: send_message's description.",
  "- attachments: files to show the person; link one from the body (`[the mock](mock.html)`) to open it beside the thread.",
  "- send_message's result says whether the reply arrives in this session by itself. When it does not, go on with your work and read the thread later.",
  "- read_thread reads one thread (thread_id); without an id it lists yours (asked_by \"anyone\": all), and `unread` marks a thread the person wrote in. search finds older messages by words. resolve_message archives the thread, only when nothing in it is left for the person to read or answer.",
  "- A guided review of a code change: get_guide_brief, write the guide, then submit_guide with the exact patch.",
  "",
  "A reply is the person's own: their words, then \"Answers to your questions\"; no tool answers or approves for them.",
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
 * read_thread, as a raw MCP client reads it (the agent tool words its lead
 * itself, INBOX_AGENT_ACTION_LEADS). A thread read is a window, so a long
 * thread costs a few thousand tokens instead of the whole history.
 */
export const READ_THREAD_DESCRIPTION = `Read one Inbox thread (thread_id, or message_id to show that message in full) as a transcript: the questions still waiting on the person (key, state, prompt, choices), the newest messages in full (\`limit\`, default ${INBOX_THREAD_WINDOW}), the person's earlier messages in full (up to ${sizeText(INBOX_EARLIER_PERSON_BYTES)}), and every other earlier message as one line with its questions' states and answers; a body over ${sizeText(INBOX_BODY_CUT_BYTES)} is cut. \`expand\` shows messages in full, \`before\` reads further back, \`after\` (the result's cursor, or a message id) returns only what is new; \`format: "full"\` returns every full record. A message the person marked 👍 Looks good carries \`ack\` (they read it and need nothing more; no reply is needed). Without an id, list this project's threads, newest activity first, one short row each (subject, name, section in the person's list, open questions, last author and time, the person's last message, \`unread\`: the person wrote something you have not read): only the ones you sent in unless asked_by is "anyone", and only open ones unless include_resolved. ${INBOX_REPLY_TO_CHECK}`;

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
 * The optional contract lines (approval "inbox-decision-mode", agent contract
 * lines), as one block: the body field's description carries it, with the
 * rule that most questions need none of them. Taught only here and in the
 * connection's short `body`, never in QUESTION_AUTHORING_GUIDE (plan review;
 * Claude Code's 2,048-character cut). inbox.test.ts parses it with the
 * store's own parser.
 */
export const INBOX_CONTRACT_EXAMPLE = [
  ":::question",
  "Which checkout drawer should ship?",
  "Stakes: ships to all of checkout on Thursday; changing it later costs a week of QA.",
  "",
  "- [ ] A · Total on top — ![Drawer A](drawer-a.png) closest to today",
  "- [ ] B · Total pinned with Pay — ![Drawer B](drawer-b.png) the total never scrolls away",
  "",
  "Recommended: B · Total pinned with Pay",
  "",
  "Why: on a phone only B keeps the total next to the button.",
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
  "The message, markdown. Question blocks render as answerable cards. Blocks fenced as `mermaid` or `dot` draw as diagrams; one fenced as `html` draws as a live, sandboxed page in the message (chart, SVG, mock; https libraries load). Leave its background transparent; use var(--foreground), var(--chart-1)…var(--chart-5). Let content set its height: no vh units or height:100% on html or body.",
  INBOX_REF_LINK_RULE,
  "",
  "Two Inbox-only lines a question block can carry, each on its own line after the question:",
  `- \`Stopped: <why>\` only when you truly cannot go on until this is answered: the thread goes first in the person's list, under "${sectionLabel("stopped")}". Otherwise leave the line out. A negative value (\`no\`, \`none\`, \`n/a\`, \`-\`) means no stop, so never write \`Stopped: no\`.`,
  `- \`Holds up: <work>; <work>\` names the work that waits on the answer while you go on: listed under "${sectionLabel("holding")}" (a \`Stopped:\` line wins). A \`none\` entry holds nothing up.`,
  "",
  INBOX_STOP_EXAMPLE,
  "",
  "Optional lines after the question, for a decision that needs them. Most questions need none of these:",
  "- `Stakes: <one sentence>`: what the choice affects, in product terms. Give one whenever you write `Stopped:` or `Holds up:`.",
  "- `Shows: ![alt](path)` or `Shows: [name](file)`: the one picture or file the decision is about (put long detail in that file, not the block).",
  "- `Why: <one line>`, on its own line after `Recommended:`: why you recommend it.",
  "- `Reversible: no — <why>`: only when the answer cannot be taken back.",
  "- A picture choice, when the options are visual: `- [ ] Label — ![alt](path) consequence`. The picture picks it; the label is the answer you get back.",
  "",
  INBOX_CONTRACT_EXAMPLE,
  "",
  // Action items (approval "inbox-next-actions"): when to write one, and when not.
  INBOX_ACTION_GUIDE,
  "",
  INBOX_ACTION_EXAMPLE,
].join("\n");

const AGENT_SESSION_DESCRIPTION =
  "Your session id. The `plannotator inbox mcp` shim fills it. send_message joins your session's thread by it; read_thread's asked_by \"me\" matches on it.";

/**
 * The fields every sending tool takes beside its content (send_message and
 * submit_guide): where the message lands and who sent it.
 */
export const SEND_ROUTING_FIELDS = {
  project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
  subject: z.string().optional().describe("A short one-line subject when this starts a thread (ignored when it joins one). Plain text: no line breaks. Default: the first question's prompt, else the first line."),
  thread: z
    .string()
    .optional()
    .describe(
      `A short thread name (1-${INBOX_THREAD_NAME_MAX} characters, one line). Without it, your messages join your session's open thread in this project (a new one the first time, or once the person resolved it; a thread keeps its first subject). With it, the same name in this project is the same open thread, across sessions (compared without case, spacing or invisible characters). Use it to split separate work, or to join another session's thread. Ignored with reply_to, with one exception: in a thread the person started (read_thread says name_this_thread: true, or the Inbox's message asks you to name it), your reply's \`thread\` names that thread, once: a few words saying what it is about, not the name of another open thread in the project.`,
    ),
  reply_to: z.string().optional().describe(`A message id: post this as a reply in that message's thread. ${INBOX_REPLY_TO_CHECK}`),
  supersedes: z
    .array(z.string())
    .optional()
    .describe(SUPERSEDES_DESCRIPTION),
  done: z.array(z.string()).optional().describe(INBOX_DONE_DESCRIPTION),
  idempotency_key: z.string().optional().describe("Pass an idempotency_key so a retry never posts twice. Any unique string; sending again with the same key answers the first message."),
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
  /** The clock (epoch ms) send_message's "not read since" line compares with (inbox-session-reads.ts). Default: Date.now. Tests inject. */
  now?: () => number;
  /** The ⌘K search index (packages/server/inbox-search.ts), for the agents' read-only search tool. */
  searchIndex?: InboxSearchIndex;
  /**
   * The projects a path names, WITHOUT making one (search writes nothing):
   * the project at its root, plus the one an older Inbox kept for the very
   * worktree it lies in. `unresolved` when git did not answer in time and no
   * existing repository project holds the folder. Absent: search finds no
   * project for a path.
   */
  findProjects?: (path: string) => Promise<{ projects: InboxProject[]; unresolved: boolean }>;
  /**
   * Whether the Inbox itself knows the sender's session is woken by the
   * person's reply, whatever its own connection said: a Claude Code, Pi or
   * OpenCode session whose bridge polls now (the stdio shim run inside it
   * sends as that session, and the connection delivers the reply), or a Codex
   * thread the Inbox wakes itself (`meta`: the call's `_meta`; a thread id,
   * not `codex exec`, and a Codex CLI that runs `codex queue`;
   * packages/server/inbox-codex-wake.ts).
   * Absent: only a caller's own connection wakes it (`callerWakes`).
   */
  sessionWakes?: (host: unknown, session: unknown, meta: unknown) => Promise<boolean>;
  /**
   * Whether the Board is on (config.json `inboxBoard`, read on every
   * request). Off: `card` is not in tools/list, and a call (from a session
   * that listed it while it was on) gets `board_off` with nothing written.
   * Absent: on, as before the switch.
   */
  boardOn?: () => boolean;
}


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

/**
 * A connection's own read_thread list for the session's thread list (not a
 * call the agent made, INBOX_PEEK_META_KEY): it makes no project and does not
 * count as the session having looked at the threads it lists.
 */
export function callerPeeks(ctx: unknown): boolean {
  const meta = (ctx as { mcpReq?: { _meta?: Record<string, unknown> } } | undefined)?.mcpReq?._meta;
  return meta?.[INBOX_PEEK_META_KEY] === true;
}

/**
 * The folder the sender works in now, when its connection says so
 * (`INBOX_WORKING_FOLDER_META_KEY` on the `tools/call`: the Claude Code mod,
 * whose `project_path` is the folder the session started in while a shell
 * `cd` moves the agent). An absolute path of at most 4096 characters with no
 * control characters, else nothing (the send resolves as before).
 */
export function callerWorkingFolder(ctx: unknown): string | undefined {
  const value = (ctx as { mcpReq?: { _meta?: Record<string, unknown> } } | undefined)?.mcpReq?._meta?.[INBOX_WORKING_FOLDER_META_KEY];
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/**
 * Whether a sender's session is woken by the person's reply: its own
 * connection says so (`callerWakes`), or the Inbox knows that session is
 * woken (`sessionWakes`: its bridge polls now, or a Codex thread it wakes).
 */
export async function senderWakes(context: Pick<InboxMcpContext, "sessionWakes">, ctx: unknown, input: { agent_host?: string; agent_session?: string }): Promise<boolean> {
  if (callerWakes(ctx)) return true;
  if (!context.sessionWakes) return false;
  const meta = (ctx as { mcpReq?: { _meta?: unknown } } | undefined)?.mcpReq?._meta;
  return context.sessionWakes(input.agent_host?.trim(), input.agent_session?.trim(), meta).catch(() => false);
}

/**
 * Tidy for a session no connection wakes (MCP only): its wake note, once, at
 * the end of its next Inbox tool result (delivered then). A session that is
 * woken gets it from its connection when its turn ends instead.
 */
async function withTidy(context: InboxMcpContext, result: ToolResult, input: Record<string, unknown>, ctx: unknown): Promise<ToolResult> {
  const session = typeof input?.agent_session === "string" ? input.agent_session.trim() : "";
  if (!session || result.isError) return result;
  const note = context.store.pendingReplies(session).find((m) => m.tidy?.wake);
  if (!note) return result;
  const host = typeof input.agent_host === "string" ? input.agent_host : undefined;
  if (await senderWakes(context, ctx, { agent_host: host, agent_session: session })) return result;
  try {
    context.store.recordDelivery(note.id, { host: note.to?.host ?? host ?? "agent", session });
  } catch {
    return result;
  }
  const tidy = `\n\n${inboxTidyMcpLine(note.id)}\n\n${note.body}`;
  const content = [...result.content];
  const last = content.length - 1;
  if (last >= 0) content[last] = { ...content[last]!, text: `${content[last]!.text}${tidy}` };
  else content.push({ type: "text", text: tidy.trimStart() });
  return { ...result, content, ...(result.structuredContent ? { structuredContent: { ...result.structuredContent, tidy: { id: note.id, text: note.body } } } : {}) };
}

/** The send tools' last sentence for a caller whose reply arrives by itself. */
export const INBOX_REPLY_ARRIVES_TEXT =
  "The person's reply arrives in this session by itself, as a new message once the session is idle: end your turn, or go on with other work.";

/** The same place for a sender nothing wakes (an MCP client, OpenCode 1, an older connection, a session whose bridge does not poll): it reads the thread itself. */
export const INBOX_REPLY_READ_LATER_TEXT =
  "The person's reply won't arrive in this session by itself: go on with your work and call read_thread with this thread_id later.";


function threadUrl(base: string, threadId: string): string {
  return `${base}#thread=${threadId}`;
}

function threadOf(store: InboxStore, input: { thread_id?: string; message_id?: string }): string | null {
  if (input.thread_id) {
    const root = store.message(input.thread_id);
    if (!root || root.thread_id !== root.id) throw new InboxError("thread_not_found", `No thread ${input.thread_id}.`);
    if (input.message_id) {
      const message = store.message(input.message_id);
      if (!message) throw new InboxError("message_not_found", `No message ${input.message_id}.`);
      if (message.thread_id !== root.id) {
        throw new InboxError("validation_error", `message_id: ${input.message_id} is in thread ${message.thread_id}, not ${root.id}; pass one of them.`);
      }
    }
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
 * What a result adds while a thread the person started still has the name
 * the Inbox derived and the caller may name it (approval
 * "inbox-agent-names-own-thread"): `name_this_thread: true` and the hint, for
 * agents no wake reaches (MCP-only clients, OpenCode 1).
 */
function namingHint(store: InboxStore, threadId: string, session: string | null): { line: string; structured: { name_this_thread: true } } | null {
  return store.canNameThread(threadId, session) ? { line: `\n\n${INBOX_NAME_THIS_THREAD_HINT}`, structured: { name_this_thread: true } } : null;
}

export type AgentSendInput = {
  body: string;
  project_path?: string;
  subject?: string;
  thread?: string;
  reply_to?: string;
  idempotency_key?: string;
  /** Files to attach (send_message only): absolute, or relative to working_folder, else project_path. */
  attachments?: string[];
  /**
   * Not a tool field: the folder the agent works in now, from its connection
   * (`callerWorkingFolder`). Relative attachments and the body's relative
   * images and links resolve there instead of at project_path.
   */
  working_folder?: string;
  /** Earlier questions of the thread this message supersedes (`<message id>` or `<message id>/<key>`). */
  supersedes?: string[];
  /** Its own action items of the thread the agent saw done (`<message id>/<key>`, or `<message id>`). */
  done?: string[];
  agent_session?: string;
  agent_name?: string;
  agent_host?: string;
};

/** The project a send lands in: reply_to's, else the one at project_path. */
export async function sendProject(
  context: InboxMcpContext,
  input: { reply_to?: string; project_path?: string; thread?: string; subject?: string | null },
): Promise<InboxProject> {
  // Before anything resolves (resolving a path makes its project): a refused send writes nothing.
  refuseIdShapedThread(input.thread, input.reply_to);
  refuseBadSubject(input.subject);
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
 * The project a thread read from `path` covers (search), and the projects
 * whose threads it lists: that
 * project, plus the project an Inbox from before worktrees folded into their
 * repository made for the very worktree `path` is in (keyed by the
 * worktree's toplevel). Without it, an agent that asked from a worktree
 * before the upgrade would never find the person's reply after it: its
 * thread stays in that project, while `path` now resolves to the main one.
 */
export async function threadReadScope(context: InboxMcpContext, path: string): Promise<{ project: InboxProject; projectIds: Set<string> }> {
  const project = await context.resolveProject(path);
  const projectIds = new Set(context.store.projectGroup(project.id));
  const resolved = await context.projectRootOf?.(path).catch(() => null);
  const earlier = resolved?.worktree ? context.store.projectByRoot(resolved.worktree) : null;
  if (earlier) for (const id of context.store.projectGroup(earlier.id)) projectIds.add(id);
  return { project, projectIds };
}

/** Most projects read_thread's list names under an empty folder. */
const PROJECTS_INSIDE_MAX = 3;

/**
 * The known projects whose root lies strictly inside `path` (whole path
 * segments), with threads, most threads first. Reads only: no project is
 * made and none of their threads are merged into the list.
 */
async function projectsInside(context: InboxMcpContext, path: string, own: InboxProject | null, includeResolved: boolean): Promise<{ name: string; root: string; threads: number }[]> {
  const folder = (await context.projectRootOf?.(path).catch(() => null))?.folder ?? path;
  const found: { name: string; root: string; threads: number }[] = [];
  // Every folder: a combined project's may be the one inside `path`. One line for each group, and none for the caller's own.
  const counted = new Set(own ? [context.store.canonicalProjectId(own.id)] : []);
  for (const candidate of context.store.allProjects()) {
    if (candidate.root === folder || !isInsideFolder(candidate.root, folder)) continue;
    const group = context.store.canonicalProjectId(candidate.id);
    if (counted.has(group)) continue;
    counted.add(group);
    const rows = context.store.listRows({ projectId: candidate.id }).filter((row) => includeResolved || row.resolved_at === null || row.agent_after_archive === true);
    if (rows.length > 0) found.push({ name: candidate.name, root: candidate.root, threads: rows.length });
  }
  return found.sort((a, b) => b.threads - a.threads || a.root.localeCompare(b.root)).slice(0, PROJECTS_INSIDE_MAX);
}

/** The list rows of `projectIds` (every project when null), of one session's threads when given. */
function listScopedRows(store: InboxStore, projectIds: ReadonlySet<string> | null, session: string | null) {
  if (projectIds === null) return store.listRows({ session });
  if (projectIds.size === 1) return store.listRows({ projectId: [...projectIds][0]!, session });
  return store.listRows({ session }).filter((row) => projectIds.has(row.project.id));
}

/**
 * The folder an agent sent from, when it is not the project's root
 * (`InboxMessage.base_path`): relative image paths in its body, and links to
 * its attachments, start there. Kept when it is a subfolder of the project,
 * when it lies in a linked worktree of the project's repository (a worktree
 * folds into the main repository's project, but the agent's files are in the
 * worktree, wherever on disk that is), when it is the other folder of a
 * combined project (a reply into a thread of the project it was combined with),
 * or when it is the folder the connection says the agent works in (`working`,
 * `callerWorkingFolder`).
 */
async function sendBasePath(context: InboxMcpContext, projectPath: string | undefined, project: InboxProject, working = false): Promise<string | null> {
  if (!projectPath || !isAbsolute(projectPath)) return null;
  let real: string;
  try {
    real = realpathSync(projectPath);
  } catch {
    return null;
  }
  if (real === project.root) return null;
  // The folder the connection says the agent works in, wherever it is: before the project
  // stopped following a shell `cd`, that folder was the project_path, so its paths resolved there.
  if (working || isInsideFolder(real, project.root)) return real;
  const resolved = await context.projectRootOf?.(projectPath).catch(() => null);
  if (resolved && resolved.worktree !== null && resolved.root === project.root) return real;
  const found = await context.findProjects?.(projectPath).catch(() => null);
  return found?.projects.some((other) => context.store.sameProject(other.id, project.id)) ? real : null;
}

/**
 * Why an image the body shows will not show in the window, by the code the
 * send-time capture's read refused it with (the message-image route's own
 * rules, message-images.ts). A code not listed (a read that raced a change,
 * a blob that could not be written) still shows through the route: no warning.
 */
const IMAGE_NOT_SHOWN_REASONS: Record<string, string> = {
  image_missing: "not a readable file (a folder, a pipe or a device)",
  image_unreadable: "Plannotator can't read this file; on macOS the app running it may need to be allowed",
  image_read_failed: "could not be read",
  not_an_image: "not an image (png, jpg, gif, webp, svg, avif, bmp, ico)",
  image_too_large: "over 10 MB or 50 megapixels",
  image_hidden: "a .env file, or in a hidden folder of the home folder such as ~/.ssh",
  validation_error: "not a file path",
};
const IMAGE_NOT_YET_REASON = "does not exist yet; it will show if it is written there later";
const IMAGE_REMOTE_REASON = "remote images never load in the Inbox";
/** The most images the warning names (the structured list and the text alike); the rest are counted. */
export const IMAGES_NOT_SHOWN_MAX = 10;

export interface ImageNotShown {
  ref: string;
  reason: string;
  /** Nothing is at the path yet: it shows once the file is written there. */
  not_yet?: true;
}

/** The images a sent body shows that the window will not (or not yet): the capture's refusals, then the remote ones. */
function imagesNotShown(body: string, failures: readonly InlineImageFailure[]): ImageNotShown[] {
  const out: ImageNotShown[] = [];
  for (const { ref, code, notYet } of failures) {
    if (code === "image_missing" && notYet) {
      out.push({ ref, reason: IMAGE_NOT_YET_REASON, not_yet: true });
      continue;
    }
    const reason = IMAGE_NOT_SHOWN_REASONS[code];
    if (reason) out.push({ ref, reason });
  }
  for (const ref of inboxMessageRemoteImageRefsInOrder(body)) out.push({ ref, reason: IMAGE_REMOTE_REASON });
  return out;
}

/** `a (why); b (why)`, at most `max` named, then `…and N more`. */
function namedImages(list: readonly ImageNotShown[], max: number): string {
  const named = list.slice(0, max).map(({ ref, reason }) => `${ref} (${reason})`).join("; ");
  return list.length > max ? `${named}; …and ${list.length - max} more` : named;
}

/** The send tools' warning sentences, or "" when every image shows. Appended to the result text. */
export function imagesNotShownText(list: readonly ImageNotShown[]): string {
  const never = list.filter((image) => !image.not_yet);
  const later = list.filter((image) => image.not_yet);
  let text = "";
  if (never.length > 0) {
    text += ` The message was sent, but ${never.length === 1 ? "this image will not show" : `${never.length} images will not show`}: ${namedImages(never, IMAGES_NOT_SHOWN_MAX)}. Copy the image to a plain folder and link that path, or attach it with attachments.`;
  }
  if (later.length > 0) {
    text += ` ${later.length === 1 ? "This image does not exist yet" : `${later.length} images do not exist yet`}: ${namedImages(later, IMAGES_NOT_SHOWN_MAX)}; ${later.length === 1 ? "it shows" : "they show"} once written there.`;
  }
  return text;
}

/**
 * The send tools' nudge (approval "inbox-decision-mode", agent contract
 * lines): a question the agent is stopped or held up on that has no
 * `Stakes:` line. Never a refusal. "" when there is none.
 */
export function noStakesText(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? " 1 question you are stopped or held up on has no `Stakes:` line; next time add one (what the choice affects, one sentence) so the person can decide in one look."
    : ` ${count} questions you are stopped or held up on have no \`Stakes:\` line; next time add one to each (what the choice affects, one sentence) so the person can decide in one look.`;
}

/**
 * The send tools' nudge for a question that marks its recommendation inside
 * a choice label (`- [ ] Foo (Recommended)`, the AskUserQuestion habit) with
 * no `Recommended:` line. The card reads one marked choice as the
 * recommendation, but two on a pick-one question name none, so the agent is
 * told the grammar. Never a refusal. "" when there is none.
 */
export function recommendedInLabelText(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? " 1 question marks its recommendation inside a choice label; next time mark it only with `Recommended: <label>` on its own line after the choices, and keep labels plain."
    : ` ${count} questions mark their recommendation inside a choice label; next time mark each only with \`Recommended: <label>\` on its own line after the choices, and keep labels plain.`;
}

/** A message id (`msg_` and a 26-character ULID), as an agent might pass one as `thread` by mistake. */
const MESSAGE_ID_SHAPE = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * `thread` is a name. A value shaped like a message id is an agent that meant
 * reply_to: refused, instead of silently starting a new thread named after
 * the id. Beside reply_to (which already places the message) it is refused
 * too, because there `thread` may name a thread the person started, and an id
 * is never a name; the refusal then says to leave `thread` out.
 */
export function refuseIdShapedThread(thread: string | undefined, replyTo?: string): void {
  const value = thread?.trim();
  if (!value || !MESSAGE_ID_SHAPE.test(value)) return;
  if (replyTo?.trim()) {
    throw new InboxError(
      "validation_error",
      `thread: "${value}" is a message id, and thread takes a name. You passed reply_to, which already places this message: leave thread out (or, to name a thread the person started, pass a few words).`,
    );
  }
  throw new InboxError(
    "validation_error",
    `thread: "${value}" is a message id, and thread takes a name. To write in an existing thread, pass reply_to ${value} instead.`,
  );
}

/**
 * A `subject` that is not one line of plain text (`checkInboxSubject`):
 * refused before any file is copied or project made, so nothing is written
 * and a corrected retry with the same idempotency_key lands once. The store
 * checks again.
 */
export function refuseBadSubject(subject: unknown): void {
  const checked = checkInboxSubject(subject);
  if (!checked.ok) throw new InboxError("validation_error", `subject: ${checked.message}`, { field: "subject" });
}

/** An agent's message into `project`, routed by the store (send_message, submit_guide). */
export async function sendAgentMessage(
  context: InboxMcpContext,
  project: InboxProject,
  input: AgentSendInput,
  guide?: InboxGuideRef,
  wakes = false,
): Promise<{ structured: Record<string, unknown>; replayed: boolean; questions: number; attachments: number; superseded: number; actions: number; done: number; imagesNotShown: ImageNotShown[]; noStakes: number; recommendedInLabel: number; naming: InboxSendResult["naming"] | null }> {
  const { store } = context;
  refuseIdShapedThread(input.thread, input.reply_to);
  refuseBadSubject(input.subject);
  // Where relative paths start: the folder the agent works in, when its connection says (a cd away from its project).
  const working = !!input.working_folder && isAbsolute(input.working_folder);
  const here = working ? input.working_folder : input.project_path;
  let attachments: InboxAttachment[] | undefined;
  if (input.attachments && input.attachments.length > 0) {
    if (!context.recordAttachments) throw new InboxError("validation_error", "attachments: not taken by this Inbox.");
    const base = here && isAbsolute(here) ? here : project.root;
    attachments = await context.recordAttachments(input.attachments, project, base);
  }
  const basePath = await sendBasePath(context, here, project, working);
  // The images the body shows, copied now under the message-image route's rules (inline-images.ts):
  // files of the thread, with a sent version. One that cannot be read is captured on a later read.
  // Asynchronous and yielding; the blobs stay staged until the store accepts the message.
  const captured = bodyShowsLocalImages(input.body)
    ? await captureInboxInlineImages(store.dir, {
        body: input.body,
        root: project.root,
        base: basePath,
        anywhere: true,
        sentAt: new Date().toISOString(),
        stage: true,
      })
    : null;
  let result: ReturnType<InboxStore["sendMessage"]>;
  try {
    result = store.sendMessage({
      project_id: project.id,
      author: {
        kind: "agent",
        host: input.agent_host?.trim() || null,
        session: input.agent_session?.trim() || null,
        name: inboxStoredAgentName(input.agent_name),
      },
      body: input.body,
      subject: input.subject ?? null,
      reply_to: input.reply_to ?? null,
      idempotency_key: input.idempotency_key ?? null,
      thread: input.thread ?? null,
      attachments,
      inline_images: captured?.images,
      guide: guide ?? null,
      base_path: basePath,
      supersedes: input.supersedes ?? null,
      done: input.done ?? null,
      ...(wakes ? { wakes: true } : {}),
    });
  } catch (error) {
    await captured?.discard();
    throw error;
  }
  // A replay keeps the records the first send wrote; this send's copies are not used.
  if (result.replayed) await captured?.discard();
  else await captured?.commit();
  const message = result.message;
  const landed = store.project(message.project_id)!;
  const questions = (message.questions ?? []).filter((q) => q.kind !== "action").map((q) => ({ key: q.key, kind: q.kind, prompt: q.prompt }));
  // Action items (`:::action`): their keys, so the agent can mark one done later.
  const actions = (message.questions ?? []).filter((q) => q.kind === "action").map((q) => ({ key: q.key, prompt: q.prompt }));
  const superseded = store.supersededBy(message.id);
  const markedDone = result.done ?? [];
  const notShown = imagesNotShown(input.body, captured?.failures ?? []);
  // A question the agent is stopped or held up on, with no `Stakes:` line:
  // the result nudges (never refuses), so the person can decide in one look.
  const noStakes = (message.questions ?? [])
    .filter((q) => q.kind !== "action" && (q.stopped !== null || q.holds_up.length > 0) && !q.stakes)
    .map((q) => q.key);
  // A question written with a recommended marker in a choice label (read
  // by the parser or not, with or without a `Recommended:` line).
  const recommendedInLabel = inboxQuestionKeysWithRecommendedMarker(message.body);
  return {
    imagesNotShown: notShown,
    noStakes: noStakes.length,
    recommendedInLabel: recommendedInLabel.length,
    superseded: superseded.length,
    actions: actions.length,
    done: markedDone.length,
    replayed: result.replayed,
    naming: result.naming ?? null,
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
      ...(actions.length > 0 ? { actions } : {}),
      attachments: (message.attachments ?? []).map((a) => ({ id: a.id, name: a.name, kind: a.kind, path: a.path })),
      /** The earlier questions this message superseded (`<message id>/<key>`). */
      superseded,
      /** The action items this message marked done (`done`). */
      ...(markedDone.length > 0 ? { done: markedDone } : {}),
      replayed: result.replayed,
      cursor: store.messageCursor(message.id) ?? store.cursor(),
      url: threadUrl(context.baseUrl(), message.thread_id),
      // A reply into a thread the person started that this agent may name (approval "inbox-agent-names-own-thread").
      // `named_thread` is the name set, or null while the thread stays unnamed (`naming_refused` says why a name was refused).
      ...(result.naming ? { named_thread: result.naming.status === "named" ? result.naming.name : null } : {}),
      ...(result.naming?.status === "refused" ? { naming_refused: result.naming.code } : {}),
      ...(result.naming && result.naming.status !== "named" ? { name_this_thread: true } : {}),
      /** Images the body shows that the window will not (missing, not an image, too large, hidden, remote). */
      ...(notShown.length > 0 ? { images_not_shown: notShown.slice(0, IMAGES_NOT_SHOWN_MAX) } : {}),
      ...(notShown.length > IMAGES_NOT_SHOWN_MAX ? { images_not_shown_more: notShown.length - IMAGES_NOT_SHOWN_MAX } : {}),
      /** Keys of the Stopped / Holds up questions with no `Stakes:` line (a nudge; the message was sent). */
      ...(noStakes.length > 0 ? { no_stakes: noStakes } : {}),
      /** Keys of the questions that marked their recommendation in a choice label, not a `Recommended:` line (a nudge; the message was sent). */
      ...(recommendedInLabel.length > 0 ? { recommended_in_label: recommendedInLabel } : {}),
    },
  };
}

/**
 * ", superseding 1 earlier question", ", superseding 1 earlier action item", or
 * ", superseding 2 earlier questions and 1 action item", from the superseded ids
 * (`<message id>/<key>`; an action item's key starts with `a-`). "" for none.
 */
export function supersededWords(ids: readonly string[]): string {
  const todos = ids.filter((id) => /\/a-[0-9a-f]/.test(id)).length;
  const questions = ids.length - todos;
  const parts = [
    questions > 0 ? `${questions} earlier question${questions === 1 ? "" : "s"}` : "",
    todos > 0 ? `${todos}${questions > 0 ? "" : " earlier"} action item${todos === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `, superseding ${parts.join(" and ")}` : "";
}

/** send_message's (and submit_guide's) one line about naming a thread the person started, or "". */
export function namingLine(naming: InboxSendResult["naming"] | null | undefined): string {
  if (!naming) return "";
  if (naming.status === "named") return ` Named this thread: ${naming.name}.`;
  if (naming.status === "refused" && naming.code === "thread_name_taken") {
    return ` The thread was not named: ${naming.reason} Pick another name and reply again with it in \`thread\`.`;
  }
  if (naming.status === "refused") return ` The thread was not named: ${naming.reason} Pass a valid \`thread\` (a few words) on a later reply to name it.`;
  return " This thread the person started still needs a name from you: pass `thread` (a few words saying what it is about) on a later reply to name it, once.";
}

/**
 * One thread in read_thread's list, as an agent reads it: what it needs to
 * pick a thread to read, not the window's row (whose `unread` and
 * section counters are the person's).
 */
export interface InboxAgentThreadRow {
  thread_id: string;
  subject: string | null;
  thread_name: string | null;
  /** Where the thread sits in the person's list (`stopped`, `holding`, `waiting`, `new`, `sent`, `quiet`). */
  section: InboxListRow["section"];
  message_count: number;
  /**
   * Questions in it still waiting on the person: `open`, and `picked`
   * (answered in the window, not sent yet); `prompt` is the first open one's.
   */
  questions: { open: number; picked: number; prompt: string | null };
  last_author: InboxListRow["last_author"];
  last_at: string;
  /**
   * The person's last message in the thread (a reply, a New message), or null
   * when they wrote none. The Inbox's own notes (Mark read's set-aside note,
   * the reopened note, the 👍 note) are not the person's words and never count.
   */
  last_person_at: string | null;
  last_person_message_id: string | null;
  /**
   * The person wrote something in it for you that no agent has read yet: a
   * reply after the thread's agent-read mark (any agent's read_thread reads
   * it), a message addressed to you (`to`) not yet delivered (only your wake
   * delivers it; a read_thread does not), or a reply that tags you or that you
   * own with tags, until your own read (not woken) or delivery. The Inbox's
   * own notes never count.
   */
  unread: boolean;
  /**
   * Only on a resolved (archived) thread: listed with include_resolved, or
   * listed anyway because an agent wrote in it after the archive.
   */
  resolved_at?: string;
}

/**
 * Whether the person wrote in the thread for `caller` and no agent read it:
 * a reply after the thread's agent-read mark, a message addressed to the
 * caller (`to`) not yet delivered, or a reply with tags the caller has not
 * taken. The Inbox's 👍 notes are not in the thread.
 */
function personFacts(store: InboxStore, threadId: string, caller: string | null): { unread: boolean; last: InboxMessage | null } {
  const checked = store.message(threadId)?.agent_checked_seq ?? 0;
  let unread = false;
  let last: InboxMessage | null = null;
  for (const message of store.thread(threadId)?.messages ?? []) {
    // The Inbox's own notes are not the person's words.
    if (message.author.kind !== "person" || isInboxNote(message)) continue;
    last = message;
    // A reply that tags agents is unread for each recipient until it took it: its delivery, or,
    // for one no connection wakes, its read (`delivered_at` for an owner, `read_at` for a tag).
    if (message.tags && message.tags.length > 0) {
      if (caller && store.isOwner(message, caller)) {
        if (!store.recipientsOf(message).find((r) => r.owner)?.delivered_at) unread = true;
      } else if (caller && message.tags.some((t) => t.session === caller && !t.delivery && !t.read_at)) unread = true;
      continue;
    }
    if (message.to) {
      if (message.to.session === caller && !message.delivery) unread = true;
      continue;
    }
    if ((store.messageCursor(message.id) ?? 0) > checked) unread = true;
  }
  return { unread, last };
}

/** One row of read_thread's list as a line of text: every field the structured row holds. */
export function threadRowText(row: InboxAgentThreadRow & { tagged_you?: true }): string {
  const parts = [`- ${row.thread_id}`];
  if (row.subject) parts.push(JSON.stringify(row.subject));
  if (row.thread_name) parts.push(`name ${JSON.stringify(row.thread_name)}`);
  parts.push(row.section, `${row.message_count} message${row.message_count === 1 ? "" : "s"}`);
  const { open, picked, prompt } = row.questions;
  if (open + picked > 0) {
    parts.push(`${open} open${picked > 0 ? `, ${picked} picked not sent` : ""}${prompt ? `: ${JSON.stringify(clip(prompt, 100))}` : ""}`);
  }
  parts.push(`last ${row.last_author} ${shortTime(row.last_at)}`);
  if (row.last_person_message_id && row.last_person_at) parts.push(`person's last ${row.last_person_message_id} ${shortTime(row.last_person_at)}`);
  if (row.unread) parts.push("unread: the person wrote something you have not read");
  // The person tagged the reader in this thread (approval "inbox-tag-agents"), in any project.
  if (row.tagged_you) parts.push("the person tagged you here");
  if (row.resolved_at) parts.push(`resolved ${shortTime(row.resolved_at)}`);
  return parts.join(" · ");
}

export function agentThreadRow(store: InboxStore, row: InboxListRow, caller: string | null): InboxAgentThreadRow {
  const person = personFacts(store, row.thread_id, caller);
  return {
    thread_id: row.thread_id,
    subject: row.subject,
    thread_name: row.thread_name,
    // The section without the person's unsent work: a reply draft (and comments not sent) never reach an agent.
    section: inboxSectionOf({ ...row, unsent: null }),
    message_count: row.message_count,
    questions: { open: row.questions.open, picked: row.questions.picked, prompt: row.questions.prompt },
    last_author: row.last_author,
    last_at: row.last_at,
    last_person_at: person.last?.created_at ?? null,
    last_person_message_id: person.last?.id ?? null,
    unread: person.unread,
    ...(row.resolved_at ? { resolved_at: row.resolved_at } : {}),
  };
}

export function createInboxMcpServer(context: InboxMcpContext): McpServer {
  const { store } = context;
  const clock = () => context.now?.() ?? Date.now();
  const server = new McpServer(
    { name: "plannotator-inbox", version: "1.0.0" },
    { instructions: INBOX_MCP_INSTRUCTIONS, capabilities: { tools: {} } },
  );
  // Every tool's result carries a Tidy waiting on an agent no connection wakes (MCP only), once, at its end.
  const register = server.registerTool.bind(server) as (name: string, config: unknown, handler: (input: never, ctx: unknown) => Promise<ToolResult>) => unknown;
  server.registerTool = ((name: string, config: unknown, handler: (input: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>) =>
    register(name, config, async (input: Record<string, unknown>, ctx: unknown) => withTidy(context, await handler(input, ctx), input, ctx))) as unknown as typeof server.registerTool;

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
              "Files to show the person beside your message, e.g. [\"docs/plan.md\", \"/tmp/checkout.png\", \"src/retry.mjs\"]: absolute (anywhere you can read) or relative to project_path. For something visual, a screenshot or image usually reads fastest; attach the HTML or source too when they should open or click through it. Any regular file, any size. Markdown, plain text, config and data files, Mermaid and Graphviz sources and HTML (its relative images and frames load from its folder) open in Plannotator's viewers; images (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO) show in the message; videos (MP4, MOV, WebM) play beside it, and the person comments at moments (each comment comes back with its time and the paused frame's path); source code, scripts and other text open as code with line comments; PDFs and anything else are offered as a download. Folders and .env files are refused. The Inbox keeps the version you sent and shows the file as it is now, saying when it changed. The person's annotations, including comments on images and code lines, come back in their reply. Each attachment's kind in the result is markdown, text, html, mermaid, graphviz, code, image, video, pdf or file; treat any other as file. A markdown link to an attached file in the body, e.g. [the mock](proto/admin.html), opens it beside the thread.",
            ),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, ctx) =>
      guarded(async () => {
        const project = await sendProject(context, input);
        const wakes = await senderWakes(context, ctx, input);
        const sent = await sendAgentMessage(context, project, { ...input, working_folder: callerWorkingFolder(ctx) }, undefined, wakes);
        // Named a thread (reply_to, or a thread name) this session has not looked at for hours (or ever):
        // one line naming its subject. Not for a message routed to the session's own thread by default,
        // never on a replay (the first answer stands), and it never blocks the send.
        const named = !!input.reply_to?.trim() || !!input.thread?.trim();
        const stale = sent.replayed || !named ? null : staleThreadOf(store, String(sent.structured.message_id), input.agent_session, clock());
        const asked =
          (sent.questions > 0 ? ` asking ${sent.questions} question${sent.questions === 1 ? "" : "s"}` : "") +
          (sent.attachments > 0 ? ` with ${sent.attachments} attachment${sent.attachments === 1 ? "" : "s"}` : "") +
          (sent.actions > 0 ? `${sent.questions > 0 ? " and" : " with"} ${sent.actions} action item${sent.actions === 1 ? "" : "s"}` : "") +
          supersededWords(sent.structured.superseded as string[]) +
          (sent.done > 0 ? `, marking ${sent.done} action item${sent.done === 1 ? "" : "s"} done` : "");
        // The hints after the sent line, in this order, each "" when it has nothing to say.
        const hints = [
          imagesNotShownText(sent.imagesNotShown),
          noStakesText(sent.noStakes),
          recommendedInLabelText(sent.recommendedInLabel),
        ];
        if (stale) hints.push(`\n${staleThreadText(stale, shortTime)}`);
        return ok(
          `${sent.replayed ? "Already sent" : "Sent"} to the Plannotator Inbox${asked} (thread ${sent.structured.thread_id}, ${sent.structured.url}).${namingLine(sent.naming)} ${wakes ? INBOX_REPLY_ARRIVES_TEXT : INBOX_REPLY_READ_LATER_TEXT}${hints.join("")}`,
          stale ? { ...sent.structured, not_read_since: lastContactOf(stale) } : sent.structured,
        );
      }),
  );

  server.registerTool(
    "read_thread",
    {
      title: "Read a thread, or list your threads",
      description: READ_THREAD_DESCRIPTION,
      inputSchema: z
        .object({
          thread_id: z.string().optional(),
          message_id: z.string().optional(),
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          asked_by: z.enum(["me", "anyone"]).optional().describe("Default \"me\" (threads you sent in) when your session is known; \"anyone\" lists every thread."),
          include_resolved: z.boolean().optional().describe("List archived threads too."),
          limit: z.number().int().min(1).max(100).optional().describe(`How many: a thread's messages in full (default ${INBOX_THREAD_WINDOW}), listed threads (20), search results (10, at most 50).`),
          expand: z.array(z.string()).optional().describe("Message ids of this thread to show in full."),
          before: z.union([z.string(), z.number().min(0)]).optional().describe("Only messages before this message id or cursor."),
          after: z.union([z.string(), z.number().min(0)]).optional().describe("Only messages after this message id or cursor (what is new)."),
          format: z.enum(["full"]).optional().describe("Every message as its full record (large)."),
          agent_session: z.string().optional().describe(AGENT_SESSION_DESCRIPTION),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, ctx) =>
      guarded(async () => {
        const threadId = threadOf(store, input);
        if (threadId) {
          const naming = namingHint(store, threadId, input.agent_session?.trim() || null);
          const url = threadUrl(context.baseUrl(), threadId);
          const reader = input.agent_session?.trim() || null;
          // A session the person only tagged here reads as a guest: what the owner still waits for stays queued.
          const guest = store.isTaggedGuest(threadId, reader);
          if (input.format === "full") {
            if (!guest) store.markAgentChecked(threadId);
            // The person's 👍 (settled acks) are read now too: the window says the agent saw it.
            if (!guest) store.markAcksSeen(threadId);
            // An agent that is not woken read a thread it was tagged in: the window says it saw it.
            if (reader) store.recordTagRead(threadId, reader);
            // This session has read the thread now (send_message's "not read since" line).
            noteSessionRead(store, reader, threadId, clock());
            // The full records, as before the window (tests, scripts, a jq over the result).
            const thread = store.agentThread(threadId, reader)!;
            const replies = thread.messages.filter((m) => m.author.kind === "person").length;
            return ok(
              `Thread ${threadId}${thread.subject ? ` (${thread.subject})` : ""}: ${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"}, ${replies} from the person${thread.resolved_at ? ", resolved" : ""}.${naming?.line ?? ""}`,
              { thread, url, ...(naming?.structured ?? {}) },
            );
          }
          // Built first, so a refused read (a bad expand, before or after) marks nothing read.
          const { result, order, shown, readThrough } = windowedThread(store, threadId, { ...input, caller: input.agent_session?.trim() || null }, url);
          if (!guest) {
            store.markAgentChecked(threadId, readThrough);
            store.markAcksSeen(threadId, Number.POSITIVE_INFINITY, undefined, shown);
          }
          // An agent that is not woken read a thread it was tagged in: the window says it saw it.
          if (reader) store.recordTagRead(threadId, reader);
          noteSessionRead(store, reader, threadId, clock());
          return okComplete(windowedThreadText(result, order, naming?.line ?? ""), { ...result, ...(naming?.structured ?? {}) });
        }
        if (input.expand || input.before !== undefined || input.after !== undefined) {
          throw new InboxError("validation_error", "expand, before and after read one thread: pass thread_id (or message_id).");
        }
        if (!input.project_path) throw new InboxError("validation_error", "project_path: required to list threads (or pass thread_id).");
        const peek = callerPeeks(ctx);
        // A list never makes a project: it is scoped by the projects the folder names (findProjects,
        // as search: its project, plus the one an older Inbox kept for its worktree), looked up, never
        // made. A folder with neither has no threads of its own: a connection's own list for the
        // session's thread list (peek) lists nothing; an agent's list still shows the threads it was
        // tagged in. Without findProjects (or when its lookup refused the path), the resolving scope,
        // so a path that is not a folder is still a validation_error.
        const found = context.findProjects ? await context.findProjects(input.project_path).catch(() => null) : null;
        if (peek && (!found || found.projects.length === 0)) return okComplete("0 threads.", { project: null, threads: [], total: 0 });
        if (found?.unresolved) {
          throw new InboxError("project_unresolved", "git did not answer in time, so this folder's project is not known yet. Nothing was listed; try the same call again.");
        }
        const { project, projectIds } = found
          ? { project: found.projects[0] ?? null, projectIds: new Set(found.projects.flatMap((p) => store.projectGroup(p.id))) }
          : await threadReadScope(context, input.project_path);
        const session = input.agent_session?.trim() || null;
        const askedBy = input.asked_by ?? (session ? "me" : "anyone");
        if (askedBy === "me" && !session) throw new InboxError("validation_error", "asked_by: \"me\" needs agent_session.");
        let threads = listScopedRows(store, projectIds, askedBy === "me" ? session : null);
        // Threads the person tagged this session in (approval "inbox-tag-agents"), in any project: listed too.
        const tagged = session ? new Set(store.taggedThreadsOf(session)) : new Set<string>();
        for (const id of tagged) {
          if (threads.some((row) => row.thread_id === id)) continue;
          const row = store.listRow(id);
          if (row) threads = [...threads, row];
        }
        // A thread an agent wrote in after its archive line still takes a reply: listed like an open one.
        if (!input.include_resolved) threads = threads.filter((t) => t.resolved_at === null || t.agent_after_archive === true);
        const limit = input.limit ?? 20;
        const total = threads.length;
        // One short row per thread: the window's row is the person's view (and its `ack` shows a 👍 before it settles).
        const rows = threads.slice(0, limit).map((row) => ({ ...agentThreadRow(store, row, session), ...(tagged.has(row.thread_id) ? { tagged_you: true as const } : {}) }));
        // The session saw these subjects (the check INBOX_REPLY_TO_CHECK asks for), unless a connection read them for it.
        if (!peek) for (const row of rows) noteSessionRead(store, session, row.thread_id, clock());
        const head = `${total} thread${total === 1 ? "" : "s"}${project ? ` in ${project.name}` : ""}${total > limit ? `, showing ${limit}` : ""}.`;
        // A folder that holds projects (a plain folder over a repo) lists nothing itself: name the projects below it, so the agent can ask for them.
        const inside = total === 0 ? await projectsInside(context, input.project_path, project, input.include_resolved === true) : [];
        const insideLine =
          inside.length > 0
            ? `Projects inside this folder: ${inside.map((p) => `${p.name} (${p.root}), ${p.threads} thread${p.threads === 1 ? "" : "s"}`).join("; ")}. Pass its project_path to list ${inside.length === 1 ? "them" : "one"}.`
            : "";
        return okComplete(rows.length > 0 ? `${head}\n${rows.map(threadRowText).join("\n")}` : insideLine ? `${head}\n${insideLine}` : head, {
          project: project ? { id: project.id, name: project.name, root: project.root } : null,
          threads: rows,
          total,
          ...(inside.length > 0 ? { projects_inside: inside } : {}),
        });
      }),
  );

  // The agents' read-only search over the ⌘K index (approval "inbox-agent-search"): packages/server/inbox-mcp-search.ts.
  registerInboxSearchTool(server, context);

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

  // Guided reviews (step 5): packages/server/inbox-guides.ts.
  registerInboxGuideTools(server, context);

  // The Board's cards (approval "inbox-board"): packages/server/inbox-mcp-cards.ts. Held back in the code with
  // INBOX_CARD_ACTION_ON, and served only while the person has the Board on (the server is made per request).
  if (INBOX_CARD_ACTION_ON && (context.boardOn?.() ?? true)) registerInboxCardTool(server, context);

  return server;
}
