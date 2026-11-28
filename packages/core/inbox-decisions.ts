/**
 * Export decisions (design brief "export-decisions", 2026-11-10): one thread's decisions as the `plannotator.decisions`
 * v1 shape, which the Markdown and HTML documents (decision-export-md.ts, decision-export-html.ts) are drawn from.
 *
 * Nothing here decides a question's fate on its own: each record goes through Decision data's `decisionRowOf`, so a
 * thread's "decided" matches Settings -> Decision data on the same store; the answer is the wire's
 * (`toInboxQuestion`, canonical labels), and "took the recommendation" is the reply's own rule
 * (`inboxAnswerTookRecommendation`).
 *
 * Every question card is in it with its state (the owner, 2026-11-10), action items aside. What is never in it:
 * attachments, a link back to the Inbox, localhost or tailnet addresses, local file paths (a home folder in prose
 * becomes `~`), session ids and machine names (an agent is its host's name). Pictures are opaque refs; only the HTML
 * embeds their bytes.
 *
 * Published as `@plannotator/core/inbox-decisions`: the shape's types, `DECISION_EXPORT_FORMAT` and the pure builder
 * (records in, the v1 shape out), nothing else. The rules it runs on are `inbox-decision-rules.ts`, which is not in
 * core's `exports`. Plannotator's own imports go through `@plannotator/shared/inbox/decision-export`. Browser-safe.
 */
import { inboxAnswerTookRecommendation, toInboxQuestion } from "./inbox-questions";
import type { InboxMessage, InboxQuestionRecord } from "./inbox-types";
import { agentLabel, DECISION_EXPORT_OTHER_STATES, decisionExportZone, decisionRowOf, iso, ms, nameOnly, oneLine, ownWordsTime, scrubDecisionText, STATE_OF_FATE } from "./inbox-decision-rules";

// ── A question card's state ──

/**
 * Every question card's state in the export ("Everything, with each question's state"). `decided` is Decision data's
 * "answered" (a question sent with an answer), so its count matches Settings -> Decision data; the rest are Decision
 * data's other fates, except that an open or archived question the person answered with a plain reply after it was
 * asked (Decision data's "settled in words") is `answered_in_words`. Action items are never in it.
 */
export type DecisionExportState = "decided" | "picked_unsent" | "answered_in_words" | "open" | "skipped" | "set_aside" | "archived" | "replaced";

// ── The v1 shape ──

export const DECISION_EXPORT_FORMAT = "plannotator.decisions";

export interface DecisionExportPicture {
  alt: string;
  /** A key into the document's `images`; never a path. */
  ref: string;
}

export interface DecisionExportChoice {
  label: string;
  description?: string;
  recommended: boolean;
  chosen: boolean;
  /** Already ticked by the agent (`- [x]`). */
  settled?: true;
  pros?: string[];
  cons?: string[];
  /** A `Prototype:` page, by its name only. */
  prototype?: string;
  image?: DecisionExportPicture;
}

export interface DecisionExportItem {
  n: number;
  id: string;
  state: DecisionExportState;
  kind: "single" | "multi" | "text";
  prompt: string;
  context?: string;
  stakes?: string;
  why?: string;
  reversible?: { value: false; why: string | null };
  holds_up?: string[];
  /** `Shows:`: a picture, or a file by its name. */
  shows?: { label: string; image?: DecisionExportPicture };
  prototype?: string;
  choices: DecisionExportChoice[];
  recommendation: { labels: string[]; text: string | null; taken: boolean | null };
  /** The person's answer: sent (`sent: true`), or a pick they saved and did not send (`picked_unsent`). Null for none. */
  answer: { selected: string[]; other: string | null; text: string | null; note: string | null; skipped: boolean; sent: boolean } | null;
  asked: { by: string; at: string; message_id: string };
  answered?: { at: string | null; sent_at: string | null };
  replaces?: { id: string; prompt: string; asked_at: string | null }[];
  /** On a replaced question: what replaced it, or null when the agent withdrew it with nothing in its place. */
  replaced_by?: { id: string; prompt: string | null } | null;
}

export interface DecisionExportV1 {
  format: typeof DECISION_EXPORT_FORMAT;
  v: 1;
  exported_at: string;
  tz: string;
  generator: string;
  thread: { id: string; subject: string; project: string | null; started_at: string | null; last_at: string | null };
  pulls: { ref: string; url: string; title: string | null }[];
  counts: Record<DecisionExportState, number>;
  /** The decisions (state `decided`), D1…Dn in the order asked. */
  decisions: DecisionExportItem[];
  /** Every other question card, grouped by state in `DECISION_EXPORT_OTHER_STATES` order, each group in the order asked. */
  others: DecisionExportItem[];
  /** ref -> `data:` URI (HTML and JSON only; filled by the server, `withPictures`). */
  images: Record<string, string>;
}

/** What the store hands over (`InboxStore.decisionExportInput`). */
export interface DecisionExportInput {
  thread: { id: string; subject: string | null; project: string | null };
  messages: readonly InboxMessage[];
  byId: ReadonlyMap<string, InboxMessage>;
  headOf: (projectId: string) => string;
  closedByArchive: (message: InboxMessage) => boolean;
  questions: readonly InboxQuestionRecord[];
}

export interface DecisionExportOptions {
  now: Date;
  /** The reader's IANA zone (checked: an unknown one is UTC). */
  tz: string;
  generator: string;
  pulls: readonly { ref: string; url: string; title: string | null }[];
  /** The home folder to write as `~` (the server's `os.homedir()`). */
  home?: string | null;
}

/** A picture to read for the HTML: the message whose body names it, and its src as written. */
export interface DecisionExportPictureSource {
  ref: string;
  message_id: string;
  src: string;
}

// ── The builder ──

/**
 * The thread's export, and the pictures it names (for the server to read into `images`). Every fate comes from
 * `decisionRowOf`; questions are numbered in the order they were asked (message time, then place in the message).
 */
export function buildDecisionExport(input: DecisionExportInput, options: DecisionExportOptions): { doc: DecisionExportV1; pictures: DecisionExportPictureSource[] } {
  const home = options.home ?? null;
  const clean = (text: string) => scrubDecisionText(text, home);
  const pictures: DecisionExportPictureSource[] = [];
  const picture = (message: InboxMessage, record: InboxQuestionRecord, src: string, alt: string): DecisionExportPicture => {
    const ref = `p${pictures.length + 1}`;
    // A question inside an attached file names its pictures from that file: not read, the alt text shows.
    if (!record.attachment) pictures.push({ ref, message_id: message.id, src });
    return { alt: clean(oneLine(alt)) || nameOnly(src) || "picture", ref };
  };

  const rows = input.questions
    .map((record) => ({ record, row: decisionRowOf(record, input.byId, input.headOf, input.closedByArchive) }))
    .filter((entry): entry is { record: InboxQuestionRecord; row: NonNullable<typeof entry.row> } => entry.row !== null)
    // Stable: a message's questions keep the store's place order.
    .sort((a, b) => a.row.asked_at - b.row.asked_at);

  // What each question replaced: the replaced record names its replacement.
  const replacedBy = new Map<string, { id: string; prompt: string; asked_at: string | null }[]>();
  for (const { record, row } of rows) {
    const by = record.superseded_by;
    if (!by?.key) continue;
    const target = `${by.message_id}/${by.key}`;
    const list = replacedBy.get(target) ?? [];
    list.push({ id: record.id, prompt: clean(oneLine(record.prompt)), asked_at: iso(row.asked_at) });
    replacedBy.set(target, list);
  }

  // The person's own words in the thread, as times (Decision data's rule): an open or archived question asked before
  // one of them was answered in words.
  const carried = new Set(input.questions.flatMap((q) => (q.sent_reply_id ? [q.sent_reply_id] : [])));
  const wordsAt = input.messages.map((m) => ownWordsTime(m, carried)).filter((at): at is number => at !== null);
  const byRecordId = new Map(input.questions.map((q) => [q.id, q]));
  const replacementOf = (record: InboxQuestionRecord): { id: string; prompt: string | null } | null => {
    const by = record.superseded_by;
    if (!by?.key) return null;
    const id = `${by.message_id}/${by.key}`;
    const next = byRecordId.get(id);
    return { id, prompt: next ? clean(oneLine(next.prompt)) : null };
  };
  const stateOf = (row: (typeof rows)[number]["row"]): DecisionExportState => {
    const state = STATE_OF_FATE[row.fate];
    return (state === "open" || state === "archived") && wordsAt.some((at) => at > row.asked_at) ? "answered_in_words" : state;
  };

  const counts = Object.fromEntries((["decided", ...DECISION_EXPORT_OTHER_STATES] as DecisionExportState[]).map((state) => [state, 0])) as Record<DecisionExportState, number>;
  const staged = rows.map((entry) => ({ ...entry, state: entry.record.answered_in_reply ? ("answered_in_words" as const) : stateOf(entry.row) }));
  // Numbered across the groups: the decisions first (D1…Dn), then each group in its order, each in the order asked.
  const sequence = [staged.filter((e) => e.state === "decided"), ...DECISION_EXPORT_OTHER_STATES.map((state) => staged.filter((e) => e.state === state))].flat();
  const decisions: DecisionExportItem[] = [];
  const others: DecisionExportItem[] = [];
  sequence.forEach(({ state, record, row }, index) => {
    const message = input.byId.get(record.message_id)!;
    const facts = record.parsed;
    // Sent: an answered or skipped fate is one the agent received. A Mark read's answer is the Inbox's own skip, not the person's.
    const sent = row.fate === "answered" || row.fate === "skipped";
    const wire = record.answer && row.fate !== "set_aside" ? toInboxQuestion(record, false).answer : null;
    const selected = new Set(wire?.selected ?? []);
    const labels = facts.choices.filter((c) => c.recommended).map((c) => clean(c.label));
    const recText = labels.length > 0 ? null : (facts.recommendation ?? facts.suggested_text ?? null);
    const offered = labels.length > 0 || recText !== null;
    const item: DecisionExportItem = {
      n: index + 1,
      id: record.id,
      state,
      kind: record.kind === "multi" ? "multi" : record.kind === "text" ? "text" : "single",
      prompt: clean(oneLine(record.prompt)),
      ...(facts.context ? { context: clean(facts.context) } : {}),
      ...(facts.stakes ? { stakes: clean(facts.stakes) } : {}),
      ...(facts.why ? { why: clean(facts.why) } : {}),
      ...(facts.reversible ? { reversible: { value: false as const, why: facts.reversible.why === null ? null : clean(facts.reversible.why) } } : {}),
      ...(record.holds_up.length > 0 ? { holds_up: record.holds_up.map(clean) } : {}),
      ...(facts.shows
        ? {
            shows:
              facts.shows.kind === "image"
                ? { label: clean(facts.shows.label || nameOnly(facts.shows.src)), image: picture(message, record, facts.shows.src, facts.shows.label) }
                : { label: clean(facts.shows.label || nameOnly(facts.shows.src)) || nameOnly(facts.shows.src) },
          }
        : {}),
      ...(facts.prototype ? { prototype: clean(facts.prototype.label || nameOnly(facts.prototype.target)) } : {}),
      choices: facts.choices.map((choice) => ({
        label: clean(choice.label),
        ...(choice.description ? { description: clean(choice.description) } : {}),
        recommended: choice.recommended,
        chosen: selected.has(choice.label),
        ...(choice.settled ? { settled: true as const } : {}),
        ...(choice.pros?.length ? { pros: choice.pros.map(clean) } : {}),
        ...(choice.cons?.length ? { cons: choice.cons.map(clean) } : {}),
        ...(choice.prototype ? { prototype: clean(choice.prototype.label || nameOnly(choice.prototype.target)) } : {}),
        ...(choice.image ? { image: picture(message, record, choice.image.src, choice.image.alt) } : {}),
      })),
      recommendation: {
        labels,
        text: recText === null ? null : clean(recText),
        taken: state === "decided" && offered && wire ? inboxAnswerTookRecommendation(record, wire) : null,
      },
      answer: wire
        ? {
            selected: [...wire.selected].map(clean),
            other: wire.other ? clean(wire.other) : null,
            text: wire.text ? clean(wire.text) : null,
            note: wire.note ? clean(wire.note) : null,
            skipped: wire.skipped === true,
            sent,
          }
        : null,
      asked: { by: message.author.kind === "agent" ? agentLabel(message.author) : "An agent", at: iso(row.asked_at)!, message_id: message.id },
      ...(sent ? { answered: { at: iso(row.answered_at), sent_at: iso(row.sent_at) } } : {}),
      ...(state === "decided" ? { replaces: replacedBy.get(record.id) ?? [] } : {}),
      ...(state === "replaced" ? { replaced_by: replacementOf(record) } : {}),
    };
    (state === "decided" ? decisions : others).push(item);
    counts[state]++;
  });

  const times = input.messages.map((m) => ms(m.created_at)).filter((at): at is number => at !== null);
  const doc: DecisionExportV1 = {
    format: DECISION_EXPORT_FORMAT,
    v: 1,
    exported_at: options.now.toISOString(),
    tz: decisionExportZone(options.tz),
    generator: options.generator,
    thread: {
      id: input.thread.id,
      subject: clean(oneLine(input.thread.subject ?? "")) || "(no subject)",
      project: input.thread.project === null ? null : clean(input.thread.project),
      started_at: times.length > 0 ? iso(Math.min(...times)) : null,
      last_at: times.length > 0 ? iso(Math.max(...times)) : null,
    },
    pulls: options.pulls.map((pull) => ({ ref: pull.ref, url: pull.url, title: pull.title === null ? null : clean(pull.title) })),
    counts,
    decisions,
    others,
    images: {},
  };
  return { doc, pictures };
}
