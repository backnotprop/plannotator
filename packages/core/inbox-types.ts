/**
 * Plannotator Inbox: the browser-safe record and wire shapes.
 *
 * The Inbox is one long-lived local server (`plannotator inbox`) that holds
 * messages agents send and the person's answers. Its store is append-only
 * JSONL under `${dataDir}/inbox/` (packages/shared/inbox/), one full snapshot
 * per line; these are the shapes of those snapshots and of what the window's
 * API and the MCP tools answer with.
 *
 * Kept identical to Workspaces on the wire where the two overlap (the
 * `Question` shape, its derived `state`, `QuestionAnswer` v1, ISO-8601 UTC
 * times, snake_case fields), so a later sync is a mapping, not a migration.
 *
 * Browser-safe and dependency-free apart from core's own question model.
 */

import type { QuestionAnswer, QuestionKind } from "./question-block";
import type { InboxAnnotationRecord, InboxAttachment } from "./inbox-attachments";

// The attachment shapes and file rules (step 2) live in their own module and
// reach the Inbox through this published entry, so core's export map is unchanged.
export * from "./inbox-attachments";

/** Every record and line carries this version. Fields are only ever added. */
export const INBOX_RECORD_VERSION = 1 as const;

// ─────────────────────────────── Ids ───────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID (48-bit millisecond time + 80 random bits, Crockford base32), so ids
 * sort by creation time and a later sync can keep them as they are.
 */
export function ulid(now: number = Date.now()): string {
  let time = Math.max(0, Math.floor(now));
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let randomPart = "";
  for (let i = 0; i < 16; i++) randomPart += CROCKFORD[bytes[i]! % 32];
  return timePart + randomPart;
}

export type InboxIdPrefix = "msg" | "prj" | "ses" | "dec";

export function inboxId(prefix: InboxIdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

const ID_RE: Record<InboxIdPrefix, RegExp> = {
  msg: /^msg_[0-9A-HJKMNP-TV-Z]{26}$/,
  prj: /^prj_[0-9A-HJKMNP-TV-Z]{26}$/,
  ses: /^ses_[0-9A-HJKMNP-TV-Z]{26}$/,
  dec: /^dec_[0-9A-HJKMNP-TV-Z]{26}$/,
};

export function isInboxId(prefix: InboxIdPrefix, value: unknown): value is string {
  return typeof value === "string" && ID_RE[prefix].test(value);
}

// ─────────────────────────────── Thread names ───────────────────────────────

/** The longest `thread` name send_message takes, in characters. */
export const INBOX_THREAD_NAME_MAX = 120;

const THREAD_NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/**
 * Bidi controls (LRE..RLO, LRI..PDI, LRM, RLM, ALM) reorder the text around
 * them, so a name holding one can draw as another name in the list.
 */
const THREAD_NAME_BIDI = /\p{Bidi_Control}/u;
/** Code points that draw as nothing (zero-width space and joiners, BOM, variation selectors...). */
const THREAD_NAME_INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * A `thread` name as sent: trimmed, 1..120 characters, no control characters
 * or line breaks, no bidi controls, and something visible in it (a name made
 * only of zero-width characters is empty).
 */
export function checkInboxThreadName(value: unknown): { ok: true; name: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "must be a string." };
  const name = value.trim();
  const length = [...name].length;
  if (length === 0 || inboxThreadNameKey(name) === "") return { ok: false, message: "must not be empty." };
  if (length > INBOX_THREAD_NAME_MAX) return { ok: false, message: `at most ${INBOX_THREAD_NAME_MAX} characters.` };
  if (THREAD_NAME_CONTROL.test(name)) return { ok: false, message: "must not contain control characters or line breaks." };
  if (THREAD_NAME_BIDI.test(name)) return { ok: false, message: "must not contain bidirectional control characters." };
  return { ok: true, name };
}

/**
 * What two thread names are compared by: compatibility-normalized (NFKC, so
 * a full-width "\uff41\uff55\uff54\uff48" is "auth"), invisible code points dropped (a
 * zero-width space cannot make a second thread that looks like the first),
 * runs of whitespace as one space, case folded (upper then lower, so "\u00df" is
 * "ss"). "Auth refactor" and "auth  Refactor" are one thread. The stored
 * name keeps the first sender's spelling.
 */
export function inboxThreadNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(THREAD_NAME_INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .toLowerCase();
}

// ─────────────────────────────── Records ───────────────────────────────

/** One row of the window: the repository or folder an agent works in. */
export interface InboxProject {
  id: string;
  /** The folder name under `inbox/projects/`: `<name>-<6 hex of the root>`. */
  key: string;
  name: string;
  /** Absolute realpath of the repository root (git toplevel) or folder. */
  root: string;
  created_at: string;
}

export type InboxAuthor =
  | { kind: "person" }
  | {
      kind: "agent";
      /** The agent host when known (`claude-code`, `codex`, ...). */
      host: string | null;
      /** The asking session: the stdio shim's own `ses_` id, or a host's session id. */
      session: string | null;
      /** A display name the agent gave itself. */
      name: string | null;
    };

/** The hosts whose names the Inbox knows, keyed by `author.host`. */
export const INBOX_HOST_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  pi: "Pi",
  opencode: "OpenCode",
  codex: "Codex",
  cursor: "Cursor",
};

/** How the person sees an agent: the name it gave, else its host's name, else "An agent". */
export function inboxAgentName(author: { kind: string; host?: string | null; name?: string | null } | null | undefined): string {
  if (!author || author.kind !== "agent") return "An agent";
  if (author.name) return author.name;
  if (author.host) return INBOX_HOST_NAMES[author.host] ?? author.host;
  return "An agent";
}

/** A message or reply. A thread is its root message's id. */
export interface InboxMessage {
  id: string;
  project_id: string;
  thread_id: string;
  reply_to: string | null;
  author: InboxAuthor;
  /** Set on a thread's root: the agent's subject, or one derived from the body. */
  subject: string | null;
  /** Markdown, as sent. */
  body: string;
  created_at: string;
  /** On a thread's root: when the thread was resolved, or null while open. */
  resolved_at: string | null;
  /** The sender's idempotency key, when one was given. */
  idempotency_key: string | null;
  /**
   * The `thread` name the agent sent this message with (send_message's
   * `thread`), else absent or null. On a root it is the thread's name: a
   * named thread is joined by name across sessions; an unnamed root is its
   * session's default thread. Added after step 1: older records lack it.
   */
  thread_name?: string | null;
  /**
   * On a root: the event-log seq up to which the person has looked at the
   * thread (the window's "seen"). Agent messages after it are "New since you
   * looked". Absent until the first look.
   */
  person_seen_seq?: number | null;
  /**
   * On a root: the seq up to which the asking agent has read the person's
   * replies (wait_for_reply returned one, or read_thread read the thread),
   * and when. A Sent row moves to Quiet once its reply is checked.
   */
  agent_checked_seq?: number | null;
  agent_checked_at?: string | null;
  /**
   * The files an agent attached (send_message's `attachments`), recorded at
   * send time and read only by their ids (see inbox-attachments.ts). Added in
   * step 2: older records lack it.
   */
  attachments?: InboxAttachment[];
  /**
   * On a person's reply: it reached the asking agent's session as a turn
   * through an agent connection (the Claude Code mod), and when. Absent until
   * then; a reply the agent read through the MCP has none. "Replied" is not
   * stored: it is the asking session's next message in the thread. Added in
   * step 6: older records lack it.
   */
  delivery?: InboxDelivery | null;
}

/** How a person's reply reached the agent session that asked (`InboxMessage.delivery`). */
export interface InboxDelivery {
  state: "delivered";
  /** The connection's host, e.g. `claude-code`. */
  host: string;
  /** The session the reply was delivered to (the asking message's `author.session`). */
  session: string;
  at: string;
}

/** One choice as the wire serves it (Workspaces' `QuestionChoice`). */
export interface InboxQuestionChoice {
  label: string;
  description: string | null;
  recommended: boolean;
  settled: boolean;
}

/** The parsed facts of a question block, kept on its record. */
export interface InboxQuestionFacts {
  context: string | null;
  choices: InboxQuestionChoice[];
  /** Plannotator's older names per choice (core `aliases`), in choice order; never served. */
  aliases: (string[] | null)[];
  recommendation: string | null;
  suggested_text: string | null;
  /** 1-based line of the prompt in the message body (the export's `(line N)`). */
  line: number;
}

export interface InboxPicker {
  id: string;
  name: string | null;
}

/** The stored question: one per question block of an agent's message. */
export interface InboxQuestionRecord {
  /** `<message id>/<question key>`. */
  id: string;
  project_id: string;
  message_id: string;
  key: string;
  position: number;
  kind: QuestionKind;
  prompt: string;
  parsed: InboxQuestionFacts;
  decision_on_answer: boolean;
  stopped: string | null;
  holds_up: string[];
  asked_by_agent_id: string | null;
  answer: QuestionAnswer | null;
  revision: number;
  sent_revision: number;
  picked_by: InboxPicker | null;
  picked_at: string | null;
  sent_reply_id: string | null;
  decision_id: string | null;
  /**
   * The card's "Records a decision" switch, as the person set it. Absent
   * until they touch it: then a `Decision: when answered` question records
   * and any other does not (`inboxDecisionRecording`). Added in step 3.
   */
  decision_recording?: boolean;
  /** The decision card's words after Done; null or absent: the drafted words. Added in step 3. */
  decision_draft?: InboxDecisionDraft | null;
}

/**
 * The decision card's words as the person left them on Done. A null field
 * was not edited and keeps following the drafted words (the answer, and
 * "Asked by <agent>: <question>"), so a later pick still drafts anew.
 */
export interface InboxDecisionDraft {
  text: string | null;
  reason: string | null;
}

export type InboxQuestionState = "open" | "picked" | "sent" | "closed";

/**
 * A question as the window and the agents read it: Workspaces' `Question`
 * exactly (`asked_by_checked_at` omitted, as Workspaces omits it outside its
 * two comment lists), plus the Inbox's `message_id`.
 */
export interface InboxQuestion {
  key: string;
  position: number;
  kind: QuestionKind;
  prompt: string;
  context: string | null;
  choices: InboxQuestionChoice[];
  recommendation: string | null;
  suggested_text: string | null;
  decision_on_answer: boolean;
  stopped: string | null;
  holds_up: string[];
  asked_by_agent_id: string | null;
  orphaned: boolean;
  state: InboxQuestionState;
  answer: QuestionAnswer | null;
  revision: number;
  sent_revision: number;
  picked_by: InboxPicker | null;
  picked_at: string | null;
  sent_reply_id: string | null;
  decision_id: string | null;
  message_id: string;
  /** Whether Send records this answer as a decision (the card's switch, or its default). */
  decision_recording: boolean;
  /** The decision card's edited words, or null for the drafted ones. */
  decision_draft: InboxDecisionDraft | null;
}

/** Workspaces' `NotificationQuestionSummary`: a row's questions, summed. */
export interface InboxQuestionSummary {
  open: number;
  picked: number;
  stopped: boolean;
  holds_up: string[];
  prompt: string | null;
}

export interface InboxMessageWire extends InboxMessage {
  /** Omitted when the message asks no question (the Workspaces rule). */
  questions?: InboxQuestion[];
}

export interface InboxThreadSummary {
  thread_id: string;
  project_id: string;
  subject: string | null;
  author: InboxAuthor;
  created_at: string;
  last_at: string;
  last_author: InboxAuthor["kind"];
  message_count: number;
  resolved_at: string | null;
  questions: InboxQuestionSummary;
  /** The last message is an agent's and the thread is open: it waits on the person. */
  waiting_on_person: boolean;
}

/** The list's sections, in the approved order (Workspaces' inbox model). */
export type InboxSectionId = "stopped" | "holding" | "waiting" | "sent" | "new" | "quiet";

export const INBOX_SECTIONS: readonly { readonly id: InboxSectionId; readonly label: string }[] = [
  { id: "stopped", label: "Stopped on you" },
  { id: "holding", label: "Holding up work" },
  { id: "waiting", label: "Waiting on you" },
  { id: "sent", label: "Sent" },
  { id: "new", label: "New since you looked" },
  { id: "quiet", label: "Quiet" },
];

/**
 * One row of the list: a thread (owner ruling 2026-10-07, "a row is a
 * thread"), with its project as a label and a filter, placed in its section.
 */
export interface InboxListRow extends InboxThreadSummary {
  project: { id: string; name: string };
  /** The thread's name (send_message's `thread`), or null for a session's default thread. */
  thread_name: string | null;
  section: InboxSectionId;
  /** Waiting on the person or new to them: drawn bold. */
  unread: boolean;
  /** No question is open, some are picked and not sent: it waits only for Send. */
  answered_not_sent: boolean;
  /** When the oldest open question was asked, or null when none is open. */
  waiting_since: string | null;
  /** Agent messages after the person's last look (a reply of theirs counts as a look). */
  unseen: number;
  /** The person's reply is the last message: when, and when the agent read it (null until it has). */
  sent: { at: string; checked_at: string | null } | null;
}

export interface InboxListSection {
  id: InboxSectionId;
  label: string;
  threads: InboxListRow[];
}

export interface InboxThread {
  thread_id: string;
  project: InboxProject;
  subject: string | null;
  /** The thread's name, or null for a session's default thread. */
  thread_name: string | null;
  resolved_at: string | null;
  messages: InboxMessageWire[];
}

// ─────────────────────────────── Decisions ───────────────────────────────

/**
 * A decision's lifecycle (Workspaces' `project_decisions.state`): current
 * holds; replaced points at its replacement; retired no longer holds.
 */
export type InboxDecisionState = "current" | "replaced" | "retired";

export interface InboxDecisionAgent {
  host: string | null;
  session: string | null;
  name: string | null;
}

/** Where a decision came from. */
export interface InboxDecisionSource {
  /**
   * `answer`: recorded at Send from the person's answer to a question;
   * `agent`: an agent's record_decision; `person`: the person wrote it (a
   * replacement on the Decisions page).
   */
  kind: "answer" | "agent" | "person";
  /** The answered question (`<message id>/<key>`), for `answer`. */
  question_id: string | null;
  message_id: string | null;
  thread_id: string | null;
  /** The asking agent (`answer`) or the recording one (`agent`). */
  agent: InboxDecisionAgent | null;
}

/**
 * One standing decision in a project: Workspaces' decision fields (text,
 * reason, source, state, version, replaces_id, replacement_id), so a later
 * sync maps it. `version` counts changes to this record (a retire or a
 * replace bumps it; a stale version is refused); a replacement is a new
 * record at version 1 that names what it replaces.
 */
export interface InboxDecision {
  id: string;
  project_id: string;
  text: string;
  reason: string | null;
  source: InboxDecisionSource;
  state: InboxDecisionState;
  version: number;
  replaces_id: string | null;
  replacement_id: string | null;
  created_at: string;
  /** When the state last changed (a retire or a replace); null while it was never changed. */
  changed_at: string | null;
  /** record_decision's idempotency key, when one was given. */
  idempotency_key: string | null;
}

// ─────────────────────────────── Lines ───────────────────────────────

export type InboxRecordKind = "project" | "message" | "question" | "decision" | "annotation";

/** One line of the store: a full snapshot of one record. */
export type InboxLine =
  | { v: 1; seq: number; at: string; kind: "project"; id: string; record: InboxProject }
  | { v: 1; seq: number; at: string; kind: "message"; id: string; record: InboxMessage }
  | { v: 1; seq: number; at: string; kind: "question"; id: string; record: InboxQuestionRecord }
  | { v: 1; seq: number; at: string; kind: "decision"; id: string; record: InboxDecision }
  | { v: 1; seq: number; at: string; kind: "annotation"; id: string; record: InboxAnnotationRecord };

// ─────────────────────────────── Health ───────────────────────────────

export const INBOX_APP_ID = "plannotator-inbox";

export interface InboxHealth {
  ok: true;
  app: typeof INBOX_APP_ID;
  /** The running binary's version, or `dev` for a source run. */
  version: string;
  serverSession: string;
  pid: number;
  /** Set when the binary on disk reports a different version: restart to update. */
  update: { available: true; version: string } | null;
}

export function isInboxHealth(value: unknown): value is InboxHealth {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.ok === true &&
    v.app === INBOX_APP_ID &&
    typeof v.version === "string" &&
    typeof v.serverSession === "string" &&
    typeof v.pid === "number"
  );
}
