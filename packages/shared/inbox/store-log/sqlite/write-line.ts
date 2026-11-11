/**
 * One store line into the SQLite tables, inside the caller's transaction: its `events` row (the change log the
 * store replays at start), then the current row of its record (`messages`, `questions`, the Board's tables…)
 * with the columns a query will need, its thread's list facts, the person's read state, the message's
 * attachments and tags, a question's answer, and the actors who wrote them.
 */
import { and, eq, sql } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { ulid, type InboxAuthor, type InboxLine, type InboxMessage, type InboxQuestionRecord } from "@plannotator/core/inbox-types";
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

export function writeLine(db: InboxDbWriter, line: InboxLine): void {
  const data = JSON.stringify(line.record);
  const actor = line.kind === "message" ? actorOf(db, line.record.author, line.at) : line.kind === "question" && line.record.picked_by ? actorOf(db, { kind: "person" }, line.at) : null;
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
  const seq = line.seq;
  switch (line.kind) {
    case "project": {
      const r = line.record;
      const row = { key: r.key, root: r.root, name: r.name, record: data, seq, deleted_at: null };
      db.insert(t.projects).values({ id: r.id, ...row }).onConflictDoUpdate({ target: t.projects.id, set: row }).run();
      return;
    }
    case "message":
      writeMessage(db, line.record, data, seq, line.at, actor!);
      return;
    case "question":
      writeQuestion(db, line.record, data, seq, line.at, actor);
      return;
    case "annotation": {
      const r = line.record;
      const row = { thread_id: r.thread_id, project_id: r.project_id, seq, record: data };
      db.insert(t.annotations).values({ id: r.id, ...row }).onConflictDoUpdate({ target: t.annotations.id, set: row }).run();
      return;
    }
    case "card": {
      const row = { project_id: line.record.project_id, seq, record: data };
      db.insert(t.cards).values({ id: line.record.id, ...row }).onConflictDoUpdate({ target: t.cards.id, set: row }).run();
      return;
    }
    case "steps": {
      const r = line.record;
      const row = { thread_id: r.thread_id, project_id: r.project_id, seq, record: data };
      db.insert(t.steps).values({ id: r.id, ...row }).onConflictDoUpdate({ target: t.steps.id, set: row }).run();
      return;
    }
    case "thread_pull": {
      const r = line.record;
      const row = { thread_id: r.thread_id, project_id: r.project_id, seq, record: data };
      db.insert(t.threadPulls).values({ id: r.id, ...row }).onConflictDoUpdate({ target: t.threadPulls.id, set: row }).run();
      return;
    }
    case "initiative": {
      const row = { seq, record: data };
      db.insert(t.initiatives).values({ id: line.record.id, ...row }).onConflictDoUpdate({ target: t.initiatives.id, set: row }).run();
      return;
    }
  }
}

function writeMessage(db: InboxDbWriter, m: InboxMessage, data: string, seq: number, at: string, authorId: string): void {
  const before = db.select({ first_seq: t.messages.first_seq }).from(t.messages).where(eq(t.messages.id, m.id)).get();
  const row = { thread_id: m.thread_id, project_id: m.project_id, reply_to: m.reply_to, author_id: authorId, created_at: m.created_at, seq, subject: m.subject, body: m.body, record: data };
  db.insert(t.messages)
    .values({ id: m.id, first_seq: seq, ...row })
    .onConflictDoUpdate({ target: t.messages.id, set: row })
    .run();
  const root = m.id === m.thread_id;
  db.insert(t.threads)
    .values({ id: m.thread_id, project_id: m.project_id, thread_name: root ? (m.thread_name ?? null) : null, resolved_at: root ? m.resolved_at : null, first_seq: seq, last_seq: seq, last_at: at, message_count: 1, seq })
    .onConflictDoUpdate({
      target: t.threads.id,
      set: {
        last_seq: seq,
        last_at: at,
        seq,
        message_count: before ? sql`${t.threads.message_count}` : sql`${t.threads.message_count} + 1`,
        ...(root ? { project_id: m.project_id, thread_name: m.thread_name ?? null, resolved_at: m.resolved_at } : {}),
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
      .values({ message_id: m.id, position, target_actor_id: target, label: tag.label ?? null, wakes: tag.wakes, record: JSON.stringify(tag) })
      .run();
  });
}

function writeQuestion(db: InboxDbWriter, q: InboxQuestionRecord, data: string, seq: number, at: string, personId: string | null): void {
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
    record: data,
  };
  db.insert(t.questions).values({ id: q.id, ...row }).onConflictDoUpdate({ target: t.questions.id, set: row }).run();
}
