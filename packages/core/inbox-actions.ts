/**
 * Plannotator Inbox: action items an agent needs the person to go do (approval
 * "inbox-next-actions", 2026-10-21, direction "In the thread").
 *
 * An agent writes a `:::action` block in a message body when it is stopped
 * on something only the person can do outside the conversation (approve a
 * deploy, sign in, touch a security key, merge a PR it cannot merge):
 *
 *   :::action
 *   Approve the production deploy on Vercel
 *   The 4.2 build passed every check and waits under "Promote to Production".
 *   Where: https://vercel.com/acme/web/deployments/dpl_8Hk2mQ
 *   Stopped: release 4.2 to production
 *   Watching: the deployment; I go on by myself once it is Ready.
 *   :::
 *
 * The first non-empty line is what to do (an order). Other lines are the why,
 * except these labelled ones (the first of each wins, any case):
 *
 *   Where: <url>, [name](url), "<name> <url>", or a place in words
 *   Run: <a command to copy>             (backticks around it are dropped)
 *   Stopped: <why> / Holds up: <a>; <b>  (as for questions, with the same
 *                                         negative-word guard)
 *   Watching: <what the agent watches>   (it will notice it done by itself)
 *   Replaces: <message id>/<a-key> …     (only when every token is an action item's id)
 *
 * This grammar is the Inbox's only: Plannotator's question grammar (and so
 * plan review) is unchanged. The block is found with core's directive scanner
 * (`findDirectiveBlocks`), so code fences and HTML blocks hide it exactly as
 * they hide a question. The store keeps each block as a question record of
 * kind `"action"` (key `a-` + hash8 of the first line), so its states,
 * Stopped / Holds up, Mark read, Re-ask and supersede, the reply and the wake
 * are the questions' own.
 *
 * Pure: no I/O, no clock unless passed in. Never throws on any input.
 */

import { blockKeyHash8, findDirectiveBlocks, MAX_QUESTION_PROMPT_CHARS, normalizeQuestionText } from "./question-block";
import { INBOX_REPLY_SENTENCE_LINE, isNegativeWaitValue } from "./inbox-questions";
import { cutText } from "./text-cut";
import type { InboxActionFacts, InboxActionResult, InboxQuestionRecord } from "./inbox-types";

/** The directive an agent writes: `:::action`. */
export const INBOX_ACTION_DIRECTIVE = "action";

/** What the window calls it ("Action item · something only you can do"). */
export const INBOX_ACTION_LABEL = "Action item";

/** `a-` + hash8 of the normalized first line: a reworded action item is a new action item. */
export function inboxActionKey(prompt: string): string {
  return `a-${blockKeyHash8(`action\n${normalizeQuestionText(prompt)}`)}`;
}

/** An action item's key, `-2`, `-3`… for repeats in one message included. */
export const INBOX_ACTION_KEY_RE = /^a-[0-9a-f]{8}(?:-\d{1,3})?$/;

/** One `:::action` block of a message body, in block order. */
export interface ParsedInboxAction {
  key: string;
  /** Its place among the message's action items (A1 is 0). */
  position: number;
  /** What to do: the block's first non-empty line, plain. */
  prompt: string;
  /** The other lines, the why; null when there are none. */
  why: string | null;
  action: InboxActionFacts;
  stopped: string | null;
  holds_up: string[];
  /** The block's `Replaces:` ids, as written (checked by the store). */
  replaces: string[];
  /** 1-based line of the first line (what to do) in the body. */
  line: number;
  /** 1-based line of the opening `:::action`. */
  startLine: number;
}

const LABEL_RE = /^(where|run|stopped|holds up|watching|replaces)\s*:\s*(.*)$/i;
// An action item replaces only an action item: `<message id>/a-…`, or `<message id>` (its action items).
const ID_TOKEN = String.raw`msg_[0-9A-HJKMNP-TV-Z]{26}(?:/a-[0-9a-f]{8}(?:-\d{1,3})?)?\.?`;
const REPLACES_VALUE_RE = new RegExp(String.raw`^(${ID_TOKEN}(?:[\s,;]+${ID_TOKEN})*)[\s,;]*$`);

/** The first line, plain: a heading mark, a list marker and emphasis around the whole line dropped. */
function plainPrompt(line: string): string {
  let text = line.trim().replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, "");
  const emphasis = /^(\*\*|__|\*|_)(.+)\1$/.exec(text);
  if (emphasis) text = emphasis[2]!.trim();
  return cutText(text.replace(/\s+/g, " ").trim(), MAX_QUESTION_PROMPT_CHARS);
}

/** An http(s) URL, or null (a link that could run anything never becomes a button). */
function httpUrl(value: string): string | null {
  const trimmed = value.trim().replace(/^<(.+)>$/, "$1");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** `Where:`'s value: a link (with a name, or named by its host), else a place in words. */
export function parseInboxActionWhere(value: string): { where: string | null; where_url: string | null } {
  const text = value.trim();
  if (text === "") return { where: null, where_url: null };
  const link = /^\[([^\]]+)\]\((.+)\)\.?$/.exec(text);
  if (link) {
    const url = httpUrl(link[2]!);
    return url ? { where: link[1]!.trim() || hostOf(url), where_url: url } : { where: link[1]!.trim(), where_url: null };
  }
  const found = /<?(https?:\/\/[^\s>]+)>?/i.exec(text);
  if (found) {
    const url = httpUrl(found[1]!.replace(/[.,;:!?)]+$/, ""));
    if (url) {
      const name = (text.slice(0, found.index) + text.slice(found.index + found[0].length))
        .replace(/^[\s:–—-]+|[\s:–—(-]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return { where: name || hostOf(url), where_url: url };
    }
  }
  return { where: text.replace(/\s+/g, " "), where_url: null };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `Run:`'s value: one pair of backticks (single or triple) around the whole command is dropped. */
function runCommand(value: string): string | null {
  let text = value.trim();
  const fenced = /^(`{1,3})(.+)\1$/.exec(text);
  if (fenced) text = fenced[2]!.trim();
  return text === "" ? null : text;
}

/**
 * One `:::action` block's inner text, read. Null when the block has no first
 * line (nothing to do).
 */
export function parseInboxActionBlock(inner: string): Omit<ParsedInboxAction, "key" | "position" | "line" | "startLine"> & { promptLine: number } | null {
  if (typeof inner !== "string") return null;
  const lines = inner.replace(/\r\n?/g, "\n").split("\n");
  let promptLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || LABEL_RE.test(line)) continue;
    promptLine = i;
    break;
  }
  if (promptLine === -1) return null;
  const prompt = plainPrompt(lines[promptLine]!);
  if (prompt === "") return null;
  const why: string[] = [];
  const seen = new Set<string>();
  const facts: InboxActionFacts = { where: null, where_url: null, run: null, watching: null };
  let stopped: string | null = null;
  let holdsUp: string[] = [];
  let replaces: string[] = [];
  lines.forEach((raw, index) => {
    if (index === promptLine) return;
    const line = raw.trim();
    const label = LABEL_RE.exec(line);
    const name = label?.[1]!.toLowerCase() ?? null;
    if (label && name === "replaces" && !REPLACES_VALUE_RE.test(label[2]!.trim())) {
      // Not ids: prose, read as the why.
      why.push(raw);
      return;
    }
    if (!label || !name) {
      why.push(raw);
      return;
    }
    if (seen.has(name)) return;
    seen.add(name);
    const value = label[2]!.trim();
    if (name === "where") Object.assign(facts, parseInboxActionWhere(value));
    else if (name === "run") facts.run = runCommand(value);
    else if (name === "watching") facts.watching = value === "" ? null : value.replace(/\s+/g, " ");
    else if (name === "stopped") stopped = isNegativeWaitValue(value) ? null : value;
    else if (name === "holds up") holdsUp = value.split(";").map((v) => v.trim()).filter((v) => v !== "" && !isNegativeWaitValue(v));
    else if (name === "replaces") {
      replaces = value
        .split(/[\s,;]+/)
        .map((token) => token.replace(/\.$/, ""))
        .filter((token) => token !== "");
    }
  });
  const whyText = why.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { prompt, why: whyText === "" ? null : whyText, action: facts, stopped, holds_up: holdsUp, replaces, promptLine };
}

/**
 * The `:::action` blocks of a message body, in block order, keys
 * de-duplicated (`-2`, `-3`…) as question keys are. A body is read like a
 * comment: no frontmatter. [] when there is none.
 */
export function parseInboxActionBlocks(markdown: string): ParsedInboxAction[] {
  if (typeof markdown !== "string" || !/:::\s*action/i.test(markdown)) return [];
  const out: ParsedInboxAction[] = [];
  const seen = new Map<string, number>();
  for (const block of findDirectiveBlocks(markdown, { frontmatter: false })) {
    if (block.directiveKind !== INBOX_ACTION_DIRECTIVE) continue;
    const parsed = parseInboxActionBlock(block.inner);
    if (parsed === null) continue;
    const base = inboxActionKey(parsed.prompt);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const { promptLine, ...rest } = parsed;
    out.push({
      ...rest,
      key: count === 1 ? base : `${base}-${count}`,
      position: out.length,
      line: block.startLine + 1 + promptLine,
      startLine: block.startLine,
    });
  }
  return out;
}

// ─────────────────────────────── The person's result ───────────────────────────────

/** How long a note or a reason may be. */
export const INBOX_ACTION_NOTE_MAX = 2000;

/**
 * The person's Done or Can't do it, checked: `outcome` "done" (with an
 * optional note) or "cant" (with a reason, required). Null outcome: the Undo.
 */
export function checkInboxActionResult(
  raw: { outcome?: unknown; note?: unknown },
): { ok: true; outcome: "done" | "cant" | null; note: string | null } | { ok: false; field: string; message: string } {
  const outcome = raw.outcome;
  if (outcome === null) return { ok: true, outcome: null, note: null };
  if (outcome !== "done" && outcome !== "cant") return { ok: false, field: "outcome", message: 'outcome: "done", "cant", or null to undo.' };
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== "string") return { ok: false, field: "note", message: "note: text." };
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > INBOX_ACTION_NOTE_MAX) return { ok: false, field: "note", message: `note: at most ${INBOX_ACTION_NOTE_MAX} characters.` };
  if (outcome === "cant" && note === "") return { ok: false, field: "note", message: "note: say why you can't do it; the agent gets it word for word." };
  return { ok: true, outcome, note: note === "" ? null : note };
}

// ─────────────────────────────── What the agent gets ───────────────────────────────

/** The section the reply carries (approval "inbox-next-actions", brief). */
export const INBOX_ACTIONS_HEADING = "Action items you asked for";

/** "3:12 PM" in the computer's own time (the person's clock). */
export function inboxActionTime(at: string, timeZone?: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  try {
    return date
      .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) })
      .replace(/\s/g, " ");
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

const actionsWord = (n: number): string => `${n} action item${n === 1 ? "" : "s"}`;

type ReportedAction = Pick<InboxQuestionRecord, "key" | "position" | "prompt" | "action_result">;
type AnyAction = Pick<InboxQuestionRecord, "key" | "position" | "action_result" | "superseded_by" | "sent_revision" | "revision">;

/** One asking message's action items a report carries (`reported`), and all of that message's action items (`all`), for "x of y done". */
export interface InboxActionsReportGroup {
  message_id: string;
  reported: readonly ReportedAction[];
  all: readonly AnyAction[];
}

/**
 * The person's own mark on a reported item, for the reply's first sentence: an item the agent's own `done`
 * settled (Q3) counts as the person had marked it in their draft, so a Can't do it they marked reads
 * "Couldn't do 1 action item." over "You saw it done" and their reason, never "Did 1 action item.". The
 * "x of y done." line still counts it done: it is.
 */
function personOutcome(result: InboxActionResult): "done" | "cant" {
  return result.by === "agent" ? (result.person?.outcome ?? "done") : result.outcome;
}

/** A note or reason inside one item's lines: blank lines closed up, so the item stays one paragraph. */
const flatNote = (text: string | null | undefined): string => (text ?? "").trim().replace(/\n[ \t]*\n+/g, "\n");

/** One reported action item's lines, under a heading of its level. */
function reportedItem(r: ReportedAction, heading: "###" | "####", timeZone: string | undefined): string {
  const result = r.action_result!;
  const head = `${heading} A${r.position + 1}. ${r.prompt.replace(/\s+/g, " ").trim()}`;
  if (result.by === "agent") {
    // The agent saw it done while the person's mark waited in their draft: the person's note still goes (Q3).
    const note = flatNote(result.person?.note);
    const label = result.person?.outcome === "cant" ? "Their reason" : "Note";
    return [head, `You saw it done, ${inboxActionTime(result.at, timeZone)}.`, ...(note ? [`${label}: ${note}`] : [])].join("\n");
  }
  if (result.outcome === "cant") return `${head}\nCan't do it: ${flatNote(result.note)}`;
  return [head, `Done, ${inboxActionTime(result.at, timeZone)}.`, ...(result.note ? [`Note: ${flatNote(result.note)}`] : [])].join("\n");
}

/** "x of y done." for one message: y its action items not superseded (the agent's own `done` counts as done). */
function doneLine(group: InboxActionsReportGroup, reported: readonly ReportedAction[]): string {
  const reportedKeys = new Set(reported.map((r) => r.key));
  const live = group.all.filter((r) => !r.superseded_by);
  const total = Math.max(live.length, reported.length);
  const doneAll = live.filter((r) => {
    if (reportedKeys.has(r.key)) {
      const result = reported.find((x) => x.key === r.key)!.action_result!;
      return result.by === "agent" || result.outcome === "done";
    }
    const result = r.action_result;
    if (!result || result.outcome !== "done") return false;
    return result.by === "agent" || (r.revision > 0 && r.sent_revision === r.revision);
  }).length;
  return `${doneAll} of ${total} done.`;
}

/**
 * The person's action items as a reply carries them: "Did 1 action item." (or
 * "Couldn't do 1 action item.", "Did 1 action item, couldn't do 1."), then the
 * "Action items you asked for" section, each action item A-numbered as the
 * card, with "Done, 3:12 PM." and the note, or "Can't do it: <reason>" (an item
 * the agent saw done itself while the person's mark waited in their draft:
 * "You saw it done, 3:14 PM." and the person's note). One message: "x of y
 * done." then its items. Several (one reply answers one session's messages),
 * or one that is not the message the reply answers (`replyTo`): a
 * "### Your message <id>" sub-heading each, as the answers section does, so
 * "A1" never names two items. Then the still-open line (#2059), where an item
 * of another message than `replyTo` is named with its message. Empty when
 * nothing is reported.
 */
export function composeInboxActionsSection(input: {
  groups: readonly InboxActionsReportGroup[];
  /** The asking session's questions and action items still waiting on the person, for the last line (#2059). */
  stillOpen?: readonly InboxStillOpenItem[];
  /** The message the reply answers (its `reply_to`): its items need no message named. Absent: one message, nothing named. */
  replyTo?: string;
  timeZone?: string;
}): string {
  const groups = input.groups
    .map((g) => ({ group: g, reported: [...g.reported].filter((r) => r.action_result).sort((a, b) => a.position - b.position) }))
    .filter((g) => g.reported.length > 0);
  if (groups.length === 0) return "";
  const all = groups.flatMap((g) => g.reported);
  const done = all.filter((r) => personOutcome(r.action_result!) === "done").length;
  const cant = all.length - done;
  const sentence =
    done > 0 && cant > 0 ? `Did ${actionsWord(done)}, couldn't do ${cant}.` : done > 0 ? `Did ${actionsWord(done)}.` : `Couldn't do ${actionsWord(cant)}.`;
  const open = inboxActionsStillOpenLine(input.stillOpen ?? [], input.replyTo);
  const labelled = groups.length > 1 || (input.replyTo !== undefined && groups[0]!.group.message_id !== input.replyTo);
  const body =
    !labelled
      ? [doneLine(groups[0]!.group, groups[0]!.reported), ...groups[0]!.reported.map((r) => reportedItem(r, "###", input.timeZone))]
      : groups.flatMap(({ group, reported }) => [
          `### Your message ${group.message_id}`,
          doneLine(group, reported),
          ...reported.map((r) => reportedItem(r, "####", input.timeZone)),
        ]);
  return [sentence, `## ${INBOX_ACTIONS_HEADING}`, ...body, ...(open ? [open] : [])].join("\n\n");
}

/**
 * The report the timed path sends on its own (decision mode, the phone door,
 * an older window; approval "inbox-next-actions"): one asking message's
 * action items, as `composeInboxActionsSection` writes them. `all` is the
 * message's action items, for the "x of y done" line.
 */
export function composeInboxActionsReply(input: {
  reported: readonly ReportedAction[];
  all: readonly AnyAction[];
  /** That message's questions and action items still waiting on the person, for the last line (#2059). */
  stillOpen?: readonly InboxStillOpenItem[];
  timeZone?: string;
}): string {
  return composeInboxActionsSection({ groups: [{ message_id: "", reported: input.reported, all: input.all }], stillOpen: input.stillOpen, timeZone: input.timeZone });
}

/**
 * A person's reply with their action items in it (approval
 * "inbox-action-items-in-reply"): the action sentence joins the reply's own
 * first line when it has one ("Answered 1 question, did 1 action item."),
 * else opens the reply; the "Action items you asked for" section goes after
 * everything else (the words, the still-open line, the answers).
 */
export function withInboxActionsSection(replyBody: string, actionsSection: string): string {
  if (actionsSection === "") return replyBody;
  const [actionSentence, ...section] = actionsSection.split("\n\n");
  const parts = replyBody === "" ? [] : replyBody.split("\n\n");
  if (INBOX_REPLY_SENTENCE_LINE.test(parts[0] ?? "")) {
    parts[0] = `${parts[0]!.slice(0, -1)}, ${actionSentence!.charAt(0).toLowerCase()}${actionSentence!.slice(1)}`;
  } else parts.unshift(actionSentence!);
  return [...parts, ...section].join("\n\n");
}

/** The action sentence a reply opens with, alone or joined to the answers' ("…, did 1 action item."). */
const ACTION_SENTENCE = String.raw`(?:Did \d+ action items?(?:, couldn't do \d+)?|Couldn't do \d+ action items?)`;

const ACTION_SENTENCE_JOINED = String.raw`(?:did \d+ action items?(?:, couldn't do \d+)?|couldn't do \d+ action items?)`;

/**
 * A person's reply as the window draws it once the action items it carried
 * are listed apart (the thread's "You did 1 action item"): without the action
 * sentence (or its half of a joined first line) and without the "Action items
 * you asked for" section (its heading, "x of y done.", its items and its
 * still-open line).
 * Display only: the agent got every word.
 */
export function withoutInboxActionsSection(body: string): string {
  let text = body.replace(new RegExp(String.raw`^((?:Answered|Skipped) [^\n]*?), ${ACTION_SENTENCE_JOINED}\.(?=\n|$)`), "$1.");
  text = text.replace(new RegExp(String.raw`^${ACTION_SENTENCE}\.(?:\n\n|$)`), "");
  // The section is paragraphs: its heading, "x of y done.", the items (### / ####), the still-open line.
  const paragraphs = text.split("\n\n");
  const at = paragraphs.indexOf(`## ${INBOX_ACTIONS_HEADING}`);
  if (at < 0) return text.trim();
  let end = at + 1;
  while (end < paragraphs.length && /^(?:\d+ of \d+ done\.$|#{3,4} |Still open: )/.test(paragraphs[end]!)) end += 1;
  return [...paragraphs.slice(0, at), ...paragraphs.slice(end)].join("\n\n").trim();
}

/** A question (Q1…) or action item (A1…) of the message a report answers that still waits on the person. */
export interface InboxStillOpenItem {
  kind: "question" | "action";
  /** 0-based, as the record's `position`: Q1 / A1 is 0. */
  position: number;
  prompt: string;
  /** The message that asks it: named in the line when it is not the message the reply answers. */
  message_id?: string;
}

/**
 * The report's last line when some of that message's questions or action
 * items still wait on the person (#2059), like the reply's still-open line:
 * "Still open: A2. Approve the 2FA prompt for the npm org — the person will
 * do it in the Inbox; don't ask again." Empty when nothing is open.
 */
export function inboxActionsStillOpenLine(items: readonly InboxStillOpenItem[], replyTo?: string): string {
  if (items.length === 0) return "";
  // The replied-to message's items first, then each other message's, in the order given.
  const other = (i: InboxStillOpenItem) => replyTo !== undefined && i.message_id !== undefined && i.message_id !== replyTo;
  const sorted = [...items].sort((a, b) => Number(other(a)) - Number(other(b)) || (a.kind === b.kind ? a.position - b.position : a.kind === "question" ? -1 : 1));
  const names = sorted.map((i) => `${i.kind === "action" ? "A" : "Q"}${i.position + 1}${other(i) ? ` (your message ${i.message_id})` : ""}. ${i.prompt.replace(/\s+/g, " ").trim()}`);
  const one = items.length === 1;
  const actions = items.some((i) => i.kind === "action");
  const questions = items.some((i) => i.kind === "question");
  const verb = actions && questions ? "answer or do" : actions ? "do" : "answer";
  return `Still open: ${names.join("; ")} — the person will ${verb} ${one ? "it" : "them"} in the Inbox; don't ask again.`;
}

/** The card's words for an action item's result ("Done 3:12 PM", "Can't do it: …", "Claude Code saw it done"). */
export function inboxActionResultLine(result: InboxActionResult, agent: string, timeZone?: string): string {
  const time = inboxActionTime(result.at, timeZone);
  if (result.by === "agent") return `${agent} saw it done, ${time}`;
  if (result.outcome === "cant") return `Can't do it: ${result.note ?? ""}`.trim();
  return `Done ${time}`;
}

// ─────────────────────────────── The agent's own `done` ───────────────────────────────

const DONE_REF_RE = /^(msg_[0-9A-HJKMNP-TV-Z]{26})(?:\/(a-[0-9a-f]{8}(?:-\d{1,3})?))?$/;

/**
 * One id an agent marks done with (send_message's `done`): `<message id>`
 * (every open action item of that message) or `<message id>/<key>` (one). Null when
 * it is neither.
 */
export function parseInboxDoneRef(value: unknown): { message_id: string; key: string | null } | null {
  if (typeof value !== "string") return null;
  const match = DONE_REF_RE.exec(value.trim());
  if (!match) return null;
  return { message_id: match[1]!, key: match[2] ?? null };
}

// ─────────────────────────────── What agents are told ───────────────────────────────

/**
 * A `:::action` block as agents are shown it (send_message's `body`, the
 * agent guide). inbox-actions.test.ts parses it with the store's own reader.
 */
export const INBOX_ACTION_EXAMPLE = [
  ":::action",
  "Approve the production deploy on Vercel",
  'The 4.2 build passed every check and waits under "Promote to Production". Nothing else needs changing.',
  "",
  "Where: https://vercel.com/acme/web/deployments",
  "Stopped: release 4.2 cannot go out until it is approved",
  "Watching: the deployment; I go on by myself once it is Ready",
  ":::",
].join("\n");

/**
 * When to write a `:::action` block, and when not (the owner: "only when
 * there's like a true blocker like a user actually has to do some shit").
 * Rides send_message's `body` description (it reaches the model whole) and
 * the agent guide. Never in QUESTION_AUTHORING_GUIDE: plan review shares it.
 */
export const INBOX_ACTION_GUIDE = [
  "An action item, only for a true blocker: something the person must go and do outside this conversation before you can go on, that you cannot do yourself (approve a deploy, sign in, touch a security key, click something in another app, merge a pull request you cannot merge). Write it as an Inbox-only `:::action` block: the first line is what to do, as an order; then why, in a line or two. Optional lines: `Where: <url or place>` (a URL becomes an Open button), `Run: <command>` (a command to copy), `Stopped:` / `Holds up:` as for questions, and `Watching: <what you watch>` when you will notice it done by yourself (then pass its id in `done`).",
  "Never use it for a decision or a question (ask a :::question), for anything you can do yourself, or as a checklist or a status update: one block per real blocker, and most messages need none. The person marks it Done or Can't do it (with a reason); that comes back in their reply under \"Action items you asked for\".",
].join("\n");

/** send_message's (and submit_guide's) `done`, as an agent reads it. */
export const INBOX_DONE_DESCRIPTION =
  "Your own action items (`:::action` blocks) in this thread that you saw done yourself, e.g. the deployment you were watching is Ready: \"<message id>/<key>\" for one (the key starts with a-; read_thread gives it) or \"<message id>\" for every open action item of that message. The card then says you saw it done, and nothing is sent to the person. Only your own action items that are still open, or that the person marked in a reply draft they have not sent, in the thread this message lands in (use reply_to); otherwise nothing is sent and the refusal, invalid_done, lists the thread's open action items. Never mark done what you did not see happen.";
