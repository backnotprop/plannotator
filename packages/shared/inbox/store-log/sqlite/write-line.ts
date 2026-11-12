/**
 * One store line into the SQLite tables, inside the caller's transaction: its `events` row (the change log, kept
 * as history), then the current row of its record (`messages`, `questions`, the Board's tables…) with the columns
 * a query will need, its thread's list facts, the person's read state, the message's attachments and tags, a
 * question's answer, the actors who wrote them, and the facts that come from the order of lines (`../history.ts`),
 * worked out here against the record's previous row, so a start reads them instead of replaying the log.
 *
 * A line older than its record's current row (an import of out-of-order files) is kept in `events` only, as the
 * store's replay ignores it.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
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
import * as t from "./schema";

export type InboxDb = SQLiteBunDatabase;
type Tx = Parameters<Parameters<InboxDb["transaction"]>[0]>[0];
export type InboxDbWriter = InboxDb | Tx;

/** The actor row for the local person or an agent session, made on first sight. */
export function actorOf(db: InboxDbWriter, who: InboxAuthor | { kind: "person" }, at: string): string {
  const kind = who.kind === "agent" ? "agent_session" : "person";
  const host = who.kind === "agent" ? (who.host ?? "") : "";
  const session = who.kind === "agent" ? (who.session ?? "") : "";
  const found = db.select({ id: t.actors.id }).from(t.actors).where(and(eq(t.actors.kind, kind), eq(t.actors.host, host), eq(t.actors.session, session))).get();
  if (found) return found.id;
  const id = `act_${ulid()}`;
  db.insert(t.actors)
    .values({ id, kind, host, session, name: who.kind === "agent" ? who.name : null, created_at: at })
    .run();
  return id;
}

/** The thread a line belongs to, for a deletion (messages, annotations, steps, PRs carry it on the record). */
function threadOf(line: InboxLine): string | null {
  switch (line.kind) {
    case "message":
    case "annotation":
    case "steps":
    case "thread_pull":
      return line.record.thread_id;
    default:
      return null;
  }
}

function projectOf(line: InboxLine): string | null {
  if (line.kind === "project") return line.record.id;
  if (line.kind === "initiative") return null;
  return line.record.project_id;
}

/** The table that holds a kind's current rows. */
function tableOf(kind: InboxLine["kind"]) {
  switch (kind) {
    case "project":
      return t.projects;
    case "message":
      return t.messages;
    case "question":
      return t.questions;
    case "annotation":
      return t.annotations;
    case "card":
      return t.cards;
    case "steps":
      return t.steps;
    case "thread_pull":
      return t.threadPulls;
    case "initiative":
      return t.initiatives;
  }
}

/** A string field of a record that may be an old or broken shape (steps, PRs), or null. */
const field = (record: unknown, key: string): string | null => {
  const value = (record as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : null;
};

export function writeLine(db: InboxDbWriter, line: InboxLine): void {
  const data = JSON.stringify(line.record);
  const table = tableOf(line.kind);
  const row = db.select({ seq: table.seq }).from(table).where(eq(table.id, line.id)).get();
  // The record's latest line lives once, in `events`; its current row only points at it by seq.
  const current = row ? { seq: row.seq, record: latestData(db, line.kind, line.id, row.seq) } : undefined;
  const actor = line.kind === "message" ? actorOf(db, line.record.author, line.at) : line.kind === "question" && line.record.picked_by ? actorOf(db, { kind: "person" }, line.at) : null;
  // Typing goes over the row before it: history keeps each change of choice, never each key. Removed before this
  // line's row goes in, so a repeated line (the same seq twice) keeps one row, not none.
  if (line.kind === "question" && current && current.seq <= line.seq && continuesTyping(JSON.parse(current.record) as InboxQuestionRecord, line.record)) {
    db.delete(t.events).where(and(eq(t.events.seq, current.seq), eq(t.events.kind, "question"), eq(t.events.subject_id, line.id))).run();
  }
  db.insert(t.events)
    .values({
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
    })
    .run();
  if (current && current.seq > line.seq) return;
  const seq = line.seq;
  const first = { first_seq: seq };
  switch (line.kind) {
    case "project": {
      const r = line.record;
      const row = { key: r.key, root: r.root, name: r.name, seq, deleted_at: null };
      db.insert(t.projects).values({ id: r.id, ...first, ...row }).onConflictDoUpdate({ target: t.projects.id, set: row }).run();
      return;
    }
    case "message":
      writeMessage(db, line.record, current ? (JSON.parse(current.record) as InboxMessage) : undefined, seq, line.at, actor!);
      return;
    case "question":
      writeQuestion(db, line.record, seq, line.at, actor);
      return;
    case "annotation": {
      const r = line.record;
      const row = { thread_id: r.thread_id, project_id: r.project_id, seq };
      db.insert(t.annotations).values({ id: r.id, ...first, ...row }).onConflictDoUpdate({ target: t.annotations.id, set: row }).run();
      return;
    }
    case "card": {
      const before = current ? db.select({ card: t.cards.card, heard_seq: t.cards.heard_seq }).from(t.cards).where(eq(t.cards.id, line.id)).get() : undefined;
      const { card, heard } = cardAfter(before ? (JSON.parse(before.card) as InboxCard) : undefined, line.record);
      const row = { project_id: line.record.project_id, seq, card: JSON.stringify(card), heard_seq: heard || !before ? seq : before.heard_seq };
      db.insert(t.cards).values({ id: line.record.id, ...first, ...row }).onConflictDoUpdate({ target: t.cards.id, set: row }).run();
      return;
    }
    case "steps": {
      const row = { thread_id: field(line.record, "thread_id"), project_id: field(line.record, "project_id"), seq };
      db.insert(t.steps).values({ id: line.id, ...first, ...row }).onConflictDoUpdate({ target: t.steps.id, set: row }).run();
      return;
    }
    case "thread_pull": {
      const r = line.record;
      if (isInboxThreadPullRecord(r)) {
        const prev = current ? (JSON.parse(current.record) as unknown) : undefined;
        const event = pullEventOf(isInboxThreadPullRecord(prev) ? (prev as InboxThreadPull) : undefined, r, seq);
        if (event) db.insert(t.threadPullEvents).values({ seq, thread_id: r.thread_id, project_id: r.project_id, event: JSON.stringify(event) }).run();
      }
      const row = { thread_id: field(r, "thread_id"), project_id: field(r, "project_id"), seq };
      db.insert(t.threadPulls).values({ id: line.id, ...first, ...row }).onConflictDoUpdate({ target: t.threadPulls.id, set: row }).run();
      return;
    }
    case "initiative": {
      const row = { seq };
      db.insert(t.initiatives).values({ id: line.record.id, ...first, ...row }).onConflictDoUpdate({ target: t.initiatives.id, set: row }).run();
      return;
    }
  }
}

/** The record a current row points at: the last `events` row of that record at its seq (a repeated line is two rows). */
function latestData(db: InboxDbWriter, kind: InboxLine["kind"], id: string, seq: number): string {
  const found = db
    .select({ data: t.events.data })
    .from(t.events)
    .where(and(eq(t.events.kind, kind), eq(t.events.subject_id, id), eq(t.events.seq, seq)))
    .orderBy(desc(t.events.id))
    .get();
  if (!found) throw new Error(`events: no ${kind} line for ${id} at seq ${seq}`);
  return found.data;
}

function writeMessage(db: InboxDbWriter, m: InboxMessage, prev: InboxMessage | undefined, seq: number, at: string, authorId: string): void {
  const row = { thread_id: m.thread_id, project_id: m.project_id, reply_to: m.reply_to, author_id: authorId, created_at: m.created_at, seq, subject: m.subject, body: m.body };
  db.insert(t.messages)
    .values({ id: m.id, first_seq: seq, ...row })
    .onConflictDoUpdate({ target: t.messages.id, set: row })
    .run();
  const root = m.id === m.thread_id;
  if (!prev) {
    // A message's first line: the name it gives its thread, and its hashtags, at this seq.
    const named = firstLineName(m);
    if (named) db.insert(t.threadNames).values({ root_id: m.id, seq, project_id: m.project_id, name: named.name, routes: named.routes }).run();
    for (const tag_key of firstLineTagKeys(m)) db.insert(t.messageTags).values({ message_id: m.id, tag_key, thread_id: m.thread_id, project_id: m.project_id, seq }).run();
  } else if (root && agentNamesHere(prev, m)) {
    db.insert(t.threadNames).values({ root_id: m.id, seq, project_id: m.project_id, name: m.thread_name!, routes: true }).run();
  }
  const had = root && prev ? (db.select({ resolved_seq: t.threads.resolved_seq }).from(t.threads).where(eq(t.threads.id, m.id)).get()?.resolved_seq ?? null) : null;
  const rootFacts = root ? { resolved_seq: archiveSeqAfter(prev?.resolved_at, had, m, seq), ...(movesAddress(prev, m) ? { readdressed: true } : {}) } : {};
  db.insert(t.threads)
    .values({ id: m.thread_id, project_id: m.project_id, thread_name: root ? (m.thread_name ?? null) : null, resolved_at: root ? m.resolved_at : null, first_seq: seq, last_seq: seq, last_at: at, message_count: 1, seq, ...rootFacts })
    .onConflictDoUpdate({
      target: t.threads.id,
      set: {
        last_seq: seq,
        last_at: at,
        seq,
        message_count: prev ? sql`${t.threads.message_count}` : sql`${t.threads.message_count} + 1`,
        ...(root ? { project_id: m.project_id, thread_name: m.thread_name ?? null, resolved_at: m.resolved_at, ...rootFacts } : {}),
      },
    })
    .run();
  if (root) {
    const person = actorOf(db, { kind: "person" }, at);
    const read = { seen_seq: m.person_seen_seq ?? null, read_seq: m.person_read_seq ?? null, read_at: m.person_read_at ?? null, seq };
    db.insert(t.readState)
      .values({ thread_id: m.id, actor_id: person, ...read })
      .onConflictDoUpdate({ target: [t.readState.thread_id, t.readState.actor_id], set: read })
      .run();
  }
  db.delete(t.attachments).where(eq(t.attachments.message_id, m.id)).run();
  for (const a of m.attachments ?? []) {
    db.insert(t.attachments)
      .values({ id: a.id, message_id: m.id, name: a.name, kind: a.kind, size: a.size ?? null, sha256: a.sent_sha256, created_at: a.sent_at || null })
      .onConflictDoNothing()
      .run();
  }
  db.delete(t.mentions).where(eq(t.mentions.message_id, m.id)).run();
  (m.tags ?? []).forEach((tag, position) => {
    const target = actorOf(db, { kind: "agent", host: tag.host, session: tag.session, name: tag.name ?? null }, at);
    db.insert(t.mentions)
      .values({ message_id: m.id, position, target_actor_id: target, label: tag.label ?? null, wakes: tag.wakes })
      .run();
  });
}

function writeQuestion(db: InboxDbWriter, q: InboxQuestionRecord, seq: number, at: string, personId: string | null): void {
  const thread = db.select({ thread_id: t.messages.thread_id }).from(t.messages).where(eq(t.messages.id, q.message_id)).get();
  const existing = db.select({ id: t.answers.id }).from(t.answers).where(eq(t.answers.question_id, q.id)).get();
  let answerId: string | null = existing?.id ?? null;
  // The person's answer: one row, updated in place as they pick; withdrawn when the pick is taken back.
  if (q.answer !== null || existing) {
    const author = personId ?? actorOf(db, { kind: "person" }, at);
    const state = q.answer === null ? "withdrawn" : q.sent_reply_id !== null && q.sent_revision === q.revision ? "sent" : "picked";
    const row = { answer: q.answer === null ? null : JSON.stringify(q.answer), revision: q.revision, state, sent_reply_id: q.sent_reply_id, updated_at: q.picked_at ?? at, seq } as const;
    answerId ??= `ans_${ulid()}`;
    db.insert(t.answers)
      .values({ id: answerId, question_id: q.id, author_id: author, created_at: q.picked_at ?? at, ...row })
      .onConflictDoUpdate({ target: t.answers.id, set: row })
      .run();
  }
  const row = {
    message_id: q.message_id,
    thread_id: thread?.thread_id ?? null,
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
  db.insert(t.questions).values({ id: q.id, first_seq: seq, ...row }).onConflictDoUpdate({ target: t.questions.id, set: row }).run();
}
