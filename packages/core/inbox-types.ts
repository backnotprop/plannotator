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

export type InboxIdPrefix = "msg" | "prj" | "ses";

export function inboxId(prefix: InboxIdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

const ID_RE: Record<InboxIdPrefix, RegExp> = {
  msg: /^msg_[0-9A-HJKMNP-TV-Z]{26}$/,
  prj: /^prj_[0-9A-HJKMNP-TV-Z]{26}$/,
  ses: /^ses_[0-9A-HJKMNP-TV-Z]{26}$/,
};

export function isInboxId(prefix: InboxIdPrefix, value: unknown): value is string {
  return typeof value === "string" && ID_RE[prefix].test(value);
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

export interface InboxThread {
  thread_id: string;
  project: InboxProject;
  subject: string | null;
  resolved_at: string | null;
  messages: InboxMessageWire[];
}

// ─────────────────────────────── Lines ───────────────────────────────

export type InboxRecordKind = "project" | "message" | "question";

/** One line of the store: a full snapshot of one record. */
export type InboxLine =
  | { v: 1; seq: number; at: string; kind: "project"; id: string; record: InboxProject }
  | { v: 1; seq: number; at: string; kind: "message"; id: string; record: InboxMessage }
  | { v: 1; seq: number; at: string; kind: "question"; id: string; record: InboxQuestionRecord };

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
