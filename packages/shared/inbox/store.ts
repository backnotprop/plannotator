/**
 * Plannotator Inbox store: per-project append-only JSONL under
 * `${dataDir}/inbox/`, read whole at start and kept in memory.
 *
 * One writer: the Inbox server process. Every change appends ONE line, a full
 * snapshot of the record, in a single append-mode write; the in-memory view is
 * updated from that same line and every subscriber is told, in seq order. A
 * line that does not parse is skipped on read (a torn last line after a
 * crash); before the first append to a file whose last line is torn, a newline
 * is appended first so the fragment stays its own unreadable line and the new
 * line stays whole.
 *
 * The rules (picks, Send, idempotency) live here so the window's API and the
 * MCP tools share them. See schema.ts for the layout.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  checkInboxAnswer,
  composeInboxReplyBody,
  deriveInboxSubject,
  parseInboxQuestionBlocks,
  summarizeInboxQuestions,
  toInboxQuestion,
  type InboxAnswerRefusal,
} from "@plannotator/core/inbox-questions";
import {
  inboxId,
  INBOX_RECORD_VERSION,
  type InboxAuthor,
  type InboxLine,
  type InboxMessage,
  type InboxMessageWire,
  type InboxPicker,
  type InboxProject,
  type InboxQuestion,
  type InboxQuestionRecord,
  type InboxListRow,
  type InboxListSection,
  type InboxThread,
  type InboxThreadSummary,
  checkInboxThreadName,
  inboxThreadNameKey,
} from "@plannotator/core/inbox-types";
import { inboxListSections, inboxRowUnread, inboxSectionOf } from "./list";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import { sanitizeTag } from "@plannotator/core/project";
import {
  INBOX_PROJECTS_DIR,
  InboxError,
  inboxDir,
  MESSAGES_FILE,
  parseInboxLine,
  PROJECT_FILE,
  QUESTIONS_FILE,
} from "./schema";

/** The local person, the only picker on a local Inbox. */
export const INBOX_PERSON: InboxPicker = { id: "person", name: null };

export type InboxListener = (line: InboxLine) => void;

export interface InboxSendInput {
  project_id: string;
  author: Extract<InboxAuthor, { kind: "agent" }>;
  body: string;
  subject?: string | null;
  reply_to?: string | null;
  idempotency_key?: string | null;
  /**
   * A thread name in this project: the open thread of that name, across
   * sessions, or a new one under it. Without it (and without reply_to) the
   * message joins its session's open default thread. Ignored with reply_to.
   */
  thread?: string | null;
}

export interface InboxSendResult {
  message: InboxMessageWire;
  replayed: boolean;
}

export interface InboxAnswerEntry {
  key: string;
  revision: number;
  /** Absent: keep the current pick (Send only). Null: clear the pick. */
  answer?: unknown;
}

export interface InboxReplyInput {
  words?: string;
  questions?: InboxAnswerEntry[];
  idempotency_key: string;
}

export interface InboxReplyResult {
  reply: InboxMessage;
  questions: InboxQuestion[];
  replayed: boolean;
}

function refusalError(refusal: InboxAnswerRefusal): InboxError {
  switch (refusal.code) {
    case "validation_error":
      return new InboxError("validation_error", `${refusal.field}: ${refusal.message}`, { field: refusal.field });
    case "question_not_found":
      return new InboxError("question_not_found", `No question ${refusal.key} on this message.`, { key: refusal.key });
    case "question_revision_conflict":
      return new InboxError(
        "question_revision_conflict",
        `Question ${refusal.key} changed since you read it (revision ${refusal.current_revision}).`,
        { key: refusal.key, current_revision: refusal.current_revision },
      );
    case "question_already_sent":
      return new InboxError("question_already_sent", `The answer to ${refusal.key} was already sent.`, { key: refusal.key });
  }
}

/** `<name>-<6 hex of the root>`, so two repositories with one name stay apart. */
export function inboxProjectKey(name: string, root: string, hashLength = 6): string {
  const base = sanitizeTag(name) ?? "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, Math.min(hashLength, 64));
  return `${base}-${hash}`;
}

export class InboxStore {
  readonly dir: string;
  private seq = 0;
  private readonly latest = new Map<string, InboxLine>();
  private readonly projectsById = new Map<string, InboxProject>();
  private readonly projectsByRoot = new Map<string, InboxProject>();
  private readonly messages = new Map<string, InboxMessage>();
  /** The seq of a message's first line: its place in the event log. */
  private readonly messageSeq = new Map<string, number>();
  private readonly questions = new Map<string, InboxQuestionRecord>();
  /** Each message's question ids (a question's message never changes, so the index only grows). */
  private readonly messageQuestions = new Map<string, Set<string>>();
  /**
   * Thread routing, kept from each root's first line in seq order, so a
   * replay of the log gives the same answers: the newest unnamed root an
   * agent session started in a project (`<project>\0<session>`), and the
   * newest root of each thread name (`<project>\0<name key>`).
   */
  private readonly sessionThreads = new Map<string, string>();
  /** Each thread's message ids in seq order. */
  private readonly threadMembers = new Map<string, string[]>();
  /** Every root of each thread name in seq order (`<project>\0<name key>`). */
  private readonly namedThreads = new Map<string, string[]>();
  private readonly tornFiles = new Set<string>();
  private readonly listeners = new Set<InboxListener>();
  private readonly now: () => Date;

  private constructor(dataDir: string, now: () => Date) {
    this.dir = inboxDir(dataDir);
    this.now = now;
  }

  /** Read the store under `dataDir` (created owner-only when missing). */
  static open(dataDir: string, options: { now?: () => Date } = {}): InboxStore {
    const store = new InboxStore(dataDir, options.now ?? (() => new Date()));
    store.load();
    return store;
  }

  // ─────────────────────────── reading ───────────────────────────

  private load(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // Best effort (Windows, a filesystem without modes).
    }
    const projectsDir = join(this.dir, INBOX_PROJECTS_DIR);
    if (!existsSync(projectsDir)) return;
    const lines: InboxLine[] = [];
    for (const key of readdirSync(projectsDir)) {
      const folder = join(projectsDir, key);
      for (const name of [PROJECT_FILE, MESSAGES_FILE, QUESTIONS_FILE]) {
        const path = join(folder, name);
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        if (text.length > 0 && !text.endsWith("\n")) this.tornFiles.add(path);
        for (const raw of text.split("\n")) {
          const line = parseInboxLine(raw);
          if (line) lines.push(line);
        }
      }
    }
    lines.sort((a, b) => a.seq - b.seq);
    for (const line of lines) this.apply(line);
    this.repairUnsentAnswers();
  }

  /**
   * A Send writes its questions' "sent" lines before the reply line. When the
   * reply never landed (the process died, or the append failed), those
   * questions name a reply that does not exist: read them as picked again, so
   * the person can Send them, instead of "already sent" with nothing sent.
   * In memory only; the next pick or Send writes the corrected record.
   */
  private repairUnsentAnswers(): void {
    for (const record of this.questions.values()) {
      if (record.sent_reply_id === null || this.messages.has(record.sent_reply_id)) continue;
      this.restoreQuestion({ ...record, sent_revision: 0, sent_reply_id: null });
    }
  }

  /** Put a question record back in memory (and in the event log's current view) without writing. */
  private restoreQuestion(record: InboxQuestionRecord): void {
    this.questions.set(record.id, record);
    const key = `question:${record.id}`;
    const line = this.latest.get(key);
    if (line && line.kind === "question") this.latest.set(key, { ...line, record });
  }

  private apply(line: InboxLine): void {
    if (line.seq > this.seq) this.seq = line.seq;
    const id = `${line.kind}:${line.id}`;
    const previous = this.latest.get(id);
    if (previous && previous.seq > line.seq) return;
    this.latest.set(id, line);
    switch (line.kind) {
      case "project":
        this.projectsById.set(line.record.id, line.record);
        this.projectsByRoot.set(line.record.root, line.record);
        break;
      case "message":
        this.messages.set(line.record.id, line.record);
        if (!this.messageSeq.has(line.record.id)) {
          this.messageSeq.set(line.record.id, line.seq);
          const members = this.threadMembers.get(line.record.thread_id);
          if (members) members.push(line.record.id);
          else this.threadMembers.set(line.record.thread_id, [line.record.id]);
          this.indexRoot(line.record);
        }
        break;
      case "question": {
        this.questions.set(line.record.id, line.record);
        const ids = this.messageQuestions.get(line.record.message_id);
        if (ids) ids.add(line.record.id);
        else this.messageQuestions.set(line.record.message_id, new Set([line.record.id]));
        break;
      }
    }
  }

  /** Note a root's routing keys, from its first line only. */
  private indexRoot(message: InboxMessage): void {
    if (message.thread_id !== message.id || message.author.kind !== "agent") return;
    const name = message.thread_name ?? null;
    if (name !== null) {
      const key = `${message.project_id}\0${inboxThreadNameKey(name)}`;
      const roots = this.namedThreads.get(key);
      if (roots) roots.push(message.id);
      else this.namedThreads.set(key, [message.id]);
    } else if (message.author.session) {
      this.sessionThreads.set(`${message.project_id}\0${message.author.session}`, message.id);
    }
  }

  /**
   * The thread a message without reply_to joins, or null for a new thread:
   * with a `name`, the newest OPEN thread of that name in the project (one the
   * person reopened counts); else the newest unnamed thread the session
   * started there, while it is open (resolved means done, so the next message
   * starts anew). No session and no name: always a new thread.
   */
  private routeThread(projectId: string, session: string | null, name: string | null): string | null {
    if (name !== null) {
      const roots = this.namedThreads.get(`${projectId}\0${inboxThreadNameKey(name)}`) ?? [];
      for (let i = roots.length - 1; i >= 0; i--) if (!this.isResolved(roots[i]!)) return roots[i]!;
      return null;
    }
    const rootId = session ? this.sessionThreads.get(`${projectId}\0${session}`) : undefined;
    if (!rootId || this.isResolved(rootId)) return null;
    return rootId;
  }

  /** The highest seq written: the event-log cursor "now". */
  cursor(): number {
    return this.seq;
  }

  /** The current snapshot of every record changed after `cursor`, in seq order. */
  changesSince(cursor: number): InboxLine[] {
    const out: InboxLine[] = [];
    for (const line of this.latest.values()) if (line.seq > cursor) out.push(line);
    return out.sort((a, b) => a.seq - b.seq);
  }

  subscribe(listener: InboxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listProjects(): InboxProject[] {
    return [...this.projectsById.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  project(id: string): InboxProject | null {
    return this.projectsById.get(id) ?? null;
  }

  projectByRoot(root: string): InboxProject | null {
    return this.projectsByRoot.get(root) ?? null;
  }

  message(id: string): InboxMessage | null {
    return this.messages.get(id) ?? null;
  }

  /** The seq of a message's first line. */
  messageCursor(id: string): number | null {
    return this.messageSeq.get(id) ?? null;
  }

  /** A thread's messages in seq order (a message's thread never changes, so the index only grows). */
  private threadMessages(threadId: string): InboxMessage[] {
    return (this.threadMembers.get(threadId) ?? []).map((id) => this.messages.get(id)!);
  }

  private questionRecords(messageId: string): InboxQuestionRecord[] {
    const out: InboxQuestionRecord[] = [];
    for (const id of this.messageQuestions.get(messageId) ?? []) out.push(this.questions.get(id)!);
    return out.sort((a, b) => a.position - b.position);
  }

  private isResolved(threadId: string): boolean {
    return this.messages.get(threadId)?.resolved_at != null;
  }

  questionsOf(messageId: string): InboxQuestion[] {
    const message = this.messages.get(messageId);
    if (!message) return [];
    const resolved = this.isResolved(message.thread_id);
    return this.questionRecords(messageId).map((record) => toInboxQuestion(record, resolved));
  }

  private wire(message: InboxMessage): InboxMessageWire {
    const questions = this.questionsOf(message.id);
    return questions.length > 0 ? { ...message, questions } : { ...message };
  }

  messageWire(id: string): InboxMessageWire | null {
    const message = this.messages.get(id);
    return message ? this.wire(message) : null;
  }

  thread(threadId: string): InboxThread | null {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return null;
    const project = this.projectsById.get(root.project_id);
    if (!project) return null;
    return {
      thread_id: threadId,
      project,
      subject: root.subject,
      thread_name: root.thread_name ?? null,
      resolved_at: root.resolved_at,
      messages: this.threadMessages(threadId).map((m) => this.wire(m)),
    };
  }

  threadSummary(threadId: string): InboxThreadSummary | null {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return null;
    const messages = this.threadMessages(threadId);
    const last = messages[messages.length - 1] ?? root;
    const questions = messages.flatMap((m) => this.questionsOf(m.id));
    return {
      thread_id: threadId,
      project_id: root.project_id,
      subject: root.subject,
      author: root.author,
      created_at: root.created_at,
      last_at: last.created_at,
      last_author: last.author.kind,
      message_count: messages.length,
      resolved_at: root.resolved_at,
      questions: summarizeInboxQuestions(questions),
      waiting_on_person: root.resolved_at === null && last.author.kind === "agent",
    };
  }

  /** A project's threads, the newest activity first. */
  threadsOf(projectId: string): InboxThreadSummary[] {
    const out: InboxThreadSummary[] = [];
    for (const message of this.messages.values()) {
      if (message.project_id !== projectId || message.thread_id !== message.id) continue;
      const summary = this.threadSummary(message.id);
      if (summary) out.push(summary);
    }
    return out.sort((a, b) => b.last_at.localeCompare(a.last_at) || b.thread_id.localeCompare(a.thread_id));
  }

  /** One row of the list: the thread's summary, its project label and its section. */
  listRow(threadId: string): InboxListRow | null {
    const summary = this.threadSummary(threadId);
    if (!summary) return null;
    const root = this.messages.get(threadId)!;
    const project = this.projectsById.get(root.project_id);
    if (!project) return null;
    const messages = this.threadMessages(threadId);
    const seqOf = (m: InboxMessage) => this.messageSeq.get(m.id) ?? 0;
    let lastPersonSeq = 0;
    let waitingSince: string | null = null;
    for (const message of messages) {
      if (message.author.kind === "person") lastPersonSeq = seqOf(message);
      if (waitingSince === null && this.questionsOf(message.id).some((q) => q.state === "open" && !q.orphaned)) {
        waitingSince = message.created_at;
      }
    }
    // A reply of the person's is a look at everything before it.
    const seenSeq = Math.max(root.person_seen_seq ?? 0, lastPersonSeq);
    const unseen = messages.filter((m) => m.author.kind === "agent" && seqOf(m) > seenSeq).length;
    const last = messages[messages.length - 1] ?? root;
    const sent =
      last.author.kind === "person"
        ? { at: last.created_at, checked_at: (root.agent_checked_seq ?? 0) >= seqOf(last) ? (root.agent_checked_at ?? null) : null }
        : null;
    const facts = {
      ...summary,
      project: { id: project.id, name: project.name },
      thread_name: root.thread_name ?? null,
      answered_not_sent: root.resolved_at === null && summary.questions.open === 0 && summary.questions.picked > 0,
      waiting_since: waitingSince,
      unseen,
      sent,
    };
    const section = inboxSectionOf(facts);
    return { ...facts, section, unread: inboxRowUnread(section) };
  }

  /**
   * The list's rows, newest activity first: every thread, or one project's
   * (`projectId`), or the threads an agent session sent any message in
   * (`session`: the threads it started, joined or replied in).
   */
  listRows(filter: { projectId?: string | null; session?: string | null } = {}): InboxListRow[] {
    const out: InboxListRow[] = [];
    for (const [threadId, members] of this.threadMembers) {
      const root = this.messages.get(threadId);
      if (!root || root.thread_id !== threadId) continue;
      if (filter.projectId && root.project_id !== filter.projectId) continue;
      if (filter.session) {
        const session = filter.session;
        const took = members.some((id) => {
          const author = this.messages.get(id)?.author;
          return author?.kind === "agent" && author.session === session;
        });
        if (!took) continue;
      }
      const row = this.listRow(threadId);
      if (row) out.push(row);
    }
    return out.sort((a, b) => b.last_at.localeCompare(a.last_at) || b.thread_id.localeCompare(a.thread_id));
  }

  /** The list, placed in its sections; a project filter keeps the sections and drops other rows. */
  listSections(projectId?: string | null): InboxListSection[] {
    return inboxListSections(this.listRows({ projectId }));
  }

  /** The person looked at a thread: its agent messages so far are no longer new. No write when nothing is new. */
  markSeen(threadId: string): InboxListRow {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    // What listRow counts as seen: the last look, or the person's own last
    // reply. Only an agent message after both is new, so only then is a write due.
    let seen = root.person_seen_seq ?? 0;
    let latestAgent = 0;
    for (const id of this.threadMembers.get(threadId) ?? []) {
      const seq = this.messageSeq.get(id) ?? 0;
      if (this.messages.get(id)?.author.kind === "person") seen = Math.max(seen, seq);
      else latestAgent = Math.max(latestAgent, seq);
    }
    if (latestAgent > seen) {
      const at = this.stamp();
      this.appendMessage({ ...root, person_seen_seq: latestAgent }, at);
    }
    const row = this.listRow(threadId);
    if (!row) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    return row;
  }

  /**
   * An agent read the person's replies in a thread: read_thread read the
   * whole thread, or wait_for_reply returned one reply (`upToSeq`, that
   * reply's seq, so a later reply it was not given still reads as unread).
   * A Sent row moves to Quiet once its last reply is checked. No write when
   * there is no person reply it has not read.
   */
  markAgentChecked(threadId: string, upToSeq = Number.POSITIVE_INFINITY): void {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return;
    let checked = 0;
    for (const id of this.threadMembers.get(threadId) ?? []) {
      const seq = this.messageSeq.get(id) ?? 0;
      if (seq <= upToSeq && this.messages.get(id)?.author.kind === "person") checked = Math.max(checked, seq);
    }
    if (checked === 0 || (root.agent_checked_seq ?? 0) >= checked) return;
    const at = this.stamp();
    this.appendMessage({ ...root, agent_checked_seq: checked, agent_checked_at: at }, at);
  }

  // ─────────────────────────── writing ───────────────────────────

  private stamp(): string {
    return this.now().toISOString();
  }

  private write(file: string, line: InboxLine): void {
    const prefix = this.tornFiles.has(file) ? "\n" : "";
    try {
      appendFileSync(file, `${prefix}${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (error) {
      // A failed append may have left part of the line (disk full): the next
      // append starts on a fresh line so it cannot be glued to the fragment.
      this.tornFiles.add(file);
      throw error;
    }
    this.tornFiles.delete(file);
    this.apply(line);
    for (const listener of this.listeners) {
      try {
        listener(line);
      } catch {
        // A subscriber's failure never undoes a write or blocks the others.
      }
    }
  }

  private projectFolder(project: InboxProject): string {
    return join(this.dir, INBOX_PROJECTS_DIR, project.key);
  }

  private appendMessage(message: InboxMessage, at: string): void {
    const project = this.projectsById.get(message.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${message.project_id}.`);
    this.write(join(this.projectFolder(project), MESSAGES_FILE), {
      v: INBOX_RECORD_VERSION,
      seq: this.seq + 1,
      at,
      kind: "message",
      id: message.id,
      record: message,
    });
  }

  private appendQuestion(record: InboxQuestionRecord, at: string): void {
    const project = this.projectsById.get(record.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${record.project_id}.`);
    this.write(join(this.projectFolder(project), QUESTIONS_FILE), {
      v: INBOX_RECORD_VERSION,
      seq: this.seq + 1,
      at,
      kind: "question",
      id: record.id,
      record,
    });
  }

  /** The project for `root` (an absolute realpath), created on first use. */
  ensureProject(input: { name: string; root: string }): InboxProject {
    const existing = this.projectsByRoot.get(input.root);
    if (existing) return existing;
    const at = this.stamp();
    // Six hex of the root's hash keeps two same-named repositories apart; on
    // the rare collision take more of the hash, so one folder never holds two
    // projects (the second project.json would replace the first).
    const taken = new Set([...this.projectsById.values()].map((p) => p.key));
    let key = inboxProjectKey(input.name, input.root);
    const inUse = (candidate: string) => taken.has(candidate) || existsSync(join(this.dir, INBOX_PROJECTS_DIR, candidate));
    for (let length = 12; inUse(key) && length <= 64; length += 13) key = inboxProjectKey(input.name, input.root, length);
    if (inUse(key)) key = `${inboxProjectKey(input.name, input.root)}-${inboxId("prj").slice(-6).toLowerCase()}`;
    const project: InboxProject = {
      id: inboxId("prj"),
      key,
      name: input.name,
      root: input.root,
      created_at: at,
    };
    const folder = this.projectFolder(project);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const line: InboxLine = { v: INBOX_RECORD_VERSION, seq: this.seq + 1, at, kind: "project", id: project.id, record: project };
    // One line, written whole: temp file then rename.
    const path = join(folder, PROJECT_FILE);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    this.apply(line);
    for (const listener of this.listeners) {
      try {
        listener(line);
      } catch {
        // see write()
      }
    }
    return project;
  }

  /**
   * An agent's message. Where it lands (owner ruling 2026-10-07, "a row is a
   * thread"), first match wins:
   *  1. reply_to: that message's thread, as a reply to it (`thread` ignored);
   *  2. `thread`: the open thread of that name in the project, across
   *     sessions; a new thread under the name when there is none or it is
   *     resolved;
   *  3. otherwise: the session's open default (unnamed) thread in the
   *     project; a new one when it has none or its last one is resolved, or
   *     when the sender has no session.
   * A thread keeps its first message's subject. Routing reads only the
   * store's log, so a replay routes the same way.
   */
  sendMessage(input: InboxSendInput): InboxSendResult {
    const body = input.body;
    if (typeof body !== "string" || body.trim() === "") throw new InboxError("validation_error", "body: a message needs a body.", { field: "body" });
    let threadName: string | null = null;
    if (input.thread !== undefined && input.thread !== null && !input.reply_to) {
      const checked = checkInboxThreadName(input.thread);
      if (!checked.ok) throw new InboxError("validation_error", `thread: ${checked.message}`, { field: "thread" });
      threadName = checked.name;
    }
    let projectId = input.project_id;
    let threadId: string | null = null;
    let replyTo: string | null = null;
    if (input.reply_to) {
      const parent = this.messages.get(input.reply_to);
      if (!parent) throw new InboxError("message_not_found", `No message ${input.reply_to}.`, { field: "reply_to" });
      projectId = parent.project_id;
      threadId = parent.thread_id;
      replyTo = parent.id;
    }
    if (!this.projectsById.has(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);

    const key = input.idempotency_key?.trim() || null;
    if (key) {
      for (const message of this.messages.values()) {
        if (message.project_id !== projectId || message.idempotency_key !== key || message.author.kind !== "agent") continue;
        // A retry is the same call: the same body, reply target and thread
        // name (compared as routing compares names). The thread it joined
        // is the first call's, whatever the routing would say now.
        const sameName = inboxThreadNameKey(message.thread_name ?? "") === inboxThreadNameKey(threadName ?? "");
        if (message.body !== body || message.reply_to !== replyTo || !sameName) {
          throw new InboxError(
            "idempotency_key_reused",
            "This idempotency_key was already used for a different message.",
            { message_id: message.id },
          );
        }
        return { message: this.wire(message), replayed: true };
      }
    }

    if (!replyTo) threadId = this.routeThread(projectId, input.author.session, threadName);

    const at = this.stamp();
    const id = inboxId("msg");
    const parsed = parseInboxQuestionBlocks(body);
    const message: InboxMessage = {
      id,
      project_id: projectId,
      thread_id: threadId ?? id,
      reply_to: replyTo,
      author: input.author,
      subject: threadId ? null : (input.subject?.trim() || deriveInboxSubject(body, parsed)),
      body,
      created_at: at,
      resolved_at: null,
      idempotency_key: key,
      thread_name: threadName,
    };
    this.appendMessage(message, at);
    for (const question of parsed) {
      this.appendQuestion(
        {
          id: `${id}/${question.key}`,
          project_id: projectId,
          message_id: id,
          key: question.key,
          position: question.position,
          kind: question.kind,
          prompt: question.prompt,
          parsed: question.parsed,
          decision_on_answer: question.decision_on_answer,
          stopped: question.stopped,
          holds_up: question.holds_up,
          asked_by_agent_id: input.author.session,
          answer: null,
          revision: 0,
          sent_revision: 0,
          picked_by: null,
          picked_at: null,
          sent_reply_id: null,
          decision_id: null,
        },
        at,
      );
    }
    // A reply from the agent reopens nothing: a resolved thread stays resolved.
    return { message: this.wire(message), replayed: false };
  }

  private targetMessage(messageId: string): InboxMessage {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    if (this.isResolved(message.thread_id)) {
      throw new InboxError("thread_resolved", "This thread is resolved; reopen it to answer.");
    }
    return message;
  }

  /**
   * Check every entry against the message's questions and plan the new
   * records. Nothing is written unless every entry passes.
   */
  private planAnswers(
    message: InboxMessage,
    entries: readonly InboxAnswerEntry[],
    mode: "pick" | "send",
  ): { record: InboxQuestionRecord; answer: QuestionAnswer | null | undefined }[] {
    const records = new Map(this.questionRecords(message.id).map((r) => [r.key, r]));
    const seen = new Set<string>();
    const plan: { record: InboxQuestionRecord; answer: QuestionAnswer | null | undefined }[] = [];
    entries.forEach((entry, index) => {
      const field = `questions[${index}]`;
      if (!entry || typeof entry !== "object" || typeof entry.key !== "string") {
        throw new InboxError("validation_error", `${field}.key: required.`, { field: `${field}.key` });
      }
      if (seen.has(entry.key)) throw new InboxError("validation_error", `${field}.key: listed twice.`, { field: `${field}.key` });
      seen.add(entry.key);
      if (typeof entry.revision !== "number" || !Number.isInteger(entry.revision) || entry.revision < 0) {
        throw new InboxError("validation_error", `${field}.revision: a non-negative integer is required.`, { field: `${field}.revision` });
      }
      const record = records.get(entry.key);
      if (!record) throw refusalError({ code: "question_not_found", key: entry.key });
      if (record.revision !== entry.revision) {
        throw refusalError({ code: "question_revision_conflict", key: entry.key, current_revision: record.revision });
      }
      let answer: QuestionAnswer | null | undefined;
      if (entry.answer === null) {
        if (mode === "send") throw new InboxError("validation_error", `${field}.answer: a Send cannot clear a pick.`, { field: `${field}.answer` });
        answer = null;
      } else if (entry.answer === undefined) {
        if (mode === "pick") throw new InboxError("validation_error", `${field}.answer: a pick needs an answer (or null to clear).`, { field: `${field}.answer` });
        if (record.answer === null) throw new InboxError("validation_error", `${field}.answer: nothing is picked for ${entry.key}.`, { field: `${field}.answer` });
        if (record.sent_revision === record.revision) throw refusalError({ code: "question_already_sent", key: entry.key });
        answer = undefined;
      } else {
        const checked = checkInboxAnswer(record, entry.answer, `${field}.answer`);
        if (!checked.ok) throw refusalError(checked.refusal);
        answer = checked.answer;
      }
      plan.push({ record, answer });
    });
    return plan;
  }

  /** Save picks at once (no reply is written): each revision goes up by one. */
  savePicks(messageId: string, entries: readonly InboxAnswerEntry[]): InboxQuestion[] {
    const message = this.targetMessage(messageId);
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new InboxError("validation_error", "questions: at least one question is required.", { field: "questions" });
    }
    const plan = this.planAnswers(message, entries, "pick");
    const at = this.stamp();
    for (const { record, answer } of plan) {
      this.appendQuestion(
        {
          ...record,
          answer: answer ?? null,
          revision: record.revision + 1,
          picked_by: answer ? INBOX_PERSON : null,
          picked_at: answer ? at : null,
        },
        at,
      );
    }
    return this.questionsOf(messageId);
  }

  /**
   * The person's Send: optional words plus the listed questions' answers,
   * written as ONE reply in the thread. Replaying the same idempotency key on
   * the same message answers the reply it wrote, and writes nothing.
   */
  sendReply(messageId: string, input: InboxReplyInput): InboxReplyResult {
    const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a Send.", { field: "idempotency_key" });
    const existingMessage = this.messages.get(messageId);
    if (existingMessage) {
      for (const message of this.messages.values()) {
        if (message.reply_to === messageId && message.author.kind === "person" && message.idempotency_key === key) {
          return { reply: message, questions: this.questionsOf(messageId), replayed: true };
        }
      }
    }
    const message = this.targetMessage(messageId);
    const entries = input.questions ?? [];
    if (!Array.isArray(entries)) throw new InboxError("validation_error", "questions: must be a list.", { field: "questions" });
    const words = typeof input.words === "string" ? input.words : "";
    const plan = this.planAnswers(message, entries, "send");
    if (plan.length === 0 && words.trim() === "") {
      throw new InboxError("validation_error", "words: write a reply or send at least one answer.", { field: "words" });
    }

    const replyId = inboxId("msg");
    const at = this.stamp();
    const sentKeys = new Set(plan.map((p) => p.record.key));
    const updated = plan.map(({ record, answer }) => {
      const nextAnswer = answer === undefined ? record.answer : answer;
      const revision = answer === undefined ? record.revision : record.revision + 1;
      return {
        ...record,
        answer: nextAnswer,
        revision,
        sent_revision: revision,
        sent_reply_id: replyId,
        ...(answer === undefined ? {} : { picked_by: INBOX_PERSON, picked_at: at }),
      } satisfies InboxQuestionRecord;
    });
    const all = this.questionRecords(message.id);
    const earlier = all
      .filter((r) => !sentKeys.has(r.key) && r.answer !== null && r.sent_revision > 0 && r.sent_revision === r.revision)
      .map((r) => r.answer as QuestionAnswer);
    const body = composeInboxReplyBody({
      questions: all,
      sent: updated.map((r) => r.answer as QuestionAnswer),
      earlier,
      words,
    });

    // The questions first, so whoever reads the reply finds them already sent.
    // If any of these writes fails, the questions written so far are put back
    // as they were (on disk, repairUnsentAnswers does the same at the next
    // start), so a failed Send never leaves answers "sent" with no reply.
    const reply: InboxMessage = {
      id: replyId,
      project_id: message.project_id,
      thread_id: message.thread_id,
      reply_to: message.id,
      author: { kind: "person" },
      subject: null,
      body,
      created_at: at,
      resolved_at: null,
      idempotency_key: key,
    };
    try {
      for (const record of updated) this.appendQuestion(record, at);
      this.appendMessage(reply, at);
    } catch (error) {
      for (const { record } of plan) this.restoreQuestion(record);
      throw error;
    }
    return { reply, questions: this.questionsOf(message.id), replayed: false };
  }

  /** Resolve (or reopen) the thread a message belongs to. */
  resolveThread(messageId: string, resolved: boolean): InboxThreadSummary {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    const root = this.messages.get(message.thread_id);
    if (!root) throw new InboxError("message_not_found", `No thread ${message.thread_id}.`);
    const isResolved = root.resolved_at !== null;
    if (isResolved !== resolved) {
      const at = this.stamp();
      this.appendMessage({ ...root, resolved_at: resolved ? at : null }, at);
    }
    return this.threadSummary(root.id)!;
  }
}
