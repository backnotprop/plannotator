/**
 * Each line of a JSONL Inbox, in seq order, gives the rows `write-line.ts` would leave, kept in memory so the
 * database is written in one pass. Insert and update follow Drizzle: a value left `undefined` takes the column's
 * default on insert and leaves the column as it was on update.
 */
import {
  isInboxThreadPullRecord,
  ulid,
  type InboxAuthor,
  type InboxCard,
  type InboxLine,
  type InboxMessage,
  type InboxQuestionRecord,
  type InboxThreadPull,
} from "@plannotator/core/inbox-types";
import { agentNamesHere, archiveSeqAfter, cardAfter, continuesTyping, firstLineName, firstLineTagKeys, movesAddress, pullEventOf } from "../history";

/** Column name to value; `undefined` means "not given". */
export type ImportRow = Record<string, string | number | null | undefined>;

/** One table's rows by key, in first-insert order. */
class Keyed {
  readonly rows = new Map<string, ImportRow>();
  constructor(private readonly defaults: ImportRow = {}) {}

  get(key: string): ImportRow | undefined {
    return this.rows.get(key);
  }

  upsert(key: string, values: ImportRow, set: ImportRow): ImportRow {
    const found = this.rows.get(key);
    if (!found) {
      const row: ImportRow = { ...this.defaults };
      for (const column in values) if (values[column] !== undefined) row[column] = values[column];
      this.rows.set(key, row);
      return row;
    }
    for (const column in set) if (set[column] !== undefined) found[column] = set[column];
    return found;
  }
}

/** A string field of a record that may be an old or broken shape (steps, PRs), or null. */
const field = (record: unknown, key: string): string | null => {
  const value = (record as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : null;
};

const bool = (value: boolean | undefined | null): number | null | undefined => (value === undefined ? undefined : value === null ? null : value ? 1 : 0);

function threadOf(line: InboxLine): string | null {
  switch (line.kind) {
    case "message":
    case "annotation":
    case "steps":
    case "thread_pull":
      return line.record.thread_id ?? null;
    default:
      return null;
  }
}

function projectOf(line: InboxLine): string | null {
  if (line.kind === "project") return line.record.id;
  if (line.kind === "initiative") return null;
  return line.record.project_id ?? null;
}

export class ImportRows {
  readonly actors = new Keyed();
  /** In write order; a typing line written over the one before it leaves a hole (`null`). */
  readonly events: (ImportRow | null)[] = [];
  readonly projects = new Keyed({ deleted_at: null });
  readonly messages = new Keyed({ reply_to: null, via_actor_id: null, subject: null });
  readonly threads = new Keyed({ thread_name: null, resolved_at: null, resolved_seq: null, readdressed: 0, deleted_at: null });
  readonly readState = new Keyed();
  readonly attachments = new Map<string, Keyed>();
  readonly mentions = new Map<string, ImportRow[]>();
  readonly questions = new Keyed({ thread_id: null, current_answer_id: null, sent_reply_id: null, asked_by_actor_id: null });
  readonly answers = new Keyed({ via_actor_id: null, answer: null, sent_reply_id: null });
  readonly annotations = new Keyed();
  readonly cards = new Keyed();
  readonly steps = new Keyed({ thread_id: null, project_id: null });
  readonly threadPulls = new Keyed({ thread_id: null, project_id: null });
  readonly threadPullEvents: ImportRow[] = [];
  readonly initiatives = new Keyed();
  readonly threadNames: ImportRow[] = [];
  readonly messageTags: ImportRow[] = [];

  private readonly latest = new Map<string, unknown>();
  private readonly questionEvents = new Map<string, number[]>();
  private readonly threadNameKeys = new Set<string>();

  private table(kind: InboxLine["kind"]): Keyed {
    switch (kind) {
      case "project":
        return this.projects;
      case "message":
        return this.messages;
      case "question":
        return this.questions;
      case "annotation":
        return this.annotations;
      case "card":
        return this.cards;
      case "steps":
        return this.steps;
      case "thread_pull":
        return this.threadPulls;
      case "initiative":
        return this.initiatives;
    }
  }

  private actorOf(who: InboxAuthor | { kind: "person" }, at: string): string {
    const kind = who.kind === "agent" ? "agent_session" : "person";
    const host = who.kind === "agent" ? (who.host ?? "") : "";
    const session = who.kind === "agent" ? (who.session ?? "") : "";
    const key = `${kind}\0${host}\0${session}`;
    const found = this.actors.get(key);
    if (found) return found.id as string;
    const id = `act_${ulid()}`;
    this.actors.upsert(key, { id, kind, host, session, name: who.kind === "agent" ? who.name : null, created_at: at }, {});
    return id;
  }

  add(line: InboxLine): void {
    const data = JSON.stringify(line.record);
    const table = this.table(line.kind);
    const current = table.get(line.id);
    const recordKey = `${line.kind}\0${line.id}`;
    const actor =
      line.kind === "message" ? this.actorOf(line.record.author, line.at) : line.kind === "question" && line.record.picked_by ? this.actorOf({ kind: "person" }, line.at) : null;
    // Typing goes over the row before it: history keeps each change of choice, never each key.
    const typing =
      line.kind === "question" && current && (current.seq as number) <= line.seq && continuesTyping(this.latest.get(recordKey) as InboxQuestionRecord, line.record);
    if (typing) {
      const eventKey = `${line.id}\0${current.seq}`;
      for (const at of this.questionEvents.get(eventKey) ?? []) this.events[at] = null;
      this.questionEvents.delete(eventKey);
    }
    if (line.kind === "question") {
      const eventKey = `${line.id}\0${line.seq}`;
      const list = this.questionEvents.get(eventKey);
      if (list) list.push(this.events.length);
      else this.questionEvents.set(eventKey, [this.events.length]);
    }
    this.events.push({
      id: this.events.length + 1,
      seq: line.seq,
      at: line.at,
      v: line.v,
      kind: line.kind,
      subject_id: line.id,
      project_id: projectOf(line),
      thread_id: threadOf(line),
      message_id: line.kind === "question" ? line.record.message_id : null,
      actor_id: actor,
      data,
    });
    if (current && (current.seq as number) > line.seq) return;
    const prev = current ? this.latest.get(recordKey) : undefined;
    this.latest.set(recordKey, line.record);
    const seq = line.seq;
    switch (line.kind) {
      case "project": {
        const r = line.record;
        const row = { key: r.key, root: r.root, name: r.name, seq, deleted_at: null };
        this.projects.upsert(r.id, { id: r.id, first_seq: seq, ...row }, row);
        return;
      }
      case "message":
        this.message(line.record, prev as InboxMessage | undefined, seq, line.at, actor!);
        return;
      case "question":
        this.question(line.record, seq, line.at, actor);
        return;
      case "annotation": {
        const r = line.record;
        const row = { thread_id: r.thread_id, project_id: r.project_id, seq };
        this.annotations.upsert(r.id, { id: r.id, first_seq: seq, ...row }, row);
        return;
      }
      case "card": {
        const before = current ? { card: current.card as string, heard_seq: current.heard_seq as number } : undefined;
        const { card, heard } = cardAfter(before ? (JSON.parse(before.card) as InboxCard) : undefined, line.record);
        const row = { project_id: line.record.project_id, seq, card: JSON.stringify(card), heard_seq: heard || !before ? seq : before.heard_seq };
        this.cards.upsert(line.record.id, { id: line.record.id, first_seq: seq, ...row }, row);
        return;
      }
      case "steps": {
        const row = { thread_id: field(line.record, "thread_id"), project_id: field(line.record, "project_id"), seq };
        this.steps.upsert(line.id, { id: line.id, first_seq: seq, ...row }, row);
        return;
      }
      case "thread_pull": {
        const r = line.record;
        if (isInboxThreadPullRecord(r)) {
          const event = pullEventOf(isInboxThreadPullRecord(prev) ? (prev as InboxThreadPull) : undefined, r, seq);
          if (event) this.threadPullEvents.push({ id: this.threadPullEvents.length + 1, seq, thread_id: r.thread_id, project_id: r.project_id, event: JSON.stringify(event) });
        }
        const row = { thread_id: field(r, "thread_id"), project_id: field(r, "project_id"), seq };
        this.threadPulls.upsert(line.id, { id: line.id, first_seq: seq, ...row }, row);
        return;
      }
      case "initiative": {
        const row = { seq };
        this.initiatives.upsert(line.record.id, { id: line.record.id, first_seq: seq, ...row }, row);
        return;
      }
    }
  }

  private nameRow(row: ImportRow): void {
    const key = `${row.root_id}\0${row.seq}`;
    // Fails as the live insert would on the primary key.
    if (this.threadNameKeys.has(key)) throw new Error(`thread_names: ${row.root_id} named twice at seq ${row.seq}`);
    this.threadNameKeys.add(key);
    this.threadNames.push(row);
  }

  private message(m: InboxMessage, prev: InboxMessage | undefined, seq: number, at: string, authorId: string): void {
    const row = { thread_id: m.thread_id, project_id: m.project_id, reply_to: m.reply_to, author_id: authorId, created_at: m.created_at, seq, subject: m.subject, body: m.body };
    this.messages.upsert(m.id, { id: m.id, first_seq: seq, ...row }, row);
    const root = m.id === m.thread_id;
    if (!prev) {
      const named = firstLineName(m);
      if (named) this.nameRow({ root_id: m.id, seq, project_id: m.project_id, name: named.name, routes: named.routes ? 1 : 0 });
      for (const tag_key of firstLineTagKeys(m)) this.messageTags.push({ message_id: m.id, tag_key, thread_id: m.thread_id, project_id: m.project_id, seq });
    } else if (root && agentNamesHere(prev, m)) {
      this.nameRow({ root_id: m.id, seq, project_id: m.project_id, name: m.thread_name!, routes: 1 });
    }
    const had = root && prev ? ((this.threads.get(m.id)?.resolved_seq as number | null | undefined) ?? null) : null;
    const rootFacts: ImportRow = root ? { resolved_seq: archiveSeqAfter(prev?.resolved_at, had, m, seq), ...(movesAddress(prev, m) ? { readdressed: 1 } : {}) } : {};
    const thread = this.threads.get(m.thread_id);
    this.threads.upsert(
      m.thread_id,
      { id: m.thread_id, project_id: m.project_id, thread_name: root ? (m.thread_name ?? null) : null, resolved_at: root ? m.resolved_at : null, first_seq: seq, last_seq: seq, last_at: at, message_count: 1, seq, ...rootFacts },
      {
        last_seq: seq,
        last_at: at,
        seq,
        message_count: thread ? (thread.message_count as number) + (prev ? 0 : 1) : undefined,
        ...(root ? { project_id: m.project_id, thread_name: m.thread_name ?? null, resolved_at: m.resolved_at, ...rootFacts } : {}),
      },
    );
    if (root) {
      const person = this.actorOf({ kind: "person" }, at);
      const read = { seen_seq: m.person_seen_seq ?? null, read_seq: m.person_read_seq ?? null, read_at: m.person_read_at ?? null, seq };
      this.readState.upsert(m.id, { thread_id: m.id, actor_id: person, ...read }, read);
    }
    const attachments = new Keyed({ size: null, created_at: null });
    for (const a of m.attachments ?? []) {
      // ON CONFLICT DO NOTHING: the first of two with one id stays.
      if (!attachments.get(a.id)) attachments.upsert(a.id, { id: a.id, message_id: m.id, name: a.name, kind: a.kind, size: a.size ?? null, sha256: a.sent_sha256, created_at: a.sent_at || null }, {});
    }
    this.attachments.set(m.id, attachments);
    this.mentions.set(
      m.id,
      (m.tags ?? []).map((tag, position) => ({
        message_id: m.id,
        position,
        target_actor_id: this.actorOf({ kind: "agent", host: tag.host, session: tag.session, name: tag.name ?? null }, at),
        label: tag.label ?? null,
        wakes: bool(tag.wakes) ?? null,
      })),
    );
  }

  private question(q: InboxQuestionRecord, seq: number, at: string, personId: string | null): void {
    const thread = this.messages.get(q.message_id);
    const existing = this.answers.get(q.id);
    let answerId = (existing?.id as string | undefined) ?? null;
    if (q.answer !== null || existing) {
      const author = personId ?? this.actorOf({ kind: "person" }, at);
      const state = q.answer === null ? "withdrawn" : q.sent_reply_id !== null && q.sent_revision === q.revision ? "sent" : "picked";
      const row = { answer: q.answer === null ? null : JSON.stringify(q.answer), revision: q.revision, state, sent_reply_id: q.sent_reply_id, updated_at: q.picked_at ?? at, seq };
      answerId ??= `ans_${ulid()}`;
      this.answers.upsert(q.id, { id: answerId, question_id: q.id, author_id: author, created_at: q.picked_at ?? at, ...row }, row);
    }
    const row = {
      message_id: q.message_id,
      thread_id: (thread?.thread_id as string | undefined) ?? null,
      project_id: q.project_id,
      key: q.key,
      kind: q.kind,
      prompt: q.prompt,
      revision: q.revision,
      sent_revision: q.sent_revision,
      current_answer_id: answerId,
      sent_reply_id: q.sent_reply_id,
      asked_by_actor_id: null,
      seq,
    };
    this.questions.upsert(q.id, { id: q.id, first_seq: seq, ...row }, row);
  }
}
