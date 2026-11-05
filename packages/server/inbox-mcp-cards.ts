/**
 * The Board's `card` tool (approval "inbox-board", step 1): the one-line call
 * an agent uses to keep a card current. A card is work that outlasts the
 * reply it was asked in (a lane started, a PR opened, "I'll send you X"); the
 * agent makes one when it takes such an ask and updates it at the moments it
 * already records (lane launched, PR opened, deliverable sent, waiting on the
 * person, done). The rules on who moves a card live in the store
 * (store.ts, "the Board's cards"); this module maps the tool onto them.
 *
 * Reached by the `plannotator_inbox` tool's action "card" (the Claude Code
 * mod, Pi, OpenCode), the stdio shim, and `plannotator card …` (the CLI's
 * thin client, apps/hook/server/card-command.ts).
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { inboxStoredAgentName } from "@plannotator/core/inbox-format";
import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_COLUMNS,
  INBOX_CARD_LIVE_COLUMNS,
  inboxAgentName,
  inboxCardRefsOf,
  inboxCardColumnOf,
  inboxCardInitiativeMadeNudge,
  inboxCardTitleHint,
  INBOX_CARD_INITIATIVE_FIELD,
  INBOX_CARD_INITIATIVE_RULE,
  isInboxCardDropUnseen,
  isInboxCardPersonColumn,
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

export const INBOX_CARD_OPS = ["create", "move", "say", "link", "ship", "drop", "list", "initiative_delete"] as const;
export type InboxCardOp = (typeof INBOX_CARD_OPS)[number];

/** For raw MCP clients; the agent tool words its action line itself (INBOX_AGENT_ACTION_LEADS.card). */
export const CARD_DESCRIPTION =
  "Keep a card on the person's Board for work that outlasts this reply (a lane started, a PR opened, \"I'll send you X\"), and keep it current with one short call as the work moves. op: create (a title: 2–5 words naming the work (\"Pi update fix\"), never a sentence; status goes in say), move (column), say (your last word, or what the person owes in `you`), link (thread_id, pr), ship (to done), drop (with a reason), list (your cards). The column says where the work stands: move it to in_review yourself when you hand your part over, with `you` and the Inbox thread where the person makes the call (thread_id), so \"You: …\" opens it. A question you ask mid-work leaves the card where it is. Ship it when you see its PR merge or the work is finished; the Board may also move it to done once every `pr` merged.";

/** Short on purpose: Pi and OpenCode send it with every request (INBOX_TOOL_COST). */
export const CARD_COLUMN_DESCRIPTION =
  "todo (asked or sent to you, not started; the default) · in_progress (you are working on it) · in_review (your part handed over: a ready PR, screenshots, a sheet; give `you`) · done (merged, live or finished) · dropped (cancelled; give `reason`) · backlog (nobody asked for it yet: an idea you propose; never a signal to start).";

/** What a `card` call gets while the Board is off (approval "inbox-board", 2026-10-26): nothing is written. */
export const INBOX_BOARD_OFF_TEXT =
  "board_off: The person's Board is off, so cards are not kept and nothing was written. They turn it on in the Plannotator Inbox's Settings → Capabilities; agents get the card action in their next session.";

const AGENT_SESSION_DESCRIPTION = "Your session id; the `plannotator inbox mcp` shim fills it. The cards you make are yours: list shows them.";

/** A column as a caller sent it, made a v2 id when it names one (old ids are aliases, inboxCardColumnOf); anything else is left for the enum to refuse. */
function columnInput(value: unknown): unknown {
  return inboxCardColumnOf(value) ?? value;
}

/** One card as one line of text: every fact an agent acts on. `initiativeName` names its initiative (a live one; the wire nulls a deleted one). */
export function cardLineText(card: InboxCardWire, initiativeName: (id: string) => string | null = () => null): string {
  const parts = [`- ${card.id}`, JSON.stringify(card.title), INBOX_CARD_COLUMN_LABELS[card.column]];
  const initiative = card.initiative ? initiativeName(card.initiative) : null;
  if (initiative) parts.push(`initiative ${JSON.stringify(initiative)}`);
  if (card.you && isInboxCardPersonColumn(card.column)) parts.push(`You: ${JSON.stringify(card.you)}`);
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

/**
 * The live initiatives, oldest first, each with how many cards it holds on
 * the whole Board (every project: an initiative crosses them; cancelled cards
 * left out), so an agent reuses one instead of making a near-duplicate
 * (INBOX_CARD_INITIATIVE_RULE: "list shows them"). Empty when there are none.
 */
export function cardInitiativesSummary(store: InboxStore): { line: string; initiatives: { id: string; name: string; cards: number }[] } {
  const live = store.initiatives().filter((initiative) => initiative.deleted_at === null);
  if (live.length === 0) return { line: "", initiatives: [] };
  const counts = new Map<string, number>();
  for (const card of store.listCards()) {
    if (card.column === "dropped") continue;
    const id = store.cardWire(card).initiative;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const initiatives = live.map((initiative) => ({ id: initiative.id, name: initiative.name, cards: counts.get(initiative.id) ?? 0 }));
  const line = `Initiatives: ${initiatives.map((i) => `${i.name} (${i.cards} card${i.cards === 1 ? "" : "s"})`).join(", ")}.`;
  return { line, initiatives };
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
  initiative?: string;
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
  create: ["title", "column", "say", "you", "thread_id", "pr", "ref", "initiative", "idempotency_key"],
  move: ["card_id", "column", "say", "you", "thread_id", "pr", "ref", "reason"],
  say: ["card_id", "say", "you", "title", "initiative"],
  link: ["card_id", "thread_id", "pr", "ref", "say"],
  ship: ["card_id", "say", "pr", "ref", "thread_id"],
  drop: ["card_id", "reason", "say"],
  list: ["asked_by", "include_resolved"],
  initiative_delete: ["initiative"],
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
  return { project: found.projects[0] ?? null, projectIds: new Set(found.projects.flatMap((p) => context.store.projectGroup(p.id))), unresolved: found.unresolved };
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
  // An initiative crosses projects, so deleting one needs no project of the caller's.
  if (input.op === "initiative_delete") {
    if (!input.initiative?.trim()) throw new InboxError("validation_error", "initiative: the one to delete, by name or id (list shows them).", { field: "initiative" });
    const named = store.initiativeToDelete(input.initiative);
    if (!named) throw new InboxError("initiative_not_found", `No initiative ${input.initiative.trim()}.`, { field: "initiative" });
    const cards = store.listCards().filter((card) => store.cardWire(card).initiative === named.id).length;
    const gone = store.deleteInitiative(named.id);
    return {
      text: `Deleted the initiative ${JSON.stringify(gone.name)}. Its ${cards} card${cards === 1 ? " stays" : "s stay"} on the Board, in no initiative.`,
      structured: { initiative: gone, cards_kept: cards },
    };
  }
  if (!project && input.op !== "list") {
    throw new InboxError(
      "card_no_project",
      "This folder's project has no Board yet: the Inbox has never had a message from it. Send one with send_message first, or pass the project_path of a project the Inbox knows.",
    );
  }
  const session = input.agent_session?.trim() || null;
  const by: InboxAuthor = { kind: "agent", host: input.agent_host?.trim() || null, session, name: inboxStoredAgentName(input.agent_name) };
  // A title that reads like a sentence gets a hint after the card line (approved 2026-10-27; never refused).
  const initiativeName = (id: string) => store.initiative(id)?.name ?? null;
  // Every initiative before this call, deleted ones too: one the answered card is in that is not among them, this call made.
  const knownInitiatives = new Set(store.initiatives().map((initiative) => initiative.id));
  const answer = (verb: string, wire: InboxCardWire, extra: Record<string, unknown> = {}, titled: string | null = null) => {
    const hint = titled === null ? null : inboxCardTitleHint(titled);
    const madeName = wire.initiative && !knownInitiatives.has(wire.initiative) ? initiativeName(wire.initiative) : null;
    const nudge = madeName === null ? null : inboxCardInitiativeMadeNudge(madeName);
    return {
      text: `${verb}:\n${cardLineText(wire, initiativeName)}${hint ? `\n${hint}` : ""}${nudge ? `\n${nudge}` : ""}`,
      structured: { card: wire, ...extra, ...(hint ? { title_hint: hint } : {}), ...(nudge ? { initiative_hint: nudge } : {}) },
    };
  };

  if (input.op === "list") {
    if (!project) {
      return { text: "No cards: the Inbox has never had a message from this folder's project.", structured: { project: null, cards: [], total: 0 } };
    }
    const askedBy = input.asked_by ?? (session ? "me" : "anyone");
    if (askedBy === "me" && !session) throw new InboxError("validation_error", "asked_by: \"me\" needs agent_session.", { field: "asked_by" });
    const columns = new Set<InboxCardColumn>(input.include_resolved ? INBOX_CARD_COLUMNS : INBOX_CARD_LIVE_COLUMNS);
    const cards = store.listCards({ projectIds, columns, agentSession: askedBy === "me" ? session : null }).map((card) => store.cardWire(card));
    const whose = askedBy === "me" ? "Your" : "All";
    const head = `${whose} ${cards.length} card${cards.length === 1 ? "" : "s"} in ${project.name}${input.include_resolved ? "" : " (done and dropped left out)"}.`;
    const parked = cards.some((card) => card.column === "backlog" && card.moved_by?.kind === "person")
      ? "\nA card the person put in Backlog is not asked for yet: leave its work alone until they send it to you."
      : "";
    const summary = cardInitiativesSummary(store);
    const lines = cards.map((card) => cardLineText(card, initiativeName)).join("\n");
    return {
      text: `${cards.length > 0 ? `${head}\n${lines}${parked}` : head}${summary.line ? `\n${summary.line}` : ""}`,
      structured: { project: { id: project.id, name: project.name, root: project.root }, cards, total: cards.length, initiatives: summary.initiatives },
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
      initiative_name: input.initiative,
    });
    return answer(replayed ? "Already made (the same idempotency_key)" : "Made a card on the person's Board; keep it current with move or say as the work moves", store.cardWire(card), { replayed }, card.title);
  }

  const card = cardInScope(store, input.card_id, projectIds);
  if (input.op === "move" && !input.column) throw new InboxError("validation_error", "column: where the card goes (move).", { field: "column" });
  if (input.op === "say" && !input.say && !input.you && !input.title && input.initiative === undefined) {
    throw new InboxError("validation_error", "say: your last word (or `you`, what the person owes; `title`; or `initiative`).", { field: "say" });
  }
  if (input.op === "link" && !input.thread_id && !input.pr && !input.ref) throw new InboxError("validation_error", "thread_id, pr or ref: what to link.", { field: "thread_id" });
  const column = input.op === "ship" ? "done" : input.op === "drop" ? "dropped" : input.column;
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
    initiative_name: input.initiative,
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
          // `done` is read as `ship` (its column is Done), unlisted so the schema stays as short.
          op: z.preprocess((value) => (value === "done" ? "ship" : value), z.enum(INBOX_CARD_OPS)),
          card_id: z.string().optional().describe("The card (crd_…); not for create or list."),
          title: z.string().optional().describe("2–5 words naming the work (\"Pi update fix\"), never a sentence; status goes in say. Create with thread_id: pass one, as subjects run long."),
          // The schema lists the v2 ids only; an id from before v2 (a cached tool list, older help) is read as its v2 column first.
          column: z.preprocess(columnInput, z.enum(INBOX_CARD_COLUMNS)).optional().describe(CARD_COLUMN_DESCRIPTION),
          say: z.string().optional().describe(`Your last word: where the work is, one line. ${INBOX_REF_LINK_POINTER}`),
          you: z.string().optional().describe(`What the person owes, one line. ${INBOX_REF_LINK_POINTER}`),
          pr: z.string().optional().describe("owner/repo#123 or a PR URL."),
          ref: z.string().optional().describe("A link: owner/repo#123, or any http(s) URL with its scheme (https://…). GitHub and GitLab issues and PRs show their live state; Jira and YouTrack issue links show their key; any other link shows as a plain link."),
          reason: z.string().optional().describe("Why it is dropped."),
          initiative: z.string().optional().describe(`${INBOX_CARD_INITIATIVE_FIELD} ${INBOX_CARD_INITIATIVE_RULE}`),
          thread_id: z.string().optional().describe("A thread or message id to link; create takes its subject when no title. Link the thread where the person makes the call."),
          idempotency_key: z.string().optional().describe("Create: the same key answers the first card."),
          asked_by: z.enum(["me", "anyone"]).optional().describe("List: \"me\" (default) or \"anyone\"."),
          include_resolved: z.boolean().optional().describe("List: done and dropped too."),
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
