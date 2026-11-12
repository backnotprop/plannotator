/**
 * Test-only: an Inbox on JSONL files holding the old record shapes today's reader still accepts, made the way the
 * store's own tests make them: a generated Inbox written through today's write paths (`../../world.ts`), then lines
 * patched back into what an older release wrote, each patch naming the test that holds that shape; plus the lines
 * the reader skips or only counts, a repeated line, a line with an older seq written late, and a torn last line.
 *
 * Shapes covered (release first written, and where today's reader maps them):
 * - Cards: step 1 (0.28.26, old column ids, `prs` and no `refs`, no `cols`/`moved_by`/`notes`/`sent`), the next
 *   format (0.28.32, `asked` renamed `backlog`, refs without `via`), v2 before Done's rename (`shipped`), lines
 *   without `done_prs` and without `initiative` (kept from the line before): `readInboxCard`, `cardAfter`.
 * - Questions: the decision fields of 0.28.8–0.28.23, choices from before picture choices (no image, pros, cons),
 *   records without `superseded_by`, `set_aside`, `action` or `attachment`, and a Send whose reply never landed
 *   (reads as picked again: `repairUnsentAnswers`).
 * - Messages: the step-1 record (0.28.7, none of the later fields), a person-started root from before `named_by`
 *   (0.28.21), a settled 👍 without `note_id` (before 0.28.23).
 * - Annotations without `guide`, `message` or `live`; a steps list that fails its check (`steps: [null]`); a
 *   project from before display names and combining, and one whose `merged_into` is not a project.
 * - An old `decisions.jsonl` (only its seqs count), a `kind: "decision"` line, lines `parseInboxLine` skips.
 */
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxLine } from "@plannotator/core/inbox-types";
import { ANNOTATIONS_FILE, CARDS_FILE, INBOX_PROJECTS_DIR, MESSAGES_FILE, PROJECT_FILE, QUESTIONS_FILE, STEPS_FILE } from "../../../schema";
import { jsonlInboxLog } from "../../jsonl-log";
import { writeInboxWorld } from "../../world";

type Line = { v: number; seq: number; at: string; kind: string; id: string; record: Record<string, any> };

const readLines = (file: string): Line[] => {
  try {
    return readFileSync(file, "utf8").split("\n").filter((raw) => raw.trim()).map((raw) => JSON.parse(raw) as Line);
  } catch {
    return [];
  }
};
const writeLines = (file: string, lines: Line[]) => writeFileSync(file, lines.length ? `${lines.map((l) => JSON.stringify(l)).join("\n")}\n` : "");

/** Today's card columns as the two formats before v2 named them (`store-cards.test.ts`, "cards written before v2"). */
const STEP1_COLUMN: Record<string, string> = { backlog: "icebox", todo: "asked", in_progress: "building", in_review: "your_review", done: "shipped", dropped: "dropped" };
const V1_COLUMN: Record<string, string> = { backlog: "backlog", todo: "backlog", in_progress: "designing", in_review: "your_look", done: "shipped", dropped: "dropped" };

/** Fields a message gained after the step-1 record (0.28.7, `store.ts` at 56d0a03f7): the old record has none of them. */
const LATER_MESSAGE_FIELDS = [
  "thread_name", "person_seen_seq", "agent_checked_seq", "agent_checked_at", "attachments", "delivery", "to", "guide", "base_path",
  "supersedes", "subject_question", "person_read_seq", "person_read_at", "set_aside", "wakes", "started_by_person", "inline_images",
  "ack", "named_by", "ack_of", "tags", "reask", "handoff", "tidy", "launch",
];

/** Write the old-shape Inbox under `dataDir`. Returns the clock its stores read. */
export function writeOldShapeInbox(dataDir: string): { now: () => Date } {
  const world = writeInboxWorld({ dataDir, seed: 41, steps: 320 });
  const inbox = join(dataDir, "inbox");
  const projects = readdirSync(join(inbox, INBOX_PROJECTS_DIR));
  let top = world.store.cursor();
  const at = world.now().toISOString();

  projects.forEach((key, p) => {
    const folder = join(inbox, INBOX_PROJECTS_DIR, key);

    // Cards: one era per card, by its order in the file.
    const cards = readLines(join(folder, CARDS_FILE));
    const era = new Map<string, number>();
    for (const line of cards) if (!era.has(line.id)) era.set(line.id, era.size % 5);
    for (const line of cards) {
      const r = line.record;
      switch (era.get(line.id)) {
        case 0: // Step 1 (`store-cards.test.ts` "cards written before v2" and "a record from step 1 (prs, no refs)").
          r.column = STEP1_COLUMN[r.column] ?? r.column;
          if (r.aside_from) r.aside_from = STEP1_COLUMN[r.aside_from] ?? r.aside_from;
          for (const k of ["cols", "moved_by", "notes", "sent", "refs", "done_prs", "initiative"]) delete r[k];
          break;
        case 1: // 0.28.32: `backlog`, notes, sent, refs without `via` (the "released-format line" test).
          r.column = V1_COLUMN[r.column] ?? r.column;
          if (r.aside_from) r.aside_from = V1_COLUMN[r.aside_from] ?? r.aside_from;
          for (const k of ["cols", "moved_by", "done_prs", "initiative"]) delete r[k];
          for (const ref of r.refs ?? []) delete ref.via;
          break;
        case 2: // v2 before Done's rename ("a v2 line from before Done's rename").
          if (r.column === "done") r.column = "shipped";
          if (r.aside_from === "done") r.aside_from = "shipped";
          break;
        case 3: // Before done_prs ("a line from before done_prs").
          delete r.done_prs;
          break;
      }
    }
    // An older Inbox wrote over a card that had an initiative (`store-initiatives.test.ts`): the field is absent.
    const withInitiative = cards.filter((l) => l.record.initiative);
    const last = withInitiative.at(-1);
    if (last) {
      const { initiative: _gone, ...older } = last.record;
      cards.push({ ...last, seq: ++top, at, record: older });
    }
    writeLines(join(folder, CARDS_FILE), cards);

    // Questions.
    const questions = readLines(join(folder, QUESTIONS_FILE));
    questions.forEach((line, i) => {
      const r = line.record;
      if (i % 4 === 0) Object.assign(r, { decision_on_answer: true, decision_id: null, decision_recording: false, decision_draft: null }); // store-legacy-decisions.test.ts
      if (i % 4 === 1 && r.parsed) {
        // Before picture choices (`store-question-contract.test.ts`, records frozen at e36db4209).
        for (const k of ["stakes", "shows", "why", "reversible", "prototype"]) delete r.parsed[k];
        for (const choice of r.parsed.choices ?? []) for (const k of ["image", "pros", "cons", "prototype"]) delete choice[k];
      }
      if (i % 4 === 2) for (const k of ["superseded_by", "set_aside", "action", "action_result", "attachment"]) if (!r[k]) delete r[k];
    });
    // A Send whose reply never landed (`repairUnsentAnswers`): the question's sent line names a reply that is not there.
    const picked = questions.filter((l) => l.record.answer && l.record.sent_reply_id === null).at(-1);
    if (picked) questions.push({ ...picked, seq: ++top, at, record: { ...picked.record, sent_revision: picked.record.revision, sent_reply_id: "msg_01NEVERLANDED0000000000000" } });
    // A retried append: the same line twice.
    if (questions[1]) questions.push(questions[1]);
    writeLines(join(folder, QUESTIONS_FILE), questions);

    // Messages.
    const messages = readLines(join(folder, MESSAGES_FILE));
    const roots = [...new Set(messages.filter((l) => l.record.id === l.record.thread_id).map((l) => l.id))];
    const step1 = new Set(roots.filter((_, i) => i % 6 === 0));
    for (const line of messages) {
      const r = line.record;
      if (step1.has(r.thread_id)) for (const k of LATER_MESSAGE_FIELDS) delete r[k]; // the step-1 record
      if (r.started_by_person) delete r.named_by; // 0.28.21: before named_by
      if (r.ack) delete r.ack.note_id; // `store-ack-delivery.test.ts`: a settled 👍 with no note
    }
    // A retried append, and an older seq written late (a lower-seq line the replay ignores).
    if (messages[2]) messages.push(messages[2]);
    if (messages[3]) messages.push({ ...messages[3], record: { ...messages[3].record, body: "A late line with an older seq." }, seq: messages[3].seq - 1 > 0 ? messages[3].seq - 1 : 1 });
    writeLines(join(folder, MESSAGES_FILE), messages);
    // Lines the reader skips: an old decision line, a seq of 0, a record whose id is not the line's, not JSON.
    appendFileSync(
      join(folder, MESSAGES_FILE),
      [
        JSON.stringify({ v: 1, seq: ++top, at, kind: "decision", id: "dec_01", record: { id: "dec_01" } }),
        JSON.stringify({ v: 1, seq: 0, at, kind: "message", id: "msg_zero", record: { id: "msg_zero" } }),
        JSON.stringify({ v: 1, seq: ++top, at, kind: "message", id: "msg_a", record: { id: "msg_b" } }),
        "not json",
        "",
      ].join("\n"),
    );

    // Annotations from before guides, message comments and live sites.
    const annotations = readLines(join(folder, ANNOTATIONS_FILE));
    for (const line of annotations) for (const k of ["guide", "message", "live"]) delete line.record[k];
    writeLines(join(folder, ANNOTATIONS_FILE), annotations);

    // A malformed steps list (`store-steps.test.ts`): ignored, the list before it stays.
    const steps = readLines(join(folder, STEPS_FILE));
    if (steps[0]) appendFileSync(join(folder, STEPS_FILE), `${JSON.stringify({ ...steps[0], seq: ++top, at, record: { ...steps[0].record, steps: [null] } })}\n`);

    // Projects: from before display names and combining; one with a `merged_into` that is not a project
    // (`store-project-combine.test.ts`).
    const project = readLines(join(folder, PROJECT_FILE));
    for (const line of project) for (const k of ["display_name", "separated_from"]) delete line.record[k];
    if (p === 0 && project[0]) project.push({ ...project[0], seq: ++top, at, record: { ...project.at(-1)!.record, merged_into: 42 } });
    writeLines(join(folder, PROJECT_FILE), project);

    // An old decisions file (`store-legacy-decisions.test.ts`): never applied, its seqs still count.
    if (p === 0) {
      const decision = { id: "dec_01", project_id: project[0]!.id, text: "Postgres.", reason: null, source: { kind: "answer", question_id: "q", message_id: "m", thread_id: "m", agent: null }, state: "current", version: 1, replaces_id: null, replacement_id: null, created_at: at, changed_at: null, idempotency_key: null };
      writeFileSync(join(folder, "decisions.jsonl"), `${JSON.stringify({ v: 1, seq: top + 50, at, kind: "decision", id: "dec_01", record: decision })}\n`);
    }
  });
  top += 50;

  // A torn last line, as a crash leaves it.
  appendFileSync(join(inbox, INBOX_PROJECTS_DIR, projects[0]!, MESSAGES_FILE), `{"v":1,"seq":${top + 1},"at":"${at}","kind":"message","id":"msg_torn","rec`);
  return { now: world.now };
}

/** The old-shape Inbox's lines as today's reader reads them (for the writers' own comparison). */
export function oldShapeLines(): InboxLine[] {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-old-shapes-"));
  try {
    writeOldShapeInbox(dataDir);
    return jsonlInboxLog(join(dataDir, "inbox")).read().lines!;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
