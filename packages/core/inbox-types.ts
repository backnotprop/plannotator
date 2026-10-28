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
import type { InboxAnnotationRecord, InboxAttachment, InboxAttachmentKind, InboxInlineImage } from "./inbox-attachments";
import type { InboxDeliverNowBy, InboxRowDelivery } from "./inbox-delivery";
import type { InboxRowRun } from "./inbox-acp";
import type { InboxCard } from "./inbox-cards";
import { INBOX_CODEX_QUEUE_MIN_VERSION } from "./inbox-codex";
import { INBOX_QWEN_WAKE_MIN_VERSION } from "./inbox-qwen";

// The attachment shapes and file rules (step 2) live in their own module and
// reach the Inbox through this published entry, so core's export map is unchanged.
export * from "./inbox-attachments";
export * from "./inbox-open-in";
export * from "./inbox-delivery";
export * from "./inbox-codex";
export * from "./inbox-qwen";
// The Board's cards (approval "inbox-board"), the same way.
export * from "./inbox-cards";
// The surface bridge's messages (the phone, PLAN step S1), the same way.
export * from "./inbox-surface-bridge";

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

/** `upl`: a file the person uploaded for a message; `drf`: a draft of one (compose); `crd`: a Board card. */
export type InboxIdPrefix = "msg" | "prj" | "ses" | "dec" | "dev" | "upl" | "drf" | "crd" | "run";

export function inboxId(prefix: InboxIdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

const ID_RE: Record<InboxIdPrefix, RegExp> = {
  msg: /^msg_[0-9A-HJKMNP-TV-Z]{26}$/,
  prj: /^prj_[0-9A-HJKMNP-TV-Z]{26}$/,
  ses: /^ses_[0-9A-HJKMNP-TV-Z]{26}$/,
  dec: /^dec_[0-9A-HJKMNP-TV-Z]{26}$/,
  /** A paired phone (adr/implementation/inbox-mobile.md, section 2). */
  dev: /^dev_[0-9A-HJKMNP-TV-Z]{26}$/,
  upl: /^upl_[0-9A-HJKMNP-TV-Z]{26}$/,
  drf: /^drf_[0-9A-HJKMNP-TV-Z]{26}$/,
  /** A Board card (approval "inbox-board"). */
  crd: /^crd_[0-9A-HJKMNP-TV-Z]{26}$/,
  /** A session the Inbox runs itself over ACP (packages/server/inbox-acp-runner.ts): its agent session id. */
  run: /^run_[0-9A-HJKMNP-TV-Z]{26}$/,
};

export function isInboxId(prefix: InboxIdPrefix, value: unknown): value is string {
  return typeof value === "string" && ID_RE[prefix].test(value);
}

// ─────────────────────────────── Thread names ───────────────────────────────

/** The longest `thread` name send_message takes, in characters. */
export const INBOX_THREAD_NAME_MAX = 120;

export const THREAD_NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/**
 * Bidi controls (LRE..RLO, LRI..PDI, LRM, RLM, ALM) reorder the text around
 * them, so a name holding one can draw as another name in the list.
 */
export const THREAD_NAME_BIDI = /\p{Bidi_Control}/u;
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

// ─────────────────────────────── Subjects ───────────────────────────────

/** A line break in any spelling: CR, LF, U+2028, U+2029. */
const SUBJECT_LINE_BREAK = /[\r\n\u2028\u2029]/;
/**
 * Text a model's malformed tool call can leak into a string argument: the
 * closing tag of the field, the next parameter, an invoke block, or an
 * `antml:`-prefixed tag. Narrow on purpose, so `a < b`, `Vec<T>` and `<div>`
 * in prose stay allowed.
 */
const SUBJECT_TOOL_MARKUP =
  /<\/subject\s*>|<\/parameter\s*>|<parameter\s+name\s*=|<invoke\s+name\s*=|<\/invoke\s*>|<\/?function_calls\s*>|<\/?antml:/i;

/**
 * A `subject` as an agent sends it (send_message, submit_guide): one line of
 * plain text. Empty (or only spaces) means none, as before; the value is
 * trimmed and otherwise kept. Refused, with one sentence the agent can act
 * on: leaked tool-call markup (`</subject>`, `<parameter name=…>`), a line
 * break, other control characters, bidi controls.
 */
export function checkInboxSubject(value: unknown): { ok: true; subject: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, subject: null };
  if (typeof value !== "string") return { ok: false, message: "must be a string." };
  const subject = value.trim();
  if (subject === "") return { ok: true, subject: null };
  if (SUBJECT_TOOL_MARKUP.test(subject)) {
    return {
      ok: false,
      message:
        "contains tool-call text (such as </subject> or <parameter name=…>), so your call was malformed. Send again with the subject alone as its value and every other field as its own argument. If you meant to write that text, reword it without the angle brackets.",
    };
  }
  if (SUBJECT_LINE_BREAK.test(subject)) {
    return { ok: false, message: "must be one line; it contains a line break. Send a short one-line subject; put the rest in body." };
  }
  if (THREAD_NAME_CONTROL.test(subject)) return { ok: false, message: "must not contain control characters." };
  if (THREAD_NAME_BIDI.test(subject)) return { ok: false, message: "must not contain bidirectional control characters." };
  return { ok: true, subject };
}

/**
 * A stored subject as it is shown and served: its first line, cut where
 * leaked tool-call markup starts, without control or bidi characters,
 * trimmed; null when nothing is left. Subjects stored before the send-side
 * check (`checkInboxSubject`) can hold such text; the append-only store is
 * never rewritten, so every read goes through this instead.
 */
export function displayInboxSubject(subject: string | null | undefined): string | null {
  if (typeof subject !== "string") return null;
  let text = subject.split(SUBJECT_LINE_BREAK, 1)[0] ?? "";
  const markup = SUBJECT_TOOL_MARKUP.exec(text);
  if (markup) text = text.slice(0, markup.index);
  text = text
    .replace(new RegExp(THREAD_NAME_BIDI.source, "gu"), "")
    .replace(new RegExp(THREAD_NAME_CONTROL.source, "g"), " ")
    .trim();
  return text === "" ? null : text;
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

/**
 * The repository a project's git `origin` names (#1840): its path on the
 * forge (`owner/repo`, or a GitLab `group/sub/project`) and the remote's host,
 * null when the host did not parse. The window links bare `#123` refs with it.
 */
export interface InboxProjectRepo {
  display: string;
  host: string | null;
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
/**
 * One of the Inbox's own notes to the asking agent: Mark read's set-aside
 * note (`set_aside`), a late Undo's reopened note (`reopened`), or the note
 * that carries a 👍 Looks good to the agent (`ack_of`). They are stored as
 * the person's messages so they reach the agent like any reply, but they are
 * not the person's reply and not a look: the list's `sent`, `unseen`, the
 * look boundary and "came back" all read past them.
 */
export function isInboxNote(message: {
  author: { kind: string };
  set_aside?: readonly string[] | null;
  reopened?: readonly string[] | null;
  ack_of?: string | null;
}): boolean {
  return (
    message.author.kind === "person" &&
    ((message.set_aside?.length ?? 0) > 0 || (message.reopened?.length ?? 0) > 0 || (typeof message.ack_of === "string" && message.ack_of !== ""))
  );
}

/**
 * The reply the Inbox writes for the person's Done / Can't do it on an action item
 * (`action_report`, approval "inbox-next-actions"), once its Undo window
 * passed. It is the person's reply for delivery (Sent, the wake, Send now),
 * but not a look: it is written by the Inbox seconds after the click, so an
 * agent message that landed meanwhile stays new.
 */
export function isInboxActionReport(message: { author: { kind: string }; action_report?: readonly string[] | null }): boolean {
  return message.author.kind === "person" && (message.action_report?.length ?? 0) > 0;
}

export const INBOX_HOST_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  pi: "Pi",
  opencode: "OpenCode",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok Build",
  qwen: "Qwen Code",
};

/**
 * The agent hosts a person's reply wakes as a new turn by itself: Claude Code,
 * Pi and OpenCode 2 through Plannotator's own connection (OpenCode 1 has the
 * tool but no wake), and Codex through MCP alone, where the Inbox puts the
 * reply into the Codex thread with `codex queue` (Codex CLI
 * INBOX_CODEX_QUEUE_MIN_VERSION or later; packages/server/inbox-codex-wake.ts),
 * and Qwen Code through MCP alone, where the Inbox sends the reply into the
 * running session over Qwen's cross-session messaging (Qwen Code
 * INBOX_QWEN_WAKE_MIN_VERSION or later, macOS and Linux;
 * packages/server/inbox-qwen-wake.ts).
 * The one list: wording that names which agents a reply wakes reads it.
 */
export const INBOX_WAKING_HOSTS = ["claude-code", "pi", "opencode", "codex", "qwen"] as const;

/** Of INBOX_WAKING_HOSTS, the ones an MCP connection alone wakes (no Plannotator plugin): Codex and Qwen Code. */
export const INBOX_MCP_WAKING_HOSTS: readonly string[] = ["codex", "qwen"];

/** The first version of each agent MCP alone wakes that can be woken. */
export const INBOX_MCP_WAKE_MIN_VERSIONS: Readonly<Record<string, string>> = { codex: INBOX_CODEX_QUEUE_MIN_VERSION, qwen: INBOX_QWEN_WAKE_MIN_VERSION };

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
   * On a root: the person's Mark read, the event-log seq when they pressed it
   * and when. While no message but a set-aside note (`set_aside`) came after
   * it, the thread sits in Quiet without being closed; any other message
   * (an agent's, or the person's own reply) ends it without a write. Null
   * after Undo. Absent on records older than Mark read.
   */
  person_read_seq?: number | null;
  person_read_at?: string | null;
  /** On a root marked read: `person_seen_seq` before the Mark read (which counts as a look), for its Undo. */
  person_seen_before_read?: number | null;
  /**
   * On a person's set-aside note: the questions (`<message id>/<key>`) a
   * Mark read told the asking agent not to wait on. Written once per
   * question, after the Undo window, as a reply to the message that asked.
   * Absent on every other message.
   */
  set_aside?: string[];
  /**
   * On a person's reopened note: the questions an Undo of Mark read opened
   * again after a set-aside note had named them. Absent on every other message.
   */
  reopened?: string[];
  /**
   * On the note that carries a 👍 Looks good to the agent (amended
   * 2026-10-16): the agent message the person marked. Written once the
   * ack's Undo window passed (its body is `inboxAckLine`), as a reply to
   * that message, and delivered like any reply (the wake, wait_for_reply's
   * `acknowledged`) while the ack still names it (`InboxAck.note_id`). The
   * window and read_thread do not list it: the ack on the message says it.
   * Absent on every other message.
   */
  ack_of?: string;
  /**
   * On the person's Re-ask note (approval "inbox-reask"): the open questions
   * (`<message id>/<key>`) it asked the agent to ask again, together in one
   * new message, with `Replaces:` lines for those still needed. It is the
   * person's reply (never an Inbox note): delivered like one, and while it is
   * the thread's last message the row sits in Sent. Picks the person had made
   * but not sent go with it as answers. Absent on every other message.
   */
  reask?: string[];
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
   * On an agent's message: the images its body shows, captured as files of
   * the thread (`InboxInlineImage`), in the order the body shows them. Written
   * when the message lands, or, for a message sent before images were
   * captured, the first time its thread is read (each record then marked
   * `captured: "on_open"`). Present (possibly empty) once capture ran; absent
   * on a message whose body shows no local image, and on older records.
   */
  inline_images?: InboxInlineImage[];
  /**
   * On a person's reply: it reached the asking agent's session as a turn
   * through an agent connection (the Claude Code mod), and when. Absent until
   * then; a reply the agent read through the MCP has none. "Replied" is not
   * stored: it is the asking session's next message in the thread. Added in
   * step 6: older records lack it.
   */
  delivery?: InboxDelivery | null;
  /**
   * On a person's reply or message not yet delivered: the person pressed
   * Send now in the Inbox, and when. The session's connection then delivers
   * it at once, into the running turn when one runs, instead of waiting for
   * the session to go idle (the bridge command's `now`). Absent otherwise
   * and on older records.
   */
  deliver_now_at?: string | null;
  /**
   * Who asked for `deliver_now_at`: the person (Send now) or the Inbox after
   * the item waited `INBOX_AUTO_SEND_AFTER_MS` on a busy session whose
   * connection can take it mid-turn (approval "inbox-busy-agent-reply").
   * Kept when a failed attempt clears `deliver_now_at`, so the Inbox never
   * tries by itself twice. Absent on older records (a person's Send now).
   */
  deliver_now_by?: InboxDeliverNowBy | null;
  /**
   * When it began to wait on its busy session, written with the Inbox's own
   * mark (`deliver_now_by: "auto"`), so "went into its turn by itself after
   * N min" stays true after delivery. Absent otherwise. Additive.
   */
  wait_started_at?: string | null;
  /**
   * A guided review this message carries (submit_guide, PLAN step 5): the
   * snapshot is a content-addressed blob, `inbox/blobs/<sha256>`. Absent on
   * every other message and on records older than step 5.
   */
  guide?: InboxGuideRef | null;
  /**
   * On a message carrying a guide: the person's reviewed tick per section, as
   * the window's guide viewer last saved it (the record's 4.2, "kept with the
   * thread"). Absent until the first tick; the snapshot's own ticks apply then.
   */
  guide_reviewed?: boolean[] | null;
  /**
   * On a person's New message (plan step 8): the live agent session it is
   * addressed to. Such a message answers nothing (`reply_to` null) and is
   * delivered to that session as a turn, like a reply. Also on a person's
   * reply (`reply_to` set) when the session that asked had ended and the
   * person chose another live session to take it: that session alone is
   * handed it. Absent on every other message and on records older than step 8.
   */
  to?: InboxAddressee | null;
  /**
   * On an agent's message: the realpath of the `project_path` it was sent
   * from, when that is a folder inside the project other than its root.
   * Relative image paths in the body start there (#1813); absent, they start
   * at the project root. Added after step 8: older records lack it.
   */
  base_path?: string | null;
  /**
   * On an agent's message: it was sent through a connection that wakes its
   * session with the person's reply (the Claude Code mod, Pi, OpenCode 2;
   * `INBOX_WAKES_META_KEY`). Only such a session can be said to have ended
   * when it stops polling; an MCP-only agent or OpenCode 1 never polls, so
   * the window never calls it ended. Absent otherwise and on older records.
   */
  wakes?: boolean;
  /**
   * On an agent's message: the earlier questions it said it supersedes
   * (send_message's `supersedes`, as sent: `<message id>` for every open
   * question of that message, or `<message id>/<key>` for one). The question
   * records carry the result (`InboxQuestionRecord.superseded_by`); this is
   * what the agent asked for, so a retry with another list is refused. Absent
   * when it superseded nothing through the argument (a `Replaces:` line rides
   * the body). Added for replaced questions: older records lack it.
   */
  supersedes?: string[];
  /**
   * On an agent's message: the action items it said it saw done (send_message's
   * `done`, as sent: `<message id>` for every open action item of that message, or
   * `<message id>/<key>` for one). The action item records carry the result
   * (`action_result` with `by: "agent"`). Absent otherwise and on older records.
   */
  done?: string[];
  /**
   * On a person's reply that reports action items (Done, Can't do it): the action items
   * it reports (`<message id>/<key>`), sent once the Undo window passed.
   * Absent on every other message.
   */
  action_report?: string[];
  /**
   * On a thread's root whose subject the agent did not give: the question
   * (`<message id>/<key>`) the subject was derived from, so the thread's
   * subject follows that question's `superseded_by` chain. Null when the
   * subject was the agent's own or came from the body's first line (it never
   * changes). Absent on records older than replaced questions: then a subject
   * equal to the root's first question's prompt counts as derived from it.
   */
  subject_question?: string | null;
  /**
   * On a thread's root the person wrote (compose: "send a new message to a
   * connected agent"): the thread was started by the person, addressed to
   * one live agent session (`to`), and is no session's default thread. The
   * agent's answer lands in it by `reply_to`. Absent on every other message.
   */
  started_by_person?: true;
  /**
   * On the root of a thread the person started with compose's Board chip on
   * (approval "inbox-compose-board-chip", 2026-10-27): the person asked the
   * agent to track the work on the Board. The body stays as typed; what the
   * agent receives for this message (the delivered turn, wait_for_reply,
   * read_thread) carries `inboxBoardRequestBlock` after it. Absent on every
   * other message.
   */
  board_request?: true;
  /**
   * On the root of a thread the person started: who gave it its name, the
   * thread chip (approval "inbox-agent-names-own-thread"). The person may name
   * it in compose; otherwise the first reply from a session that may name it
   * (`InboxStore.canNameThread`) carrying a valid `thread` names it, once, and
   * the root is written again with the name and this field. Absent while the
   * thread has no name, and on every other message. A name set here is never
   * replaced, except compose's suggestion (`kind: "auto"`), which the first
   * agent that may name the thread replaces.
   */
  named_by?: InboxThreadNamedBy;
  /**
   * On an agent's reply: the `thread` it carried, as given (trimmed), so a
   * retry with the same idempotency key and another `thread` is told apart.
   * Absent when it carried none, and on every other message.
   */
  reply_thread?: string;
  /**
   * On an agent's reply into a thread the person started that it could name:
   * what the naming came to (`InboxThreadNaming`), so a retry answers the
   * same. Absent everywhere else.
   */
  thread_naming?: InboxThreadNaming;
  /**
   * On an agent's message: the person's 👍 Looks good (design record
   * "inbox-acknowledge", approved 2026-10-15, amended 2026-10-16). The thread
   * is marked read; once the Undo window passes the Inbox sends it to the
   * agent (a note, `note_id`), delivered like a reply. Null after Undo.
   * Absent on every other message and on older records.
   */
  ack?: InboxAck | null;
  /**
   * On a person's reply: the agent sessions they tagged with `@` (approval
   * "inbox-tag-agents", Lines variant), in the order typed, never the session
   * the reply goes to anyway (its owner, `InboxStore.recipientOf`). ONE
   * message, handed to its owner and to every tagged session; each records
   * its own delivery in its entry, so each gets its own line and Send now.
   * A message with tags is settled for each recipient only by that
   * recipient's own delivery or its own wait_for_reply, never by another
   * agent's read. Absent on every other message and on older records.
   */
  tags?: InboxTag[];
}

/**
 * One agent session a person's reply tags (`InboxMessage.tags`). The last
 * line of the message wins, as for every record: a delivery, a Send now and
 * a read are new snapshots of the whole message.
 */
export interface InboxTag {
  /** The connection's host (`claude-code`, `pi`); null for an MCP agent that never named one. */
  host: string | null;
  session: string;
  /** The name an MCP agent gave itself, for the person's view only; null otherwise. */
  name?: string | null;
  /**
   * The readable label the person picked, as it reads in their text after
   * `@` ("Pi", "Claude Code (another session)"): the sent message paints that
   * token and names the session's line with it. Absent from an older window.
   */
  label?: string | null;
  /**
   * Its connection wakes it (the Claude Code mod, Pi, OpenCode 2, with the
   * tag capability): the reply arrives as a turn. False: an agent that reads
   * the Inbox only (MCP, OpenCode 1); it sees the tag the next time it reads
   * the thread or waits for a reply.
   */
  wakes: boolean;
  /** It reached the session (its connection delivered it, or its own wait_for_reply returned it). */
  delivery?: InboxDelivery | null;
  /** The person pressed Send now for this session (or the Inbox did, after the wait: `deliver_now_by`). */
  deliver_now_at?: string | null;
  /** Who asked for `deliver_now_at` (see `InboxMessage.deliver_now_by`). */
  deliver_now_by?: InboxDeliverNowBy | null;
  /** When it began to wait on that session (see `InboxMessage.wait_started_at`). */
  wait_started_at?: string | null;
  /** A session that is not woken read the thread with read_thread after the tag (its own read only). */
  read_at?: string | null;
}

/** The most sessions one reply may tag. */
export const INBOX_TAGS_MAX = 8;

/**
 * Who a person's last message went to, for the Sent row (`InboxListRow.sent.recipients`):
 * the owner first, then the tagged sessions in the order typed.
 */
export interface InboxSentRecipient {
  host: string | null;
  session: string;
  name?: string | null;
  owner: boolean;
  wakes: boolean;
  /** It reached the session; null while it waits. */
  delivered_at: string | null;
}

/**
 * Who a thread involves, for the overlapping marks on the row and the thread
 * head: the distinct agent sessions that wrote in it or were tagged in it,
 * the thread's first agent first. `name` is an MCP agent's own name.
 */
export interface InboxParticipant {
  host: string | null;
  session: string;
  name?: string | null;
}

/**
 * Who named a thread the person started (`InboxMessage.named_by`): the person
 * in compose (`thread_name` on the Send), compose's own suggestion the person
 * left as it was (`thread_name_auto: true`), or the agent whose reply named it.
 */
export type InboxThreadNamedBy =
  | { kind: "person"; at: string }
  /**
   * The name compose suggested from the message (`suggestPersonThreadName`)
   * and the person sent without editing it: shown like any name, but the
   * first agent that may name the thread (`InboxStore.canNameThread`) still
   * replaces it, once.
   */
  | { kind: "auto"; at: string }
  | {
      kind: "agent";
      host: string | null;
      session: string;
      /** The reply that carried the name. */
      message_id: string;
      at: string;
    };

/**
 * What a reply's naming of a thread the person started came to (approval
 * "inbox-agent-names-own-thread"), kept on the reply so a retry answers the
 * same: `named` (the thread's `thread_name` is now `name`); `refused`, with a
 * code (`invalid_thread_name`, or `thread_name_taken` when another open
 * thread of the project already has the name) and one sentence saying why;
 * `unnamed` when the reply gave no `thread`.
 */
export type InboxThreadNaming =
  | { status: "named"; name: string }
  | { status: "refused"; code: "invalid_thread_name" | "thread_name_taken"; reason: string }
  | { status: "unnamed" };

/**
 * The one line an agent is handed while a thread the person started still
 * has no name an agent gave and that agent may name it: in `wait_for_reply`
 * and `read_thread` beside `name_this_thread: true`. The wake of the thread
 * (INBOX_NAME_THREAD_LINE in shared/inbox/connection.ts) carries the same ask.
 */
export const INBOX_NAME_THIS_THREAD_HINT =
  "Name this thread: pass `thread` (a few words saying what it is about) with your reply. The first name you give sets it, once.";

/** The one acknowledgment the window offers (plan review's 👍 says the same words). */
export const INBOX_ACK_LABEL = "Looks good";

/**
 * The person's 👍 on an agent message (`InboxMessage.ack`). The last line
 * wins, as for every record: settling and the agent's read are new snapshot
 * lines of the same message.
 */
export interface InboxAck {
  label: string;
  at: string;
  /** The Mark read this ack stands on (the root's `person_read_seq`): Move back on that read withdraws the ack. */
  read_seq: number | null;
  /** This ack made that Mark read (the thread was not read before), so its Undo undoes the read too. */
  made_read?: boolean;
  /**
   * Set once the Undo window passed with the ack standing (the seq of that
   * line, and when): agents see it from then on (read_thread, and
   * wait_for_reply's `acknowledged`). Null before.
   */
  settled_seq?: number | null;
  settled_at?: string | null;
  /**
   * The note that carries this 👍 to the agent (`InboxMessage.ack_of`),
   * written when it settled. The note is delivered only while the ack still
   * names it, so a 👍 taken back before its delivery never arrives. Absent on
   * acks settled before the amendment (they were never sent).
   */
  note_id?: string | null;
  /**
   * Set when the Undo window ended but the 👍 could no longer go: the person
   * wrote back after the message (`replied`) or the agent wrote again
   * (`wrote_again`) inside the window. No note is written and no agent sees
   * it; the window says it was not sent. Absent on every other ack.
   */
  not_sent?: "replied" | "wrote_again" | null;
  /** When an agent read it (read_thread, or wait_for_reply returned it). Null until then. */
  seen_at?: string | null;
  /**
   * The window's thread only (`GET /api/inbox/threads/:id`): when the 👍
   * reached the agent (its note delivered as a turn, or an agent read it),
   * else null. Never stored.
   */
  delivered_at?: string | null;
  /**
   * The window's thread only: its note's `created_at`, `deliver_now_at` and
   * `deliver_now_by` (a 👍 that waited on a busy session goes into the
   * running turn by itself after `INBOX_AUTO_SEND_AFTER_MS`). Never stored.
   */
  note_at?: string | null;
  deliver_now_at?: string | null;
  deliver_now_by?: InboxDeliverNowBy | null;
  /** The note's `wait_started_at` and its delivery's `into_turn` (the window's thread only). */
  wait_started_at?: string | null;
  delivered_into_turn?: boolean | null;
}

/**
 * What superseded a question (`InboxQuestionRecord.superseded_by`): the
 * agent's later message, and the question in it that replaces this one, or
 * null when that message asks nothing in its place ("No longer applies").
 */
export interface InboxSupersededBy {
  message_id: string;
  key: string | null;
}

/** The agent session a person's New message is addressed to (`InboxMessage.to`). */
export interface InboxAddressee {
  /** The connection's host, e.g. `claude-code`. */
  host: string;
  session: string;
}

/** How a person's reply or New message reached an agent session (`InboxMessage.delivery`). */
export interface InboxDelivery {
  state: "delivered";
  /** The connection's host, e.g. `claude-code`. */
  host: string;
  /** The session it was delivered to (the asking message's `author.session`, or the message's `to.session`). */
  session: string;
  at: string;
  /**
   * Written for an item the Inbox marked to go in by itself (approval
   * "inbox-busy-agent-reply"): true when it went into a running turn, false
   * when its session went idle after the mark (the session's own Ask question
   * held the turn, so it went in when the turn ended). Absent otherwise.
   */
  into_turn?: boolean;
}

// ─────────────────────────────── Guided reviews (step 5) ───────────────────────────────

/**
 * What a message keeps about the guided review it carries: the blob holding
 * the snapshot (Plannotator's portable format, `@plannotator/core/guide-format`,
 * exactly as validated) and the facts the card and the row draw.
 */
export interface InboxGuideRef {
  /** sha256 (hex) of the snapshot JSON, the blob's name under `inbox/blobs/`. */
  sha256: string;
  /**
   * sha256 (hex) of what the agent sent (the guide and the patch, or the
   * snapshot, as given). A retry with the same idempotency_key compares this:
   * the built snapshot carries the time it was built, so its own hash differs.
   */
  input_sha256: string;
  /** The snapshot JSON's size in bytes. */
  bytes: number;
  title: string;
  sections: number;
  /** Files in the patch. */
  files: number;
  additions: number;
  deletions: number;
}

/** One choice as the wire serves it (Workspaces' `QuestionChoice`). */
export interface InboxQuestionChoice {
  label: string;
  description: string | null;
  recommended: boolean;
  settled: boolean;
  /**
   * A picture choice (`- [ ] Label — ![alt](path)`): the image, its src as
   * the body writes it (the message image route and the captured
   * `inline_images` take that same src). Present only on a picture choice;
   * absent from records written before picture choices.
   */
  image?: { alt: string; src: string };
}

/**
 * The optional contract lines of a question block (approval
 * "inbox-decision-mode", agent contract lines): read at send time, kept on
 * the record and served with the question. Each is present only when the
 * block carries it; absent from older records.
 */
export interface InboxQuestionContract {
  /** `Stakes:` — what the choice affects. */
  stakes?: string;
  /** `Shows:` — the one picture (`image`) or file (`link`) the decision is about, its src as written. */
  shows?: { kind: "image" | "link"; label: string; src: string };
  /** `Why:` — why the recommendation. */
  why?: string;
  /** `Reversible: no — <why>`: the answer cannot be taken back. Absent means reversible. */
  reversible?: { value: false; why: string | null };
}

/** The parsed facts of a question block, kept on its record. */
export interface InboxQuestionFacts extends InboxQuestionContract {
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

/**
 * The stored question: one per question block of an agent's message.
 * Records written before Decisions were removed (2026-10) also carry
 * `decision_on_answer`, `decision_id`, `decision_recording` and
 * `decision_draft`; nothing reads them.
 */
export interface InboxQuestionRecord {
  /** `<message id>/<question key>`. */
  id: string;
  project_id: string;
  message_id: string;
  key: string;
  /**
   * The block's place among the message's blocks of its kind: questions are
   * numbered Q1, Q2… and action items (`kind: "action"`) A1, A2… separately.
   */
  position: number;
  /**
   * The question's kind, or `"action"` for an action item (an Inbox-only `:::action`
   * block: something only the person can go and do). Read it through
   * `readInboxQuestionKind`: a kind a reader does not know is not answerable.
   */
  kind: InboxQuestionKind;
  /** The question's prompt, or an action item's first line (what to do). */
  prompt: string;
  parsed: InboxQuestionFacts;
  stopped: string | null;
  holds_up: string[];
  asked_by_agent_id: string | null;
  answer: QuestionAnswer | null;
  revision: number;
  sent_revision: number;
  picked_by: InboxPicker | null;
  picked_at: string | null;
  sent_reply_id: string | null;
  /**
   * The agent superseded this question with a later message (send_message's
   * `supersedes`, or a `Replaces:` line in a newer block): it can no longer
   * be answered, and a pick saved on it is never sent. Absent or null while
   * it stands. Added for replaced questions: older records lack it.
   */
  superseded_by?: InboxSupersededBy | null;
  /**
   * The person's Mark read closed this question unanswered: it reads as
   * `closed` with a skip for its answer. `previous`
   * is the question as it was (a saved pick included), which Undo puts back.
   * Absent or null while it stands. Added for Mark read: older records lack it.
   */
  set_aside?: InboxQuestionSetAside | null;
  /**
   * On an action item (`kind: "action"`): where to do it, the command to run, and
   * what the agent watches for. Absent on a question and on older records.
   */
  action?: InboxActionFacts | null;
  /**
   * On an action item: what came of it. The person's Done or Can't do it (`by:
   * "person"`), sent with their reply when `staged` (the window; approval
   * "inbox-action-items-in-reply"), else once the Undo window passes; then
   * `sent_revision === revision` and `sent_reply_id` names the reply. Or the
   * agent's own `done` (`by: "agent"`: it saw it happen; nothing is sent by
   * it), with the person's mark kept under `person` when it was waiting in
   * their draft (its note still goes with their Send). Null while the action
   * item is open, and after it is taken back.
   */
  action_result?: InboxActionResult | null;
}

/**
 * A question's kind as the Inbox stores it: Plannotator's question kinds,
 * plus `"action"` for an action item (approval "inbox-next-actions").
 */
export type InboxQuestionKind = QuestionKind | "action";

/** The kinds this build knows, for `readInboxQuestionKind`. */
const INBOX_QUESTION_KINDS: readonly InboxQuestionKind[] = ["single", "multi", "text", "action"];

/**
 * A question record's kind, read fail-closed: a kind this build does not
 * know (a newer Inbox's) reads as `"unknown"`, which no reader may answer or
 * pick; draw it read-only.
 */
export function readInboxQuestionKind(value: unknown): InboxQuestionKind | "unknown" {
  return typeof value === "string" && (INBOX_QUESTION_KINDS as readonly string[]).includes(value) ? (value as InboxQuestionKind) : "unknown";
}

/** An action item: a question record of kind `"action"`. */
export function isInboxAction(question: { kind: unknown }): boolean {
  return readInboxQuestionKind(question.kind) === "action";
}

/** What an action item's block says besides what to do and why (`InboxQuestionRecord.action`). */
export interface InboxActionFacts {
  /** `Where:` in words (a place, or the link's name), or null. */
  where: string | null;
  /** `Where:`'s link, http(s) only, or null: the card's "Open" button. */
  where_url: string | null;
  /** `Run:`, a command for the person to copy, or null. */
  run: string | null;
  /** `Watching:`, what the agent watches to notice it done by itself, or null. */
  watching: string | null;
}

/** What came of an action item (`InboxQuestionRecord.action_result`). */
export interface InboxActionResult {
  outcome: "done" | "cant";
  /** The person's note with Done, or the reason with Can't do it; null for none. */
  note: string | null;
  at: string;
  by: "person" | "agent";
  /** With `by: "agent"`: the agent's message whose `done` named it. */
  message_id?: string | null;
  /**
   * The person's Done or Can't do it waits in their reply draft and goes with
   * their next Send, never on a timer (approval "inbox-action-items-in-reply").
   * Absent: marked through the timed path (decision mode, the phone door, an
   * older window), sent once the Undo window passes.
   */
  staged?: boolean;
  /**
   * With `by: "agent"`: the person's staged mark the agent's `done` settled
   * (approval "inbox-action-items-in-reply", Q3). When it carries a note, the
   * note still goes with the person's next Send (`inboxActionInDraft`).
   */
  person?: { outcome: "done" | "cant"; note: string | null; at: string } | null;
}

/**
 * An action item whose result waits in the person's reply draft (approval
 * "inbox-action-items-in-reply"): their staged Done or Can't do it, not sent;
 * or, once the agent saw it done itself, the note they wrote on it, not sent.
 * The Send carries it (`actions`), under "Action items you asked for".
 */
export function inboxActionInDraft(
  q: { kind: string; state: InboxQuestionState; action_result?: InboxActionResult | null; revision: number; sent_revision: number },
): boolean {
  const result = q.action_result;
  if (q.kind !== "action" || !result) return false;
  if (result.by === "person") return result.staged === true && q.state === "picked";
  const note = result.person?.note?.trim() ?? "";
  return note !== "" && q.state === "closed" && !(q.revision > 0 && q.sent_revision === q.revision);
}

/** The person's own mark on an action item in their draft or sent: their staged mark, or the one the agent's done settled. */
export function inboxActionPersonMark(result: InboxActionResult | null | undefined): { outcome: "done" | "cant"; note: string | null; at: string } | null {
  if (!result) return null;
  if (result.by === "person") return { outcome: result.outcome, note: result.note, at: result.at };
  return result.person ?? null;
}

/** A question Mark read closed (`InboxQuestionRecord.set_aside`). */
export interface InboxQuestionSetAside {
  at: string;
  /**
   * The Mark read that closed it: the root's `person_read_seq` then. Undo
   * reopens only the questions its own Mark read closed (owner ruling
   * 2026-10-12); one an earlier Mark read closed stays closed. Absent on
   * records older than the ruling, which match by `at` (the Mark read's
   * `person_read_at`).
   */
  read_seq?: number;
  previous: Pick<InboxQuestionRecord, "answer" | "revision" | "sent_revision" | "picked_by" | "picked_at" | "action_result">;
}

/**
 * Derived, never stored. `superseded`: the agent replaced or withdrew the
 * question (`superseded_by`); it wins over `closed`, so a resolved thread's
 * card still says what replaced it. `closed`: the thread is archived, or the
 * person's Mark read closed the question (`set_aside_at`).
 */
export type InboxQuestionState = "open" | "picked" | "sent" | "closed" | "superseded";

/**
 * A question as the window and the agents read it: Workspaces' `Question`
 * exactly (`asked_by_checked_at` omitted, as Workspaces omits it outside its
 * two comment lists), plus the Inbox's `message_id`.
 */
export interface InboxQuestion extends InboxQuestionContract {
  key: string;
  position: number;
  /** `"action"` for an action item; read it with `readInboxQuestionKind` (fail-closed). */
  kind: InboxQuestionKind;
  prompt: string;
  context: string | null;
  choices: InboxQuestionChoice[];
  recommendation: string | null;
  suggested_text: string | null;
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
  message_id: string;
  /** What superseded it (`state: "superseded"`), or null. */
  superseded_by: InboxSupersededBy | null;
  /**
   * When the person's Mark read closed it unanswered (`state: "closed"`,
   * answer a skip), or null. Absent from an older Inbox.
   */
  set_aside_at?: string | null;
  /** On an action item (`kind: "action"`): where, run and watching. Absent on a question and from an older Inbox. */
  action?: InboxActionFacts | null;
  /** On an action item: what came of it, or null while open. Absent on a question and from an older Inbox. */
  action_result?: InboxActionResult | null;
}

/**
 * Decision mode (approval "inbox-decision-mode", experimental): one open or
 * picked question or action item, with what a card needs to be answered
 * without opening its thread. `GET /api/inbox/decisions` lists them; a
 * read-only projection over the store (no record of its own).
 */
export interface InboxDecision {
  /** `<message id>/<key>`. */
  id: string;
  /** The question as `GET /api/inbox/threads/:id` serves it (its `revision` is what a pick sends). */
  question: InboxQuestion;
  message: {
    id: string;
    created_at: string;
    author: InboxAuthor;
    /** The body's prose before its first block, cut to about 280 characters; null when there is none. */
    excerpt: string | null;
  };
  /**
   * Pictures and files the decision can show, as references only (bytes come
   * from the attachment and message-image routes): the message's captured
   * images whose `ref` the question names (its context, its choices), and the
   * message's attached files.
   */
  pictures: {
    inline: { attachment_id: string; ref: string; name: string; media_type: string | null; width: number | null; height: number | null }[];
    /** `paths` (additive): the file's real path, and the path it was named by when that was a link; a `Shows:` file is matched by them. */
    attachments: { attachment_id: string; name: string; kind: string; size: number; media_type: string | null; paths?: string[] }[];
  };
  /** `project.repo` (additive, the window's read): its git origin, as on a thread; refs in the card link into it. */
  thread: { id: string; subject: string | null; thread_name: string | null; project: { id: string; name: string; repo?: InboxProjectRepo | null }; section: InboxSectionId };
  /**
   * The agent session that asked: one reply per session per thread
   * (`key`: `s:<host>\u0000<session>`, or `m:<message id>` for a message with
   * no session, which is a reply of its own).
   */
  session: { key: string; host: string | null; session: string | null; name: string | null; wakes: boolean };
}

export interface InboxDecisionsModel {
  serverSession: string;
  cursor: number;
  /** In queue order: each session's decisions together, a thread at a time, the most blocked session first, Stopped first. */
  decisions: InboxDecision[];
}

/** Workspaces' `NotificationQuestionSummary`: a row's questions, summed. */
export interface InboxQuestionSummary {
  /** Open questions and action items together: an action item counts like a question for every list rule. */
  open: number;
  picked: number;
  stopped: boolean;
  holds_up: string[];
  prompt: string | null;
  /** How many of `open` are action items (`kind: "action"`): the row reads "1 action item". Absent from an older Inbox. */
  actions?: number;
  /**
   * Action items the person marked Done or Can't do it that wait in their
   * reply draft, the agent still stopped on them (approval
   * "inbox-action-items-in-reply", Q2): the row keeps its section by their
   * Stopped / Holds up (`stopped` and `holds_up` count them). Absent: none.
   */
  staged?: number;
}

export interface InboxMessageWire extends InboxMessage {
  /**
   * Omitted when the message asks no question (the Workspaces rule). The
   * server lists the message's action items (`kind: "action"`) here too, after its
   * questions; a reader that does not know `"action"` must not answer them.
   */
  questions?: InboxQuestion[];
  /**
   * Never sent by the server: the Inbox window moves a message's action items here
   * out of `questions` when it reads a thread (packages/inbox/actions.ts), so
   * nothing that picks and sends answers ever meets one.
   */
  actions?: InboxQuestion[];
  /**
   * The seq of the message's first line in the event log. Rides only on
   * `GET /api/inbox/threads/:id` (the window's thread), is never stored and
   * is not on the MCP tools: with the root's `person_seen_seq` it tells the
   * window which messages are new since the person's last look, read BEFORE
   * the window records the next look. Absent from an older Inbox.
   */
  seq?: number;
  /**
   * On a person's reply, on `GET /api/inbox/threads/:id` only: how many of
   * the person's annotations (on attached files or a guided review's diffs)
   * that reply carried. Absent from an older Inbox.
   */
  sent_annotations?: number;
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
  /**
   * The last message is an agent's and the thread is open: it waits on the
   * person. The Inbox's own notes (`isInboxNote`) are read past, and it is
   * false while a Mark read stands (nothing waits on the person then).
   */
  waiting_on_person: boolean;
}

/** The list's sections, in the approved order (Workspaces' inbox model). */
export type InboxSectionId = "stopped" | "holding" | "waiting" | "new" | "sent" | "quiet";

export const INBOX_SECTIONS: readonly { readonly id: InboxSectionId; readonly label: string }[] = [
  { id: "stopped", label: "Stopped on you" },
  { id: "holding", label: "Holding up work" },
  { id: "waiting", label: "Waiting on you" },
  { id: "new", label: "New since you looked" },
  // Sent waits on the agent, not on the person: below what is new to them.
  { id: "sent", label: "Sent" },
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
  /**
   * Waiting on the person or new to them: drawn bold. Not for a row in New only
   * for the person's own unsent words or comments (`unsent`).
   */
  unread: boolean;
  /** No question is open, some are picked and not sent: it waits only for Send. */
  answered_not_sent: boolean;
  /**
   * What the person has not sent in this thread yet (approval "inbox-reply-drafts"):
   * words typed in the reply box (`reply_at`, when they were last saved; null
   * when none), picks saved and not sent, and comments (on attached files, the
   * guided review or the messages) waiting for a Send. Null when nothing is
   * unsent. A thread holding any of it never sits in Quiet unless it is
   * archived. Additive: absent from an older Inbox.
   */
  unsent?: InboxRowUnsent | null;
  /** When the oldest open question was asked, or null when none is open. */
  waiting_since: string | null;
  /**
   * When the person pinned the thread to the sidebar (approval
   * "inbox-pinned-threads"), or null. Only on the list model the window and
   * the phone read (`GET /api/inbox/threads`), never on anything an agent
   * reads. Additive: absent from an older Inbox.
   */
  pinned_at?: string | null;
  /**
   * A session the Inbox runs over ACP works in this thread, or waits on a
   * permission (packages/server/inbox-acp-runner.ts). Only on the list model
   * the window and the phone read, never on anything an agent reads.
   * Additive: absent from an older Inbox.
   */
  run?: InboxRowRun | null;

  /**
   * Agent messages after the person's last look (a reply of theirs counts as
   * a look; the Inbox's own notes, `isInboxNote`, do not).
   */
  unseen: number;
  /**
   * The person's reply is the last message, the Inbox's own notes read past:
   * when, and when the agent read it (null until it has).
   */
  sent: {
    at: string;
    checked_at: string | null;
    /**
     * It goes to a session whose connection delivers it as a turn by itself
     * (the asking message came through a waking connection, or the person
     * addressed it to a live session): "Queued for <agent>", not "Saved for".
     * Absent from an older Inbox.
     */
    wakes?: boolean;
    /**
     * When the reply tags agents (`InboxMessage.tags`): every session it goes
     * to, the owner first, each with its own delivery ("1 of 3 delivered").
     * `checked_at` is then set once every recipient a connection wakes has
     * it. Absent otherwise and from an older Inbox.
     */
    recipients?: InboxSentRecipient[];
  } | null;
  /**
   * When more than one agent session is in the thread (it wrote there or the
   * person tagged it): all of them, the thread's first agent first, for the
   * overlapping marks. Absent with one session and from an older Inbox.
   */
  participants?: InboxParticipant[];
  /**
   * When the latest agent message arrived (`last_at` also moves on the
   * person's messages and the Inbox's notes). The window's held list counts
   * agent activity by it. Absent from an older Inbox.
   */
  last_agent_at?: string | null;
  /** A message in the thread carries a guided review: the row's "Guided review" mark. */
  guide: boolean;
  /**
   * On a thread the person started (`started_by_person`): the agent session
   * it is addressed to now (the root's `to`, which "Send to another session"
   * may change), so the row draws that agent's mark and "To <agent>". Absent
   * on every other thread and from an older Inbox.
   */
  addressee?: InboxAddressee | null;
  /**
   * When the person marked the thread read (Mark read), while it still holds:
   * no message but a set-aside note since. The row is Quiet. Null otherwise.
   * Absent from an older Inbox.
   */
  read_at?: string | null;
  /**
   * The person's 👍 on the latest agent message, while the Mark read it made
   * still holds: the row says "👍 Looks good" in place of "Read". Null
   * otherwise. Absent from an older Inbox.
   */
  ack?: { label: string; at: string } | null;
  /**
   * The thread is archived (resolved) and an agent wrote in it after the
   * archive line (a reply_to reply). Those later messages behave as an open
   * thread's (their questions live and answerable, a reply goes to them);
   * the thread stays resolved until the person acts. Derived from the log,
   * never stored. Absent from an older Inbox.
   */
  agent_after_archive?: boolean;
  /**
   * `agent_after_archive`, and something there still waits: an agent
   * message after the archive the person has not looked at, a live question
   * open or picked, or the person's reply after the archive the agent has not
   * read (not once a Mark read made after it stands: Mark read sends a
   * came-back thread back to the archive). The thread is back in the list,
   * placed as an open thread would be; once handled it returns to the archive
   * on its own. Derived. Absent from an older Inbox.
   */
  back_from_archive?: boolean;
  /**
   * The thread's last message (the Inbox's notes read past) is the person's
   * Re-ask note: the row sits in Sent until the agent asks again (owner's
   * rule, approval "inbox-reask"). Absent from an older Inbox.
   */
  reask_pending?: boolean;
  /**
   * Where the person's latest sent item in the thread is (approval
   * "inbox-row-delivery", "Ticks"): their reply or message when it is the
   * thread's last message (the Inbox's notes read past), else a 👍 Looks good
   * on the latest agent message once the Inbox sent it through. Computed with
   * the rule the thread's delivery line uses (`inboxDeliveryState`) from the
   * live sessions, so a row and its thread agree. Null when there is none (an
   * agent wrote last, a 👍 not sent). Absent from an older Inbox.
   */
  delivery?: InboxRowDelivery | null;
  /**
   * What the row's Stopped / Holds up badge holds (approval "inbox-row-badges",
   * hover card A): each open question or action item that stops the agent or
   * holds something up, in thread order, at most `INBOX_ROW_WAITS_MAX`, its
   * words capped (`INBOX_ROW_WAIT_TEXT_MAX`, `INBOX_ROW_WAIT_HOLDS_MAX`). Absent
   * when none does, and from an older Inbox (the card then lists
   * `questions.holds_up`). The window's list only: agents' rows never carry it.
   */
  waits?: InboxRowWait[];
}

/** One question behind a row's badge (`InboxListRow.waits`). */
export interface InboxRowWait {
  message_id: string;
  key: string;
  /** Its place among its message's blocks of its kind: Q1 is 0 (A1 for an action item, `key` starts `a-`). */
  position: number;
  prompt: string;
  /** Its `Stopped:` line, or null. */
  stopped: string | null;
  /** Its `Holds up:` entries. */
  holds_up: string[];
}

/** At most this many questions on a row's `waits`. */
export const INBOX_ROW_WAITS_MAX = 8;
/** A wait's prompt and `Stopped:` line are cut to this many characters ("…"). */
export const INBOX_ROW_WAIT_TEXT_MAX = 200;
/** At most this many `Holds up:` entries per wait, each cut to `INBOX_ROW_WAIT_ENTRY_MAX`. */
export const INBOX_ROW_WAIT_HOLDS_MAX = 8;
export const INBOX_ROW_WAIT_ENTRY_MAX = 120;

export interface InboxListSection {
  id: InboxSectionId;
  label: string;
  threads: InboxListRow[];
}

/** Something in the thread waits on the person: a question, or news they have not looked at. */
export function inboxRowWaitsOnPerson(row: Pick<InboxListRow, "section" | "unseen" | "answered_not_sent">): boolean {
  return (
    row.section === "stopped" ||
    row.section === "holding" ||
    row.section === "waiting" ||
    (row.section === "new" && (row.unseen > 0 || row.answered_not_sent))
  );
}

/**
 * Mark read is offered on the thread (the list row's hover action, and each
 * thread a project's "Mark all as read" takes): something waits on the
 * person, and the thread is open or came back from the archive (Mark read
 * sends a came-back thread back to the archive). Never on a thread whose Mark
 * read still stands: unsent work can keep it in New ("inbox-reply-drafts"),
 * and marking it again then undoing would drop the earlier Mark read.
 */
export function inboxRowOffersMarkRead(
  row: Pick<InboxListRow, "section" | "unseen" | "answered_not_sent" | "resolved_at" | "back_from_archive"> & { read_at?: string | null },
): boolean {
  return (row.resolved_at === null || row.back_from_archive === true) && (row.read_at ?? null) === null && inboxRowWaitsOnPerson(row);
}

export interface InboxThread {
  thread_id: string;
  /**
   * `repo` rides only on `GET /api/inbox/threads/:id` and is never stored:
   * the project's `origin`, or null for a folder without one or until the
   * Inbox has resolved it. Absent from an older Inbox.
   */
  project: InboxProject & { repo?: InboxProjectRepo | null };
  subject: string | null;
  /** The thread's name, or null for a session's default thread. */
  thread_name: string | null;
  resolved_at: string | null;
  /**
   * The window's read only (`GET /api/inbox/threads/:id`): the seq of the
   * archive line of a resolved thread, null for an open one. A message whose
   * `seq` is after it arrived after the archive and behaves as an open
   * thread's. Absent from an older Inbox and from the MCP tools.
   */
  archive_seq?: number | null;
  messages: InboxMessageWire[];
}

// ─────────────────────────────── Lines ───────────────────────────────

/** `card`: a Board card (approval "inbox-board"); a reader that does not know a kind skips its lines. */
export type InboxRecordKind = "project" | "message" | "question" | "annotation" | "card";

/** One line of the store: a full snapshot of one record. */
export type InboxLine =
  | { v: 1; seq: number; at: string; kind: "project"; id: string; record: InboxProject }
  | { v: 1; seq: number; at: string; kind: "message"; id: string; record: InboxMessage }
  | { v: 1; seq: number; at: string; kind: "question"; id: string; record: InboxQuestionRecord }
  | { v: 1; seq: number; at: string; kind: "annotation"; id: string; record: InboxAnnotationRecord }
  | { v: 1; seq: number; at: string; kind: "card"; id: string; record: InboxCard };

// ─────────────────────────────── Health ───────────────────────────────

export const INBOX_APP_ID = "plannotator-inbox";

export interface InboxHealth {
  ok: true;
  app: typeof INBOX_APP_ID;
  /** The running binary's version, or `dev` for a source run. */
  version: string;
  serverSession: string;
  pid: number;
  /**
   * The sidebar's update button (packages/server/inbox-updates.ts), or null.
   * `available` and `version` keep the older `{ available, version }` shape.
   */
  update: InboxUpdate | null;
  /** Whether a notification can reach the person now (additive; absent from an older Inbox). */
  notify_reach?: InboxNotifyReach;
  /**
   * Event streams open now, the windows' and the phone door's (additive). The
   * Inbox tabs of one browser origin share one stream (packages/inbox/sharedEvents.ts).
   */
  event_streams?: number;
  /**
   * This Inbox honours the peek mark on a read_thread list
   * (`INBOX_PEEK_META_KEY`): no project made for a folder it does not know,
   * the rows not counted as read (additive). A connection reads the session's
   * threads only from an Inbox that says so; an older one would make a
   * project for every folder that compacts or resumes.
   */
  peek?: true;
}

/** What an Inbox window reports about its browser's notification permission for its own origin. */
export type InboxWindowPermission = 'granted' | 'default' | 'denied' | 'unsupported' | 'unknown';

/**
 * Whether a browser notification can reach the person now
 * (packages/server/inbox-windows.ts): notifications come from an open Inbox
 * tab, so with none open, or none the browser lets notify, nothing reaches
 * them. `windows`: Inbox tabs holding an event stream; `allowed`: those whose
 * browser reported `granted`; `allowed_origins`: their addresses.
 */
export interface InboxNotifyReach {
  /** The Settings switch (config.json `inboxNotifications.enabled`). */
  enabled: boolean;
  windows: number;
  allowed: number;
  allowed_origins: string[];
}

/** The Inbox's update control: what the button says and does. */
export interface InboxUpdate {
  available: true;
  /**
   * `available`: a newer release exists, nothing installed yet. `updating`:
   * the install script runs. `ready`: a different binary is on disk (restart
   * to update). `failed`: an install the person started exited non-zero.
   */
  state: "available" | "updating" | "ready" | "failed";
  /** The version the button names. */
  version: string;
  /** The version this Inbox runs. */
  current: string;
  /** `script`: Update now runs the install script. `copy`: the binary is not the script's; the dialog shows the command. */
  action: "script" | "copy";
  releaseUrl: string;
  publishedAt?: string;
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

/**
 * The question sound (config.json `inboxSound`, through GET and POST
 * /api/inbox/settings): on unless turned off, one volume for every device.
 */
export interface InboxSoundSettings {
  enabled: boolean;
  /** 10 to 100; the slider has no 0, because the switch is how the sound goes off. */
  volume: number;
  /** The version the one-time "The Inbox can ring now" dialog was shown for (or a fresh install was marked with); null while never. */
  dialog_shown_for: string | null;
  /** The one-time dialog waits for a page on this computer to claim it (POST /api/inbox/sound/dialog). Absent from an Inbox before it. */
  dialog_due?: boolean;
}

export const INBOX_SOUND_DEFAULT_VOLUME = 60;
export const INBOX_SOUND_MIN_VOLUME = 10;
export const INBOX_SOUND_MAX_VOLUME = 100;

/** A volume the Inbox keeps: a whole number from 10 to 100. */
export function isInboxSoundVolume(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= INBOX_SOUND_MIN_VOLUME && value <= INBOX_SOUND_MAX_VOLUME;
}

/**
 * The onboarding tour (approval "inbox-onboarding-tour"; config.json
 * `inboxTour`, through GET and POST /api/inbox/settings `tour`), kept per
 * machine and written by the server only. `seen_at`: the tour was started;
 * `finished_at`: it reached the end; `skipped_at`: the person left it, or
 * chose "Connect my agents" on the entry screen. Once finished or skipped the
 * first-run screen no longer opens on the entry screen; a quiet "Take the
 * tour" link stays. `notify_again`: the tour ended with notifications not on,
 * so the person's first real thread offers them once more, inline.
 */
export interface InboxTourState {
  version: number;
  seen_at: string | null;
  finished_at: string | null;
  skipped_at: string | null;
  notify_again: boolean;
}

/** What POST /api/inbox/settings `tour` takes: each `true` stamps now; `notify_again` sets the flag. */
export interface InboxTourChange {
  seen?: boolean;
  finished?: boolean;
  skipped?: boolean;
  notify_again?: boolean;
}

/** The tour's content version: the fixture's `v`, recorded with each stamp. */
export const INBOX_TOUR_VERSION = 2;

/**
 * The Inbox window's text size (config.json `inboxTextSize`, through GET and
 * POST /api/inbox/settings `text_size`): the body size in px the whole type
 * ramp scales from (packages/inbox/inbox.css `--ib-type`). 14 is the window
 * as it has always been drawn.
 */
export const INBOX_TEXT_SIZES = [12, 13, 14, 15] as const;
export type InboxTextSize = (typeof INBOX_TEXT_SIZES)[number];
export const INBOX_TEXT_SIZE_DEFAULT: InboxTextSize = 14;

/** A text size the Inbox keeps: 12, 13, 14 or 15. */
export function isInboxTextSize(value: unknown): value is InboxTextSize {
  return typeof value === "number" && (INBOX_TEXT_SIZES as readonly number[]).includes(value);
}

/**
 * The agents the Inbox connects itself to on `plannotator inbox` (the
 * approved "inbox-agent-awareness" design; packages/server/inbox-agents.ts).
 * Terminal agents and the Claude desktop app; editors keep their one-click
 * link or snippet in Settings and are never written to automatically.
 */
export type InboxAgentId =
  | "claude-code"
  | "codex"
  | "gemini"
  | "qwen"
  | "cursor"
  | "windsurf"
  | "amp"
  | "cline"
  | "kiro"
  | "pi"
  | "opencode"
  | "claude-app";

export const INBOX_AGENT_IDS: readonly InboxAgentId[] = [
  "claude-code",
  "codex",
  "gemini",
  "qwen",
  "cursor",
  "windsurf",
  "amp",
  "cline",
  "kiro",
  "pi",
  "opencode",
  "claude-app",
];

export const INBOX_AGENT_LABELS: Readonly<Record<InboxAgentId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  qwen: "Qwen Code",
  cursor: "Cursor",
  windsurf: "Windsurf / Devin",
  amp: "Amp",
  cline: "Cline",
  kiro: "Kiro",
  pi: "Pi",
  opencode: "OpenCode",
  "claude-app": "Claude app",
};

/** "Codex", "Codex and Amp", "Codex, Amp and Pi". */
export function inboxAgentList(ids: readonly InboxAgentId[]): string {
  const names = ids.map((id) => INBOX_AGENT_LABELS[id]);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** An agent connected in another file than this Inbox's environment names (`InboxConnectReport.elsewhere`): where, and how the person moves it. */
export function inboxElsewhereText(moved: { agent: InboxAgentId; path: string | null; now: string | null }): string {
  const label = INBOX_AGENT_LABELS[moved.agent];
  const why = `${moved.agent === "qwen" ? "this Inbox has another QWEN_HOME, so it" : "this Inbox"} looks in ${moved.now ?? "another file"}`;
  return `${label} is connected in ${moved.path ?? "another file"}, but ${why}. Plannotator left both as they are; Settings → Agents shows it off here, and turning it on moves it.`;
}

/** What one `plannotator inbox` run did to the agents on this computer. */
export interface InboxConnectReport {
  at: string;
  /** The first run that connected anything on this computer; later runs say "new on this computer". */
  first: boolean;
  /** Skipped as a whole: `PLANNOTATOR_INBOX_CONNECT=0`, or a test sandbox whose home is the real one. */
  skipped?: "env" | "sandbox";
  /** Connected by this run. */
  added: InboxAgentId[];
  /** Already reached the Inbox before this run (found, or connected earlier). */
  already: InboxAgentId[];
  /** Could not be connected; nothing was changed. Tried again at the next run. */
  failed: { agent: InboxAgentId; reason: string; path: string | null }[];
  /** Have a `plannotator-inbox` entry that runs something else; left alone. */
  foreign: { agent: InboxAgentId; path: string | null }[];
  /** Found, but only a person can connect them (no CLI on PATH, a config file Plannotator does not edit). */
  manual: InboxAgentId[];
  /** Why each manual agent needs a person, said once per reason (the terminal prints these). */
  manual_why?: { agent: InboxAgentId; why: string }[];
  /**
   * Connected in another file than this run's environment names (`QWEN_HOME`
   * differs from when the entry was added): left where it is, said once;
   * turning the agent on in Settings → Agents moves it.
   */
  elsewhere?: { agent: InboxAgentId; path: string | null; now: string | null }[];
  /** Did not finish within the time limits; tried again at the next run. */
  unfinished: InboxAgentId[];
  /** Claude Code's plugin gives it the `plannotator_inbox` tool already. */
  claude_code: boolean;
  /**
   * Agents this run registered Plannotator with as a trusted sender, so the
   * person's replies go into their running sessions (Qwen Code:
   * packages/server/inbox-qwen-trust.ts). Absent from older Inboxes.
   */
  trusted?: InboxAgentId[];
  /** Why registering as a trusted sender failed this run, said once per reason. */
  trust_failed?: { agent: InboxAgentId; reason: string }[];
}

/** The agents whose own instructions file can carry the Inbox note (packages/server/inbox-agent-notes.ts). */
export type InboxNoteAgentId = "claude-code" | "codex" | "opencode" | "pi" | "gemini" | "qwen" | "cursor";
export const INBOX_NOTE_AGENT_IDS: readonly InboxNoteAgentId[] = ["claude-code", "codex", "gemini", "qwen", "pi", "opencode", "cursor"];

/**
 * Where an agent's note would go and how it stands:
 *  - absent: no note; `create` says whether adding it creates the file.
 *  - added: the note Plannotator wrote is there, untouched.
 *  - edited: the note is there but the person changed it; Plannotator never updates it.
 *  - damaged: the markers are broken (one, several, or out of order); nothing is written.
 *  - refused: the file cannot be edited (not a regular file, over 1 MiB, not UTF-8, unreadable).
 *  - unavailable: no file to add to (OpenCode's AGENTS.md does not exist, and Plannotator never creates it).
 */
export interface InboxAgentNoteStatus {
  agent: InboxNoteAgentId;
  /** The file, `~` for the home folder. */
  path: string | null;
  /** The file is a link; `target` is where it leads (shown). */
  target: string | null;
  state: "absent" | "added" | "edited" | "damaged" | "refused" | "unavailable" | "manual";
  /** Adding it creates the file. */
  create: boolean;
  /** Plannotator created the file (removing the note deletes it when nothing else is left). */
  created: boolean;
  /** Why it is refused, damaged or unavailable. */
  reason: string | null;
  /** Other agents whose note lives in the same file (a link to one shared file): one section, kept while any of them has it on. */
  shared_with?: InboxNoteAgentId[];
}

/** One agent in `GET /api/inbox/agents` (Settings → Agents and the first-open card). */
export interface InboxAgentRow {
  id: InboxAgentId;
  label: string;
  /** Found on this computer (its command on PATH, its folder, Plannotator's plugin). */
  detected: boolean;
  reach: {
    kind: "tool" | "mcp" | "manual" | "none";
    on: boolean;
    state: "connected" | "off" | "removed" | "foreign" | "not_connected" | "manual" | "unreadable" | "elsewhere";
    path: string | null;
    /** PLANNOTATOR_INBOX_TOOL decides it. */
    locked: boolean;
    reason: string | null;
  };
  /**
   * Claude Code, Pi and OpenCode only: their `plannotator_inbox` tool switch (`inboxTool`), shown whether or not the agent was found.
   * `chosen_off`: config.json turns it off by name (not the host's default), so the first-run screen never offers turning it on.
   * `mod_off` (Claude Code): Plannotator's Claude Code mod is off (PLANNOTATOR_CLAUDE_MOD / claudeCodeMod), so there is no tool whatever inboxTool says.
   */
  tool?: { on: boolean; locked: boolean; chosen_off?: boolean; mod_off?: boolean } | null;
  /** Claude Code, Pi and OpenCode only. `needs_tool`: the tool is off, so there is no reminder. */
  reminder: { on: boolean; locked: boolean; needs_tool: boolean } | null;
  note: InboxAgentNoteStatus | null;
  /**
   * Claude Code, Pi and OpenCode only: whether Plannotator's own plugin or
   * extension is installed (Claude Code's plugin enabled, Pi's settings
   * `packages`, OpenCode's global `plugin`/`plugins`). Absent from an older
   * Inbox; null for every other agent. `disabled` (Claude Code): installed and
   * turned off by name (`claude plugin disable`), the person's choice;
   * `managed`, turned off by managed (enterprise) settings.
   * `generation` (OpenCode): the version on PATH (`opencode2`: 2, `opencode`
   * alone: 1), for the plugin line that version reads.
   */
  plugin?: { installed: boolean; disabled?: boolean; managed?: boolean; generation?: "1" | "2" } | null;
  /**
   * An agent its MCP connection alone wakes (INBOX_MCP_WAKING_HOSTS: Codex,
   * Qwen Code), connected through MCP: whether this Inbox can wake it now
   * (Codex: a Codex CLI INBOX_CODEX_QUEUE_MIN_VERSION or later it can run;
   * Qwen Code: a trusted-sender token, not on Windows). Absent for every
   * other row and from an older Inbox.
   */
  wakes?: boolean;
}

export interface InboxAgentsModel {
  agents: InboxAgentRow[];
  last_report: (InboxConnectReport & { seen?: boolean }) | null;
  connecting: boolean;
  /** PLANNOTATOR_INBOX_CONNECT turns the automatic step off. */
  connect_env_off: boolean;
  /** PLANNOTATOR_INBOX_TOOL's value when set. */
  tool_env: boolean | null;
  /** PLANNOTATOR_INBOX_NOTES=0: no note offer, and note rows only for a note already written (it can be turned off, not added). */
  notes_env_off?: boolean;
  /** The note question was answered at least once. */
  notes_offered: boolean;
  /** The agents the note question was asked about: each is asked once (absent from an Inbox of 0.28.18 or older, which asked once in all). */
  notes_asked?: InboxNoteAgentId[];
  /** The exact block a note writes, markers included. */
  note_text: string;
  /** A switch's refusal, after POST /api/inbox/agents. */
  error?: string | null;
  /**
   * The open sessions of the three Plannotator hosts that poll the Inbox now
   * (packages/server/inbox-restart.ts), for Settings → Agents' "Open sessions"
   * row. Absent from an Inbox older than the field.
   */
  sessions?: Partial<Record<InboxToolHostId, InboxHostSessions>>;
}

/** The three hosts that connect through Plannotator's own plugin or extension. */
export type InboxToolHostId = "claude-code" | "pi" | "opencode";

/**
 * The runtime a polling session runs in, as the window names its fix: Claude
 * Code, Pi, Oh My Pi (polls as host `pi`, says `plugin.host: "oh-my-pi"`), or
 * OpenCode 2 (host `opencode`; OpenCode 1 does not poll).
 */
export type InboxReloadRuntime = "claude-code" | "pi" | "oh-my-pi" | "opencode";

/**
 * A polling session runs an older Plannotator plugin than a restart would
 * load (`fix: "restart"`, Claude Code), or the installed plugin is itself
 * behind this Inbox's Plannotator, so a restart alone does not help (`fix:
 * "update_plugin"`). Pi, Oh My Pi and OpenCode 2 (packages/server/inbox-restart.ts):
 * `"reload"` when reloading the host loads newer code than the session runs
 * (`reload_command`: Pi `/reload`, Oh My Pi `/restart`, OpenCode 2
 * `opencode2 reload` or `opencode2 plugin update`), `"update_extension"` when
 * the package on disk is itself behind this Inbox (`update_command`, then
 * `reload_command`). `loaded` is the version the session runs (null when its
 * connection predates reporting it), `installed` what a restart loads (Pi with
 * an older connection: the Inbox's own version, which the extension should match).
 */
export interface InboxSessionOutdated {
  loaded: string | null;
  installed: string | null;
  fix: "restart" | "update_plugin" | "update_extension" | "reload";
  /** With `update_plugin` / `update_extension`: the command that updates the plugin itself. */
  update_command?: string;
  /** Which runtime the session runs in (absent from an older Inbox: Claude Code, or Pi for `update_extension`). */
  runtime?: InboxReloadRuntime;
  /** What loads the new code in that runtime: `/reload`, `/restart`, `opencode2 reload`. Absent for Claude Code (`/reload-plugins`). */
  reload_command?: string;
  /** Typed in the session (`/reload`, `/restart`) or run in a shell (`opencode2 reload`). */
  reload_where?: "session" | "shell";
  /** When the reload does not take: `opencode2 service restart`. */
  fallback_command?: string;
  /**
   * OpenCode 2: the config pins this exact spec (`@plannotator/opencode@0.28.20`), so
   * `opencode2 plugin update` does nothing: the person changes it to `pin_to`, then reloads.
   */
  pinned_spec?: string;
  pin_to?: string;
  /** OpenCode 2: `all` when the plugin's configured spec is unknown, so `opencode2 plugin update` names no target and updates every outdated plugin. */
  update_scope?: "all";
}

/**
 * The live sessions a reload alone brings up to date, per runtime: the
 * sidebar's "Reload Claude Code N" ("Reload agents N" when more than one
 * runtime has some). Additive beside `restart_claude_code`.
 */
export interface InboxRestartAgents {
  total: number;
  runtimes: Partial<Record<InboxReloadRuntime, number>>;
}

/** One open session as Settings → Agents lists it. */
export interface InboxOpenSession {
  session: string;
  /** The folder's name the session works in, or null when its connection does not say. */
  project: string | null;
  /** Its working folder as the window shows it (`~` for the home folder); null when unknown. */
  folder: string | null;
  started_at: string;
  busy: boolean | null;
  /** The plugin or extension version it loaded; null when it does not say. */
  plugin: string | null;
  outdated: InboxSessionOutdated | null;
  /** `cd <folder> && claude --resume <session>` (Claude Code, with a known folder); null otherwise. */
  restart_command: string | null;
  /** The runtime it runs in (Pi's group holds Oh My Pi sessions too). Absent from an older Inbox. */
  runtime?: InboxReloadRuntime;
}

export interface InboxHostSessions {
  running: number;
  /** Sessions with `outdated` set. */
  outdated: number;
  /** What a restart loads (Claude Code: the installed plugin's version); null when unknown. */
  installed: string | null;
  /** The command that updates the plugin itself, when the installed plugin is behind this Inbox (Claude Code). */
  update_command: string | null;
  sessions: InboxOpenSession[];
}

/** The hosts whose every request carries the `plannotator_inbox` tool in full once it is on (Claude Code defers it behind tool search). */
export type InboxToolCostHost = "pi" | "opencode";

/**
 * What turning the Inbox tool on adds to every request on Pi and OpenCode 2,
 * measured on the real hosts: apps/pi-extension/inbox.test.ts and
 * apps/opencode-plugin/inbox-v2.test.ts read the request the host sends a
 * scripted model and fail when the tool's entry drifts more than 5% from
 * `bytes`. Tokens depend on the model's tokenizer: Claude's tokenizer counts
 * JSON and code higher than o200k_base (GPT-4o and later), so `tokens` is a
 * rounded, deliberately high estimate, stated as "roughly". The window states
 * both (`inboxToolCostText`: the first-run screen, Settings → Agents), as does
 * `plannotator inbox --help`. History on both hosts: 11,736 bytes (2,796
 * tokens with o200k_base) before the long field descriptions were shortened
 * (INBOX_AGENT_FIELD_DESCRIPTIONS); 7,058 bytes (1,661 with o200k_base) before
 * Decisions (list_decisions, record_decision) were removed; about 6,390 bytes
 * after (estimated from the generated entry, never re-measured); 7,328 bytes
 * (1,732 with o200k_base) measured on Pi with the read_thread window's fields
 * (`expand`, `before`, `after`, `format`) and the `search` action added. The
 * current value adds the Board's `card` action (approval "inbox-board"):
 * 8,503 bytes, 2,047 tokens with o200k_base, computed from the generated
 * entry in Pi's request shape (that computation gives 7,325 for the entry Pi
 * measured at 7,328); the Pi and OpenCode cost tests hold it to 5%. While the
 * card action is held back (INBOX_CARD_ACTION_ON false), the size without it.
 * Action items (approval "inbox-next-actions") then added the `:::action`
 * paragraph to `body` and the `done` field: +861 bytes and +221 tokens with
 * o200k_base on the generated entry in Pi's request shape (7,362 → 8,223
 * bytes, 1,744 → 1,965 tokens), so 8,189 bytes (1,953 tokens) without the
 * card action and 9,364 (2,268) with it, estimated, not re-measured on Pi.
 * Renaming "to-do" to "action item" (owner, #2059) moved the entry by 5 bytes
 * (8,228; 1,962 tokens), and "Action items you asked for" by 5 more (8,233;
 * 1,963 tokens): the stated cost stands. The question contract lines
 * (approval "inbox-decision-mode": `Stakes:`, `Shows:`, `Why:`,
 * `Reversible:`, picture choices) added one paragraph to `body`, measured on
 * Pi with the cost test (INBOX_TOOL_COST_DUMP): 8,248 → 8,701 bytes, 1,964 →
 * 2,086 tokens with o200k_base (+453 bytes, +122 tokens). So 8,701 bytes
 * without the card action and 9,817 with it (9,364 + 453, estimated).
 * The screenshot nudge in `attachments` ("For something visual, a screenshot
 * or image usually reads fastest…") added one sentence, measured on Pi with
 * the cost test: 8,701 → 8,841 bytes (+140; about +30 tokens, so the rounded
 * token figure stands). So 8,841 without the card action and 9,957 with it
 * (9,817 + 140, estimated).
 * The Board's step 2 switched the card action on (INBOX_CARD_ACTION_ON), with
 * its `ref` argument and the Backlog wording: measured on Pi with the cost
 * test, 10,131 bytes; tokens scaled from the last o200k_base count (2,086 for
 * 8,701 bytes, so about 2,430) and stated high, as always. The review then let
 * `column` take `asked` (the old name of backlog, listed in the schema and
 * its description): measured again, 10,171 bytes (+40).
 * Then the Board became something the person turns on (config.json
 * `inboxBoard`, off by default; approval "inbox-board" 2026-10-26): an Inbox
 * lists `card` only while it is on, so what a user gets by default is the
 * entry WITHOUT `card`, and that is the stated cost. With the Board on it is
 * the 10,171 bytes above.
 * The title rule (approval "inbox-board-amendments-2026-10-27": "2–5 words
 * naming the work, never a sentence", and link the thread where the person
 * decides) in the card description and its `title` and `thread_id`
 * arguments: measured on Pi with the cost test and the Board on, 10,171 →
 * 10,303 bytes (+132; about +35 tokens, so the rounded, high token figure
 * stands).
 * The reply_to check (INBOX_REPLY_TO_CHECK, the misfiled-thread AAR,
 * 2026-10-27) added one sentence to the agent tool's `reply_to`: measured on
 * Pi with the cost test, 8,841 → 8,964 bytes (+123; about +30 tokens, so the
 * rounded token figure stands). With the Board on 10,294 (10,171 + 123,
 * estimated).
 * Then the rules agents must get with no setup (the owner, 2026-10-27): the
 * wake note's "reply_to set to that reply id, never an id from memory",
 * read_thread's and search's leads (listing every thread, older messages),
 * `asked_by` and `include_resolved` described, and the Recommended: line in
 * `body`: measured on Pi, 9,227 bytes (+263, about +70 tokens). With the
 * Board on 10,557 (10,294 + 263, estimated).
 * Then the chat-or-Inbox rule in the lead (the owner, 2026-10-27), with the
 * wake note and get_guide_brief's lead shortened to fit: measured on Pi,
 * 9,283 bytes (+56); its one wording ("when the person writes in the chat",
 * "with a blocking question tool (AskUserQuestion or similar)"): 9,298 bytes
 * (+15). With the Board on 10,760 (the Board title rule's 10,303 + this
 * branch's 457, estimated).
 * Then the Board-off line (INBOX_TOOL_BOARD_OFF_NOTE, the owner's answer of
 * 2026-10-27: with the Board off, one short line that it exists and
 * `plannotator card --help`): measured on Pi, 9,416 bytes (+118; about +25
 * tokens, so the rounded, high token figure stands). With the Board on the
 * line is left out: 10,760 stands.
 * Then where refs link (INBOX_REF_LINK_RULE, 171 characters, on `body`):
 * 9,591 bytes (+175, about +40 tokens, estimated). With the Board on, the
 * card's `say` and `you` add a 36-character pointer each: 11,009 (+249,
 * estimated).
 * Then the follow-through rule in the lead (INBOX_FOLLOW_THROUGH_RULE, the
 * owner's sentence, 2026-10-27: 252 bytes in place of "No routine
 * progress.", 20), paid for in the description by shorter action leads
 * (send_message, wait_for_reply, resolve_message, read_thread, whose detail
 * moved to its `thread_id` field, get_guide_brief), the wake note's "A reply
 * arrives" and the lead's last sentence; "Pass an idempotency_key so a retry
 * never posts twice." moved from the server instructions into that field's
 * description. Measured on Pi over the ref-link figure: 9,733 bytes (+142,
 * 1.5%; about +35 tokens). The stated cost stands.
 * Then the fences that draw in `body` (approval "inbox-inline-html",
 * 2026-10-28: Mermaid and Graphviz diagrams, live HTML pages): one sentence,
 * measured on Pi with the ref rule in, 9,848 bytes (+257, about +65 tokens).
 * With the Board on 11,267 (11,009 + 258, estimated).
 * Then T3 Code's height rule in that sentence ("Let content set its
 * height: no vh units or height:100% on html or body"): measured on Pi, 9,920
 * bytes (+72, about +18 tokens, so the rounded token figure stands). With the
 * Board on 11,339 (11,267 + 72, estimated).
 * With the follow-through rule merged in as well: measured on Pi, 10,062
 * bytes (+142, about +35 tokens; the rounded token figure stands). With the
 * Board on 11,481 (11,339 + 142, estimated).
 */
const INBOX_TOOL_COST_NOW = { bytes: 10062, tokens: 2700 };
/** The entry with the Board on (the `card` action listed): for the switch's words, measured on Pi. */
export const INBOX_TOOL_COST_WITH_BOARD = { bytes: 11481, tokens: 3100 } as const;
export const INBOX_TOOL_COST: Readonly<Record<InboxToolCostHost, { bytes: number; tokens: number }>> = {
  pi: INBOX_TOOL_COST_NOW,
  opencode: INBOX_TOOL_COST_NOW,
};

/** "about 9 KB, roughly 2,500 tokens" for a host's measured cost. */
export function inboxToolCostText(host: InboxToolCostHost): string {
  const cost = INBOX_TOOL_COST[host];
  return `about ${Math.round(cost.bytes / 1000)} KB, roughly ${cost.tokens.toLocaleString("en-US")} tokens`;
}

/** "Codex, Gemini CLI and Pi" for note agents. */
export function inboxNoteAgentList(ids: readonly InboxNoteAgentId[]): string {
  return inboxAgentList(ids);
}

// ─────────────── Compose: a new thread the person starts with a live agent ───────────────

/**
 * A file the person uploaded from the window for a thread they start, not
 * sent yet (`POST /api/inbox/uploads`). At send it becomes an
 * `InboxAttachment`; a draft names it by `upload_id`.
 */
export interface InboxUpload {
  upload_id: string;
  name: string;
  size: number;
  kind: InboxAttachmentKind;
  sha256: string;
  created_at: string;
  media_type?: string;
  width?: number;
  height?: number;
}

/** The session a draft was written for, with enough to name it after it has ended. */
export interface InboxDraftTo {
  host: string;
  session: string;
  project_root: string | null;
  project_name: string | null;
  started_at: string | null;
}

/**
 * A message the person started and did not send (`inbox/drafts/<id>.json`):
 * never in the event log, so never seen by agents, phones or search. A draft
 * never sends itself and is never re-addressed on its own.
 */
/** What a list row says is not sent yet (`InboxListRow.unsent`). */
export interface InboxRowUnsent {
  /** When the reply box's words were last saved, or null when the thread holds no reply draft. */
  reply_at: string | null;
  /** Picks saved and not sent. */
  picks: number;
  /** Comments (on attached files, the guided review, the messages) waiting for a Send. */
  comments: number;
  /** Action items marked Done waiting in the reply draft ("Draft · 1 done"; approval "inbox-action-items-in-reply"). Absent: none. */
  done?: number;
  /** Action items marked Can't do it waiting in the reply draft ("Draft · 1 can't do"). Absent: none. */
  cant?: number;
}

/**
 * Archived: resolved, and not come back. Not shown in the window's list;
 * Settings lists it. A thread an agent wrote in after the archive is back in
 * the list while something there waits, and returns here once handled. One
 * rule for the server's list (shared/inbox/list.ts re-exports it) and the
 * window (a list row's count, a pinned row).
 */
export function inboxRowArchived(row: Pick<InboxListRow, "resolved_at" | "back_from_archive">): boolean {
  return row.resolved_at !== null && row.back_from_archive !== true;
}

/** The thread holds something the person has not sent: reply words, picks or comments. */
export function inboxHasUnsent(unsent: InboxRowUnsent | null | undefined): boolean {
  return !!unsent && (unsent.reply_at !== null || unsent.picks > 0 || unsent.comments > 0 || (unsent.done ?? 0) > 0 || (unsent.cant ?? 0) > 0);
}

/**
 * The words the person typed in a thread's reply box and did not send
 * (approval "inbox-reply-drafts"): one per thread, kept outside the event log
 * (`inbox/reply-drafts/<thread id>.json`), so agents, the MCP, phones' event
 * stream and search never see it.
 */
export interface InboxReplyDraft {
  v: 1;
  thread_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

/**
 * A thread pinned to the window's sidebar (approval "inbox-pinned-threads"):
 * window furniture only. Kept in `inbox/pins.json`, in pin order, outside the
 * event log, so agents, the MCP, search and the phone's event stream never
 * see it. A pin changes nothing about the thread: not its section, routing,
 * questions or delivery.
 */
export interface InboxPin {
  thread_id: string;
  pinned_at: string;
}

/** A row on the Drafts page's "Replies not sent" (`GET /api/inbox/drafts` `replies`). */
export interface InboxReplyDraftRow extends InboxListRow {
  /** The reply draft's first words (whitespace folded, at most 160 characters), or null when only picks or comments wait. */
  reply_preview: string | null;
}

export interface InboxDraft {
  v: 1;
  id: string;
  created_at: string;
  updated_at: string;
  body: string;
  to: InboxDraftTo | null;
  /** The project it was written in (the chosen session's, or the one open in the list). */
  project: { id: string | null; root: string; name: string } | null;
  files: InboxUpload[];
  /**
   * The thread's name the person typed in compose (the chip), as typed.
   * Absent while the chip follows the message (compose's suggestion, worked
   * out again from the body when the draft opens).
   */
  thread_name?: string;
  /**
   * The Board card it was started for (the opened card's Create thread): the
   * Send that sends the draft links the new thread to this card. Absent for
   * any other draft.
   */
  card?: { id: string; title: string };
  /** Compose's Board chip was on (approval "inbox-compose-board-chip"): the Send asks the agent to track the work on the Board. */
  board_request?: true;
}

/** A draft's chip: its chosen session is live, has ended, or none was chosen. */
export type InboxDraftStatus = "live" | "ended" | "none";

/** One live session as compose lists it (`GET /api/inbox/sessions`). */
export interface InboxComposeSession {
  session: string;
  host: string;
  started_at: string;
  last_seen_at: string;
  busy: boolean | null;
  idle_since: string | null;
  /** The thread it last wrote in, or null when it has not written in the Inbox. */
  last_thread: { id: string; subject: string | null; at: string } | null;
}

/** Live sessions grouped by the project they work in; `id` null for a folder the Inbox has not seen yet. */
export interface InboxComposeProject {
  project: { id: string | null; name: string; root: string };
  sessions: InboxComposeSession[];
}

/**
 * The first Plannotator release whose Claude Code mod reports `plugin` on its
 * bridge poll (packages/server/inbox-restart.ts). A new mod ALWAYS sends the
 * field (version or root null when it could not read them), so a poll without
 * it means a mod older than this. Must merge before the version bump to it.
 */
export const INBOX_PLUGIN_REPORTS_LOADED_SINCE = "0.28.24";

/**
 * The first Plannotator release whose Claude Code mod has Send now (#1968).
 * A session that loaded this or newer already has Send now, so a missing Send
 * now there has another cause (its own Ask question holds the turn, the engine
 * refused a row) and the reply line never blames the plugin for it.
 */
export const INBOX_SEND_NOW_SINCE = "0.28.24";

/**
 * Whether a session that loaded `version` (null: unknown, an older mod)
 * predates Send now. A version that is not a plain release (a development
 * build) is taken as having it.
 */
export function inboxLoadedPredatesSendNow(version: string | null | undefined): boolean {
  if (version === null || version === undefined || version === "") return true;
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!parts) return false;
  const min = INBOX_SEND_NOW_SINCE.split(".").map(Number);
  const have = parts.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== min[i]!) return have[i]! < min[i]!;
  }
  return false;
}

/**
 * The oldest Claude Code engine the mod offers Send now on (a copy of the
 * mod's `SESSION_APPEND_MIN_ENGINE`, apps/hook/hooks/mod/inbox.ts; the mod's
 * send-now-engine test keeps them equal). The restart line under a reply uses
 * it only to stay quiet where a restart would not bring Send now (an engine
 * too old for it); the window never says so (owner, 2026-10-19).
 */
export const INBOX_SEND_NOW_MIN_ENGINE = "2.1.301";

/** Whether a reported engine version is too old for Send now; false when it is unknown or unreadable. */
export function inboxEngineTooOldForSendNow(version: string | null | undefined): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof version === "string" ? version.trim() : "");
  if (!parts) return false;
  const min = INBOX_SEND_NOW_MIN_ENGINE.split(".").map(Number);
  const have = parts.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== min[i]!) return have[i]! < min[i]!;
  }
  return false;
}

/**
 * Settings → Prompts (approval "inbox-prompts-page", #2194): what Plannotator
 * tells agents, as `GET /api/inbox/settings` carries it in `prompts`.
 */
export const INBOX_PROMPT_HOSTS = ["claude-code", "pi", "opencode"] as const;
export type InboxPromptHost = (typeof INBOX_PROMPT_HOSTS)[number];

/** One of the plan, review and annotate prompts (config.json `prompts.<group>.<name>`), read-only in the window. */
export interface InboxPromptItem {
  /** `prompts.<group>.<name>`, the config.json key. */
  key: string;
  group: "plan" | "review" | "annotate";
  /** The group's heading: Plan, Code review, Annotate. */
  group_label: string;
  label: string;
  /** Plannotator's own text. */
  default: string;
  /** The text in effect for an agent without its own: config.json's, else the default. */
  text: string;
  /** config.json sets this prompt (the shared text, or one agent's own). */
  custom: boolean;
  /** The agents config.json gives their own text for this prompt (`prompts.<group>.runtimes.<agent>.<name>`). */
  runtimes: string[];
  /** A fact about the default, shown while it is in effect ("OpenCode has a shorter default."). */
  note: string | null;
}

export interface InboxPromptsSettings {
  /** The Inbox reminder at session start (config.json `prompts.inbox`). */
  reminder: {
    /** `prompts.inbox.reminder`: the person's shared text, or null (the default). */
    shared: string | null;
    /** `prompts.inbox.runtimes.<agent>.reminder`: an agent's own text (it wins), or null. */
    runtimes: Record<InboxPromptHost, string | null>;
    /** The built-in lines: for hosts whose reply comes back by itself, and for those without it (OpenCode 1). */
    defaults: { wake: string; no_wake: string };
    /** The most characters a custom reminder may hold; a longer one is refused. */
    max: number;
    /** Whether each agent gets a reminder at all (`inboxReminder`, with the Inbox tool). */
    on: Record<InboxPromptHost, boolean>;
    /**
     * Whether each agent's reply comes back by itself, so its default is `defaults.wake`;
     * false: the no-wake default (OpenCode 1). Absent from an older Inbox: all true.
     */
    wakes?: Record<InboxPromptHost, boolean>;
    /**
     * Text config.json holds that is over `max` and so is ignored (the agent gets the
     * next text in line): its length, else null. Absent from an older Inbox.
     */
    over?: { shared: number | null; runtimes: Record<InboxPromptHost, number | null> };
    /** Whether this page may change it: false through the tailnet (it reaches every agent on this computer). */
    editable: boolean;
  };
  /** The plan, review and annotate prompts, in the order the page lists them. */
  others: InboxPromptItem[];
}

/** `POST /api/inbox/settings` `{ prompts: { inbox: … } }`: a string sets the text, null (or blank) deletes the key. */
export interface InboxPromptsChange {
  inbox: {
    reminder?: string | null;
    runtimes?: Partial<Record<InboxPromptHost, { reminder?: string | null }>>;
  };
}
