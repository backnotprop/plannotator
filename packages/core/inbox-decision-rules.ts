/**
 * The rules the decision export's builder (`inbox-decisions.ts`) runs on: a stored question's row and fate (Decision
 * data's, so a thread's "decided" matches Settings -> Decision data), the person's own words, the privacy scrub, the
 * reader's zone and the order of the quiet groups.
 *
 * Internal: this file is not in core's `exports`, so no host can import it. Plannotator's shared code reaches it by
 * path (`packages/shared/inbox/decision-data.ts`, `decision-export.ts`), so each rule has one definition. Pure and
 * browser-safe (no `node:`).
 */
import type { DecisionExportState } from "./inbox-decisions";
import { INBOX_HOST_NAMES, isInboxNote, type InboxMessage, type InboxQuestionRecord } from "./inbox-types";

// ── A stored question's row (Decision data's rule; Settings -> Decision data reads the same) ──

export type DecisionFate = "answered" | "skipped" | "set_aside" | "replaced" | "archived" | "open" | "picked_unsent";

/** One question an agent asked; action items are not decisions. */
export interface DecisionRow {
  id: string;
  thread_id: string;
  project_id: string;
  agent: string;
  kind: string;
  asked_at: number;
  /** The last pick's moment, or the Send's when the Send carried the answer. */
  answered_at: number | null;
  sent_at: number | null;
  fate: DecisionFate;
  /** Whether the answer took the recommendation: null unless the question named one and was answered. */
  took: boolean | null;
  offered: boolean;
  stopped: boolean;
  holds_up: boolean;
  files: boolean;
  revisions: number;
}

export const DAY_MS = 86_400_000;
/** A time every later step can use, even moved into the reader's zone: `new Date(...).toISOString()` throws past this. */
export const readableTime = (at: unknown): at is number => typeof at === "number" && Number.isFinite(at) && Math.abs(at) <= 8.64e15 - 2 * DAY_MS;

/** An agent as the person sees it: its host's name ("Claude Code"), never a session or machine. */
export function agentLabel(author: { host?: string | null; name?: string | null }): string {
  if (author.host) return INBOX_HOST_NAMES[author.host] ?? author.host;
  if (author.name) return author.name;
  return "An agent";
}

function tookRecommendation(question: InboxQuestionRecord): { offered: boolean; took: boolean | null } {
  const recommended = question.parsed.choices.filter((choice) => choice.recommended).map((choice) => choice.label);
  if (recommended.length === 0) return { offered: false, took: null };
  const answer = question.answer;
  if (!answer || answer.skipped) return { offered: true, took: null };
  if (answer.other) return { offered: true, took: false };
  const picked = new Set(answer.selected);
  return { offered: true, took: picked.size === recommended.length && recommended.every((label) => picked.has(label)) };
}

/** The row of one stored question, or null when it is not a question an agent asked. */
export function decisionRowOf(question: InboxQuestionRecord, byId: ReadonlyMap<string, InboxMessage>, headOf: (projectId: string) => string, closedByArchive: (message: InboxMessage) => boolean): DecisionRow | null {
  if (question.kind === "action") return null;
  const message = byId.get(question.message_id);
  if (!message || message.author.kind !== "agent") return null;
  const asked = ms(message.created_at);
  if (asked === null) return null;
  const sent = question.sent_reply_id ? ms(byId.get(question.sent_reply_id)?.created_at) : null;
  let fate: DecisionFate;
  if (question.superseded_by) fate = "replaced";
  else if (question.set_aside) fate = "set_aside";
  else if (question.answer && question.revision > 0 && question.sent_revision === question.revision) fate = question.answer.skipped ? "skipped" : "answered";
  else if (question.answered_in_reply || closedByArchive(message)) fate = "archived";
  else fate = question.answer ? "picked_unsent" : "open";
  const decided = fate === "answered" || fate === "skipped";
  const { offered, took } = tookRecommendation(question);
  return {
    id: question.id,
    thread_id: message.thread_id,
    project_id: headOf(question.project_id),
    agent: agentLabel(message.author),
    kind: question.kind,
    asked_at: asked,
    answered_at: decided ? (ms(question.picked_at) ?? sent) : null,
    sent_at: decided ? sent : null,
    fate,
    took: fate === "answered" ? took : null,
    offered,
    stopped: question.stopped !== null,
    holds_up: question.holds_up.length > 0,
    files: (message.attachments?.length ?? 0) + (message.inline_images?.length ?? 0) > 0,
    revisions: question.revision,
  };
}

/**
 * When the person wrote this message in their own words, or null when it is not such a message: an agent's, a note the
 * Inbox wrote, a Re-ask press (the Inbox writes its words, the person typed none), or a reply that carried answers
 * (`carried`: the questions' `sent_reply_id`s). Decision data's "settled in words" and the decision export's
 * "Answered in words" both read it.
 */
export function ownWordsTime(message: InboxMessage, carried: ReadonlySet<string>): number | null {
  if (message.author.kind !== "person" || isInboxNote(message) || (message.reask?.length ?? 0) > 0) return null;
  const at = ms(message.created_at);
  if (!readableTime(at) || carried.has(message.id)) return null;
  return at;
}

// ── The owner's choices (answers to brief section 8, 2026-11-10) ──

/** The quiet groups after the decisions, in this order: drafts (picked, not sent) first, so D-numbers follow the decisions, drafts, then the rest, as the posts list them. */
export const DECISION_EXPORT_OTHER_STATES: readonly Exclude<DecisionExportState, "decided">[] = ["picked_unsent", "open", "answered_in_words", "skipped", "set_aside", "archived", "replaced"];

/** A row's fate as the export's state (an open or archived one may still become `answered_in_words`). */
export const STATE_OF_FATE: Readonly<Record<DecisionFate, DecisionExportState>> = {
  answered: "decided",
  picked_unsent: "picked_unsent",
  open: "open",
  skipped: "skipped",
  set_aside: "set_aside",
  archived: "archived",
  replaced: "replaced",
};

// ── Privacy: what free text may not carry ──

const LOCAL_HOST = String.raw`(?:localhost|[\w-]+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|[\w.-]+\.local|[\w.-]+\.ts\.net|[\w.-]+\.internal|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})`;
const LOCAL_URL = new RegExp(String.raw`\b[a-z][a-z0-9+.-]*://${LOCAL_HOST}(?::\d+)?[^\s<>()"'\]]*`, "gi");
const BARE_LOCAL = new RegExp(String.raw`\b${LOCAL_HOST}:\d{2,5}\b[^\s<>()"'\]]*`, "gi");
/** Another account's home, written out: `/Users/x`, `/home/x`, `C:\Users\x`. */
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s"'`<>()]+/g;
/** Shown where a local address was. */
export const DECISION_EXPORT_LOCAL_LINK = "(local link)";

/** Free text as the export may carry it: no local addresses, no home folder. */
export function scrubDecisionText(text: string, home?: string | null): string {
  let out = text.replace(LOCAL_URL, DECISION_EXPORT_LOCAL_LINK).replace(BARE_LOCAL, DECISION_EXPORT_LOCAL_LINK);
  if (home && home.length > 1) out = out.split(home).join("~");
  return out.replace(HOME_PATH, "~");
}

/** A path or address by its last part only: `docs/plan.html` -> `plan.html`, `http://localhost:3000/a/b` -> `b`. */
export function nameOnly(target: string): string {
  const path = target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
  const last = path.split(/[\\/]/).filter(Boolean).pop();
  return last ?? "";
}

// ── Times ──

/** The zone asked for, or UTC when the runtime does not know it. */
export function decisionExportZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());
export const ms = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/** Text on one line: every run of whitespace one space. */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
