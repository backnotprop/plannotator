/**
 * The Inbox's SQLite schema (Drizzle; design brief "The Inbox on SQLite", section 2). Not used by anyone yet:
 * only `sqlite-log.ts` opens it, and only when a test hands the store that log.
 *
 * Every table keeps today's full record as JSON (`record`) beside its columns, so a read can serve exactly
 * what it serves today; columns exist for what a query needs (by thread, by project, by seq). Ids are today's
 * prefixed ULIDs. `seq` is the store's one change counter. A deleted thread keeps a tombstone in `threads`
 * (id and `deleted_at`, no words); its messages, questions and the rest are really removed, as today.
 *
 * A start reads current state from these tables, never the change log: each record table has its latest line
 * (`seq`, joined to `events` for its time) and its first line's seq (`first_seq`, the order the store's maps keep),
 * and what the store works out from the ORDER of lines (`../history.ts`) is kept as it happens: a thread's archive
 * line and moved address (`threads`), the names that route (`thread_names`), first-line hashtags (`message_tags`),
 * a card as the Board reads it and its last real change (`cards`), PR adds and removes (`thread_pull_events`).
 *
 * `events` is the ordered change log: one row per line the store writes (a run of typing on a question is one
 * row, its last), kept as history: a card's History reads it, and later the decision history and what a publish
 * outbox reads. `meta` holds the seq floor (the highest seq ever handed out, kept across a deletion).
 *
 * Changing this file: `bunx drizzle-kit generate` (config `drizzle.config.ts` beside it) writes the next
 * migration under `migrations/`; `migrations.ts` imports each one as text so the compiled binary carries it.
 */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Key-value facts about the database: `seq_floor`. */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Who did something: the local person (one row), an agent session, later a phone, a linked machine or a
 * person from Workspaces (`external_ref`). `person_id`: the person an agent session or device acts for.
 */
export const actors = sqliteTable(
  "actors",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["person", "agent_session", "machine", "phone", "remote_person"] }).notNull(),
    host: text("host").notNull().default(""),
    session: text("session").notNull().default(""),
    name: text("name"),
    person_id: text("person_id"),
    external_ref: text("external_ref"),
    created_at: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("actors_identity").on(t.kind, t.host, t.session)],
);

export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey(),
    at: text("at").notNull(),
    v: integer("v").notNull(),
    kind: text("kind").notNull(),
    subject_id: text("subject_id").notNull(),
    project_id: text("project_id"),
    /** The thread a deletion removes this row with (messages, annotations, steps, PRs). */
    thread_id: text("thread_id"),
    /** A question's message: a deletion removes the questions of the thread's messages. */
    message_id: text("message_id"),
    actor_id: text("actor_id"),
    /** The record as written (JSON). */
    data: text("data").notNull(),
  },
  (t) => [index("events_subject").on(t.kind, t.subject_id), index("events_project").on(t.project_id), index("events_thread").on(t.thread_id), index("events_message").on(t.message_id)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    root: text("root").notNull(),
    name: text("name").notNull(),
    record: text("record").notNull(),
    first_seq: integer("first_seq").notNull(),
    seq: integer("seq").notNull(),
    deleted_at: text("deleted_at"),
  },
  (t) => [index("projects_key").on(t.key), index("projects_seq").on(t.seq)],
);

/** One row per thread (its root message's id): list facts, then a tombstone once deleted. */
export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id").notNull(),
    thread_name: text("thread_name"),
    resolved_at: text("resolved_at"),
    /** The archive line: the seq of the root line that set the current `resolved_at` (`archiveSeqAfter`). */
    resolved_seq: integer("resolved_seq"),
    /** A thread the person started whose address moved ("Send to another session", `movesAddress`). */
    readdressed: integer("readdressed", { mode: "boolean" }).notNull().default(false),
    first_seq: integer("first_seq").notNull(),
    last_seq: integer("last_seq").notNull(),
    last_at: text("last_at").notNull(),
    message_count: integer("message_count").notNull(),
    seq: integer("seq").notNull(),
    deleted_at: text("deleted_at"),
  },
  (t) => [index("threads_project").on(t.project_id), index("threads_last").on(t.last_seq), index("threads_seq").on(t.seq)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    thread_id: text("thread_id").notNull(),
    project_id: text("project_id").notNull(),
    reply_to: text("reply_to"),
    author_id: text("author_id").notNull(),
    via_actor_id: text("via_actor_id"),
    created_at: text("created_at").notNull(),
    first_seq: integer("first_seq").notNull(),
    seq: integer("seq").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    record: text("record").notNull(),
  },
  (t) => [index("messages_thread").on(t.thread_id, t.first_seq), index("messages_seq").on(t.seq)],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").notNull(),
    message_id: text("message_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    size: integer("size"),
    sha256: text("sha256").notNull(),
    created_at: text("created_at"),
  },
  (t) => [primaryKey({ columns: [t.message_id, t.id] }), index("attachments_sha").on(t.sha256)],
);

/** Who a message tags (today: agent sessions, `InboxMessage.tags`; later people). */
export const mentions = sqliteTable(
  "mentions",
  {
    message_id: text("message_id").notNull(),
    position: integer("position").notNull(),
    target_actor_id: text("target_actor_id").notNull(),
    label: text("label"),
    wakes: integer("wakes", { mode: "boolean" }),
    record: text("record").notNull(),
  },
  (t) => [primaryKey({ columns: [t.message_id, t.position] }), index("mentions_target").on(t.target_actor_id)],
);

/** A thread's read state, per person (today only the local person, off the root message's fields). */
export const readState = sqliteTable(
  "read_state",
  {
    thread_id: text("thread_id").notNull(),
    actor_id: text("actor_id").notNull(),
    seen_seq: integer("seen_seq"),
    read_seq: integer("read_seq"),
    read_at: text("read_at"),
    seq: integer("seq").notNull(),
  },
  (t) => [primaryKey({ columns: [t.thread_id, t.actor_id] })],
);

export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(),
    message_id: text("message_id").notNull(),
    thread_id: text("thread_id"),
    project_id: text("project_id").notNull(),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    prompt: text("prompt").notNull(),
    revision: integer("revision").notNull(),
    sent_revision: integer("sent_revision").notNull(),
    current_answer_id: text("current_answer_id"),
    sent_reply_id: text("sent_reply_id"),
    asked_by_actor_id: text("asked_by_actor_id"),
    first_seq: integer("first_seq").notNull(),
    seq: integer("seq").notNull(),
    record: text("record").notNull(),
  },
  (t) => [index("questions_message").on(t.message_id), index("questions_thread").on(t.thread_id), index("questions_seq").on(t.seq)],
);

/**
 * Answers: many per question, each with its author. Today one per question, the local person's
 * (`questions.current_answer_id`), updated in place as they pick; later another person's is another row.
 */
export const answers = sqliteTable(
  "answers",
  {
    id: text("id").primaryKey(),
    question_id: text("question_id").notNull(),
    author_id: text("author_id").notNull(),
    via_actor_id: text("via_actor_id"),
    answer: text("answer"),
    revision: integer("revision").notNull(),
    state: text("state", { enum: ["picked", "sent", "withdrawn"] }).notNull(),
    sent_reply_id: text("sent_reply_id"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    seq: integer("seq").notNull(),
  },
  (t) => [uniqueIndex("answers_author").on(t.question_id, t.author_id), index("answers_seq").on(t.seq)],
);

/**
 * The Board's cards, initiatives, steps, PRs and the person's annotations: columns, the record, its first and
 * latest seq. A steps or PR record the store does not read (an old or broken shape) is still kept, as the JSONL
 * keeps its line, so its columns may be empty.
 */
export const cards = sqliteTable(
  "cards",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id").notNull(),
    first_seq: integer("first_seq").notNull(),
    seq: integer("seq").notNull(),
    /** The latest line as written. */
    record: text("record").notNull(),
    /** The card as the Board reads it (`cardAfter`: old shapes mapped, fields an older Inbox left out kept). */
    card: text("card").notNull(),
    /** The seq of the card's last real change (a drop's seen mark is not one): the Board's unread rule. */
    heard_seq: integer("heard_seq").notNull(),
  },
  (t) => [index("cards_project").on(t.project_id), index("cards_seq").on(t.seq)],
);

export const initiatives = sqliteTable(
  "initiatives",
  { id: text("id").primaryKey(), first_seq: integer("first_seq").notNull(), seq: integer("seq").notNull(), record: text("record").notNull() },
  (t) => [index("initiatives_seq").on(t.seq)],
);

export const steps = sqliteTable(
  "steps",
  { id: text("id").primaryKey(), thread_id: text("thread_id"), project_id: text("project_id"), first_seq: integer("first_seq").notNull(), seq: integer("seq").notNull(), record: text("record").notNull() },
  (t) => [index("steps_thread").on(t.thread_id), index("steps_project").on(t.project_id), index("steps_seq").on(t.seq)],
);

export const threadPulls = sqliteTable(
  "thread_pulls",
  { id: text("id").primaryKey(), thread_id: text("thread_id"), project_id: text("project_id"), first_seq: integer("first_seq").notNull(), seq: integer("seq").notNull(), record: text("record").notNull() },
  (t) => [index("thread_pulls_thread").on(t.thread_id), index("thread_pulls_project").on(t.project_id), index("thread_pulls_seq").on(t.seq)],
);

/** Each PR add or remove (`pullEventOf`), at its line's seq: a thread's PR history. A state line is no event. */
export const threadPullEvents = sqliteTable(
  "thread_pull_events",
  { seq: integer("seq").primaryKey(), thread_id: text("thread_id").notNull(), project_id: text("project_id").notNull(), event: text("event").notNull() },
  (t) => [index("thread_pull_events_thread").on(t.thread_id), index("thread_pull_events_project").on(t.project_id)],
);

export const annotations = sqliteTable(
  "annotations",
  { id: text("id").primaryKey(), thread_id: text("thread_id").notNull(), project_id: text("project_id").notNull(), first_seq: integer("first_seq").notNull(), seq: integer("seq").notNull(), record: text("record").notNull() },
  (t) => [index("annotations_thread").on(t.thread_id), index("annotations_seq").on(t.seq)],
);

/**
 * Thread names, in the order they were taken (`seq`): a root's first-line name (`firstLineName`; an agent's
 * routes, one the person gave only holds the name) and the line where an agent named a thread the person
 * started (`agentNamesHere`, routes). Routing reads them oldest first.
 */
export const threadNames = sqliteTable(
  "thread_names",
  {
    root_id: text("root_id").notNull(),
    seq: integer("seq").notNull(),
    project_id: text("project_id").notNull(),
    name: text("name").notNull(),
    routes: integer("routes", { mode: "boolean" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.root_id, t.seq] }), index("thread_names_project").on(t.project_id), index("thread_names_seq").on(t.seq)],
);

/** The hashtags of each message's first line (`firstLineTagKeys`), at its seq: the Board's `#` tags. */
export const messageTags = sqliteTable(
  "message_tags",
  {
    message_id: text("message_id").notNull(),
    tag_key: text("tag_key").notNull(),
    thread_id: text("thread_id").notNull(),
    project_id: text("project_id").notNull(),
    seq: integer("seq").notNull(),
  },
  (t) => [primaryKey({ columns: [t.message_id, t.tag_key] }), index("message_tags_thread").on(t.thread_id), index("message_tags_project").on(t.project_id), index("message_tags_seq").on(t.seq)],
);
