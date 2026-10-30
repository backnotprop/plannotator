/**
 * The Board's `card` tool (approval "inbox-board", step 1): the one-line call
 * an agent uses to keep a card current. A card is work that outlasts the
 * reply it was asked in (a lane started, a PR opened, "I'll send you X"); the
 * agent makes one when it takes such an ask and updates it at the moments it
 * already records (lane launched, PR opened, deliverable sent, waiting on the
 * person, shipped). The rules on who moves a card live in the store
 * (store.ts, "the Board's cards"); this module maps the tool onto them.
 *
 * Reached by the `plannotator_inbox` tool's action "card" (the Claude Code
 * mod, Pi, OpenCode), the stdio shim, and `plannotator card …` (the CLI's
 * thin client, apps/hook/server/card-command.ts).
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_COLUMNS,
  INBOX_CARD_LIVE_COLUMNS,
  inboxAgentName,
  inboxCardRefsOf,
  inboxCardTitleHint,
  isInboxCardDropUnseen,
  type InboxAuthor,
  type InboxCardColumn,
  type InboxCardWire,
  type InboxProject,
} from "@plannotator/core/inbox-types";
import { INBOX_REF_LINK_POINTER } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { shortTime } from "./inbox-mcp-read";
import { guarded, okComplete, PROJECT_PATH_DESCRIPTION } from "./inbox-mcp-result";
import type { InboxMcpContext } from "./inbox-mcp";

export const INBOX_CARD_OPS = ["create", "move", "say", "link", "ship", "drop", "list"] as const;
export type InboxCardOp = (typeof INBOX_CARD_OPS)[number];

/** For raw MCP clients; the agent tool words its action line itself (INBOX_AGENT_ACTION_LEADS.card). */
export const CARD_DESCRIPTION =
  "Keep a card on the person's Board for work that outlasts this reply (a lane started, a PR opened, \"I'll send you X\"), and keep it current with one short call as the work moves. op: create (a title: 2–5 words naming the work (\"Pi update fix\"), never a sentence; status goes in say), move (column), say (your last word, or what the person owes in `you`), link (thread_id, pr), ship, drop (with a reason), list (your cards). When a card waits on the person, link the Inbox thread where they make the call (thread_id), so \"You: …\" opens it. A merged PR never moves a card by itself: ship it when it is merged or live.";

/** Short on purpose: Pi and OpenCode send it with every request (INBOX_TOOL_COST). */
export const CARD_COLUMN_DESCRIPTION =
  "backlog (not started yet) · designing (not code) · your_look (a non-code thing waits on the person; give `you`) · building (code, an open PR) · your_review (code or a release waits on the person; give `you`) · shipped (merged or live) · dropped (give `reason`). Waiting on the person wins. icebox: the person's only. asked: the old name of backlog.";

/** What a `card` call gets while the Board is off (approval "inbox-board", 2026-10-26): nothing is written. */
export const INBOX_BOARD_OFF_TEXT =
  "board_off: The person's Board is off, so cards are not kept and nothing was written. They turn it on in the Plannotator Inbox's Settings → Capabilities; agents get the card action in their next session.";

const AGENT_SESSION_DESCRIPTION = "Your session id; the `plannotator inbox mcp` shim fills it. The cards you make are yours: list shows them.";

/** One card as one line of text: every fact an agent acts on. */
export function cardLineText(card: InboxCardWire): string {
  const parts = [`- ${card.id}`, JSON.stringify(card.title), INBOX_CARD_COLUMN_LABELS[card.column]];
  if (card.you && (card.column === "your_look" || card.column === "your_review")) parts.push(`You: ${JSON.stringify(card.you)}`);
  if (card.said) parts.push(`said ${JSON.stringify(card.said)}`);
  parts.push(`heard ${shortTime(card.heard_at)}`);
  if (card.dropped) {
    parts.push(`dropped${card.dropped.reason ? `: ${JSON.stringify(card.dropped.reason)}` : ""}${isInboxCardDropUnseen(card) ? " (the person has not seen it yet)" : ""}`);
  }
  if (card.threads.length > 0) parts.push(`threads ${card.threads.join(", ")}`);
  const refs = inboxCardRefsOf(card);
  if (refs.length > 0) parts.push(`links ${refs.map((ref) => (ref.kind === "pr" ? ref.ref : `${ref.ref} (${ref.kind})`)).join(", ")}`);
  if (card.notes) parts.push(`notes ${JSON.stringify(card.notes.length > 300 ? `${card.notes.slice(0, 300)}…` : card.notes)}`);
  if (card.agent?.kind === "agent") parts.push(`agent ${inboxAgentName(card.agent)}${card.agent.session ? ` (${card.agent.session})` : ""}`);
  return parts.join(" · ");
}

/** The fields a tool call carries for one card call. */
export interface CardCallInput {
  op: InboxCardOp;
  card_id?: string;
  title?: string;
  column?: string;
  say?: string;
  you?: string;
  thread_id?: string;
  pr?: string;
  ref?: string;
  reason?: string;
  idempotency_key?: string;
  asked_by?: "me" | "anyone";
  include_resolved?: boolean;
  project_path?: string;
  agent_session?: string;
  agent_name?: string;
  agent_host?: string;
}

/** The card `id`, in the caller's project scope, or a refusal naming where it is. */
function cardInScope(store: InboxStore, id: string | undefined, projectIds: ReadonlySet<string>) {
  if (!id?.trim()) throw new InboxError("validation_error", "card_id: the card to change (list shows yours).", { field: "card_id" });
  const card = store.card(id.trim());
  if (!card) throw new InboxError("card_not_found", `No card ${id.trim()}.`);
  if (!projectIds.has(card.project_id)) {
    const project = store.project(card.project_id);
    throw new InboxError(
      "card_other_project",
      `Card ${card.id} is in project ${project?.name ?? card.project_id}, not this one: pass project_path ${project?.root ?? "<its folder>"} to change it.`,
    );
  }
  return card;
}

/** Fields each op takes; any other is refused by name (a column on a say would otherwise be dropped silently). */
export const INBOX_CARD_OP_FIELDS: Record<InboxCardOp, readonly (keyof CardCallInput)[]> = {
  create: ["title", "column", "say", "you", "thread_id", "pr", "ref", "idempotency_key"],
  move: ["card_id", "column", "say", "you", "thread_id", "pr", "ref", "reason"],
  say: ["card_id", "say", "you", "title"],
  link: ["card_id", "thread_id", "pr", "ref", "say"],
  ship: ["card_id", "say", "pr", "ref", "thread_id"],
  drop: ["card_id", "reason", "say"],
  list: ["asked_by", "include_resolved"],
};
const OP_COMMON = new Set<keyof CardCallInput>(["op", "project_path", "agent_session", "agent_name", "agent_host"]);

/**
 * The caller's project scope, looked up and never made (as search does): the
 * project at `project_path`'s root, plus the one an older Inbox kept for the
 * worktree it lies in. A card call never writes a project; a folder the Inbox
 * has never seen has no Board yet.
 */
async function cardScope(context: InboxMcpContext, path: string): Promise<{ project: InboxProject | null; projectIds: Set<string>; unresolved: boolean }> {
  const found = context.findProjects ? await context.findProjects(path) : { projects: [], unresolved: false };
  return { project: found.projects[0] ?? null, projectIds: new Set(found.projects.map((p) => p.id)), unresolved: found.unresolved };
}

/** Run one card call; throws InboxError on a refusal. */
export async function runCardCall(context: InboxMcpContext, input: CardCallInput): Promise<{ text: string; structured: Record<string, unknown> }> {
  const { store } = context;
  for (const [field, value] of Object.entries(input) as [keyof CardCallInput, unknown][]) {
    // `false` is a default (include_resolved: false), not a field the agent meant to set: tolerated, as the plannotator tool contract does.
    if (value === undefined || value === false || OP_COMMON.has(field)) continue;
    if (!INBOX_CARD_OP_FIELDS[input.op].includes(field)) {
      throw new InboxError("validation_error", `${field}: op ${input.op} does not take it (it takes ${INBOX_CARD_OP_FIELDS[input.op].join(", ")}).`, { field });
    }
  }
  // The Board turned off after this session listed the tool: refused, nothing written (checked before anything else is read).
  if (context.boardOn && !context.boardOn()) throw new InboxError("board_off", INBOX_BOARD_OFF_TEXT.replace(/^board_off: /, ""));
  if (!input.project_path) throw new InboxError("validation_error", "project_path: required (the connection fills it).", { field: "project_path" });
  const { project, projectIds, unresolved } = await cardScope(context, input.project_path);
  if (unresolved) {
    throw new InboxError("project_unresolved", "git did not answer in time, so this folder's project is not known yet. Nothing was changed; try the same call again.");
  }
  if (!project && input.op !== "list") {
    throw new InboxError(
      "card_no_project",
      "This folder's project has no Board yet: the Inbox has never had a message from it. Send one with send_message first, or pass the project_path of a project the Inbox knows.",
    );
  }
  const session = input.agent_session?.trim() || null;
  const by: InboxAuthor = { kind: "agent", host: input.agent_host?.trim() || null, session, name: input.agent_name?.trim() || null };
  // A title that reads like a sentence gets a hint after the card line (approved 2026-10-27; never refused).
  const answer = (verb: string, wire: InboxCardWire, extra: Record<string, unknown> = {}, titled: string | null = null) => {
    const hint = titled === null ? null : inboxCardTitleHint(titled);
    return {
      text: `${verb}:\n${cardLineText(wire)}${hint ? `\n${hint}` : ""}`,
      structured: { card: wire, ...extra, ...(hint ? { title_hint: hint } : {}) },
    };
  };

  if (input.op === "list") {
    if (!project) {
      return { text: "No cards: the Inbox has never had a message from this folder's project.", structured: { project: null, cards: [], total: 0 } };
    }
    const askedBy = input.asked_by ?? (session ? "me" : "anyone");
    if (askedBy === "me" && !session) throw new InboxError("validation_error", "asked_by: \"me\" needs agent_session.", { field: "asked_by" });
    const columns = new Set<InboxCardColumn>(input.include_resolved ? INBOX_CARD_COLUMNS : [...INBOX_CARD_LIVE_COLUMNS, "icebox"]);
    const cards = store.listCards({ projectIds, columns, agentSession: askedBy === "me" ? session : null }).map((card) => store.cardWire(card));
    const whose = askedBy === "me" ? "Your" : "All";
    const head = `${whose} ${cards.length} card${cards.length === 1 ? "" : "s"} in ${project.name}${input.include_resolved ? "" : " (shipped and dropped left out)"}.`;
    const iceboxed = cards.some((card) => card.column === "icebox") ? "\nA card in the Icebox is paused by the person: leave its work alone until they bring it back." : "";
    return {
      text: cards.length > 0 ? `${head}\n${cards.map(cardLineText).join("\n")}${iceboxed}` : head,
      structured: { project: { id: project.id, name: project.name, root: project.root }, cards, total: cards.length },
    };
  }

  if (input.op === "create") {
    let projectId = project!.id;
    if (input.thread_id) {
      const message = store.message(input.thread_id.trim());
      if (!message) throw new InboxError("thread_not_found", `No thread or message ${input.thread_id.trim()}.`);
      if (!projectIds.has(message.project_id)) {
        const other = store.project(message.project_id);
        throw new InboxError(
          "card_other_project",
          `Thread ${message.thread_id} is in project ${other?.name ?? message.project_id}, not this one: pass project_path ${other?.root ?? "<its folder>"} to make its card there.`,
        );
      }
      projectId = message.project_id;
    }
    const { card, replayed } = store.createCard({
      project_id: projectId,
      by,
      title: input.title,
      column: input.column,
      say: input.say,
      you: input.you,
      threads: input.thread_id ? [input.thread_id] : [],
      prs: input.pr ? [input.pr] : [],
      refs: input.ref ? [input.ref] : [],
      idempotency_key: input.idempotency_key,
    });
    return answer(replayed ? "Already made (the same idempotency_key)" : "Made a card on the person's Board; keep it current with move or say as the work moves", store.cardWire(card), { replayed }, card.title);
  }

  const card = cardInScope(store, input.card_id, projectIds);
  if (input.op === "move" && !input.column) throw new InboxError("validation_error", "column: where the card goes (move).", { field: "column" });
  if (input.op === "say" && !input.say && !input.you && !input.title) throw new InboxError("validation_error", "say: your last word (or `you`, what the person owes; or `title`).", { field: "say" });
  if (input.op === "link" && !input.thread_id && !input.pr && !input.ref) throw new InboxError("validation_error", "thread_id, pr or ref: what to link.", { field: "thread_id" });
  const column = input.op === "ship" ? "shipped" : input.op === "drop" ? "dropped" : input.column;
  const next = store.updateCard(card.id, {
    by,
    column,
    say: input.say,
    you: input.you,
    title: input.title,
    threads: input.thread_id ? [input.thread_id] : [],
    prs: input.pr ? [input.pr] : [],
    refs: input.ref ? [input.ref] : [],
    reason: input.reason,
  });
  const verb = next.column !== card.column ? `Moved to ${INBOX_CARD_COLUMN_LABELS[next.column]}` : "Updated";
  return answer(verb, store.cardWire(next), {}, input.title ? next.title : null);
}

export function registerInboxCardTool(server: McpServer, context: InboxMcpContext): void {
  server.registerTool(
    "card",
    {
      title: "Keep a card on the person's Board",
      description: CARD_DESCRIPTION,
      inputSchema: z
        .object({
          op: z.enum(INBOX_CARD_OPS),
          card_id: z.string().optional().describe("The card (crd_…); not for create or list."),
          title: z.string().optional().describe("2–5 words naming the work (\"Pi update fix\"), never a sentence; status goes in say. Create with thread_id: pass one, as subjects run long."),
          column: z.enum([...INBOX_CARD_COLUMNS, "asked"]).optional().describe(CARD_COLUMN_DESCRIPTION),
          say: z.string().optional().describe(`Your last word: where the work is, one line. ${INBOX_REF_LINK_POINTER}`),
          you: z.string().optional().describe(`What the person owes, one line. ${INBOX_REF_LINK_POINTER}`),
          pr: z.string().optional().describe("owner/repo#123 or a PR URL."),
          ref: z.string().optional().describe("An issue or PR: owner/repo#123 or its URL."),
          reason: z.string().optional().describe("Why it is dropped."),
          thread_id: z.string().optional().describe("A thread or message id to link; create takes its subject when no title. Link the thread where the person makes the call."),
          idempotency_key: z.string().optional().describe("Create: the same key answers the first card."),
          asked_by: z.enum(["me", "anyone"]).optional().describe("List: \"me\" (default) or \"anyone\"."),
          include_resolved: z.boolean().optional().describe("List: shipped and dropped too."),
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          agent_session: z.string().optional().describe(AGENT_SESSION_DESCRIPTION),
          agent_name: z.string().optional().describe("How the person sees you, e.g. \"Claude Code\"."),
          agent_host: z.string().optional().describe("Your agent host, e.g. claude-code, codex, cursor."),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        const { text, structured } = await runCardCall(context, input);
        return okComplete(text, structured);
      }),
  );
}
