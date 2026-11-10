/**
 * Export decisions (design brief "export-decisions", 2026-11-10): one thread's decisions as the `plannotator.decisions`
 * v1 shape, which the Markdown and HTML documents (decision-export-md.ts, decision-export-html.ts) are drawn from.
 *
 * Nothing here decides a question's fate on its own: each record goes through Decision data's `decisionRowOf`, so a
 * thread's "decided" and "skipped" match Settings -> Decision data on the same store; the answer is the wire's
 * (`toInboxQuestion`, canonical labels), and "took the recommendation" is the reply's own rule
 * (`inboxAnswerTookRecommendation`).
 *
 * What is never in it: a pick the person did not send (the agent never got it), action items, attachments, a link back
 * to the Inbox, localhost or tailnet addresses, local file paths (a home folder in prose becomes `~`), session ids and
 * machine names (an agent is its host's name). Pictures are opaque refs; only the HTML embeds their bytes.
 *
 * Later steps (not built): posting the Markdown on a pull request and a CLI read this same shape.
 */
import { inboxAnswerTookRecommendation, toInboxQuestion } from "@plannotator/core/inbox-questions";
import type { InboxMessage, InboxQuestionRecord } from "@plannotator/core/inbox-types";
import { agentLabel, decisionRowOf, type DecisionFate } from "./decision-data";

// ── The choices the owner has not answered yet (brief section 8): each in this one place. ──

/** Which fates land in which list. A fate in none (`replaced`) is counted, never listed. */
export const DECISION_EXPORT_LISTS: Readonly<Record<"decisions" | "not_answered" | "still_open", readonly DecisionFate[]>> = {
  /** A question the person sent with an answer: Decision data's "answered". */
  decisions: ["answered"],
  /** Sent as skipped, closed by Mark read, or closed by the archive. */
  not_answered: ["skipped", "set_aside", "archived"],
  /** Waiting on the person. A pick not sent stays theirs: its answer is never exported. */
  still_open: ["open", "picked_unsent"],
};
/** Each picture at most this many bytes in the HTML, the file's pictures together at most `FILE`; past either, the alt text shows. */
export const DECISION_EXPORT_PICTURE_MAX_BYTES = 400 * 1024;
export const DECISION_EXPORT_PICTURES_MAX_BYTES = 5 * 1024 * 1024;
/** The index table cuts a long answer here, with "…". */
export const DECISION_EXPORT_INDEX_ANSWER_CHARS = 70;

// ── The v1 shape ──

export const DECISION_EXPORT_FORMAT = "plannotator.decisions";
export type DecisionExportFormat = "md" | "html" | "json";

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
  status: DecisionFate | "decided";
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
  /** Only what the person sent; null while nothing was. */
  answer: { selected: string[]; other: string | null; text: string | null; note: string | null; skipped: boolean } | null;
  asked: { by: string; at: string; message_id: string };
  answered?: { at: string | null; sent_at: string | null };
  replaces?: { id: string; prompt: string; asked_at: string | null }[];
}

export interface DecisionExportV1 {
  format: typeof DECISION_EXPORT_FORMAT;
  v: 1;
  exported_at: string;
  tz: string;
  generator: string;
  thread: { id: string; subject: string; project: string | null; started_at: string | null; last_at: string | null };
  pulls: { ref: string; url: string; title: string | null }[];
  counts: { decided: number; skipped: number; open: number; replaced: number };
  decisions: DecisionExportItem[];
  not_answered: DecisionExportItem[];
  still_open: DecisionExportItem[];
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

// ── Privacy: what free text may not carry ──

const LOCAL_HOST = String.raw`(?:localhost|[\w-]+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|[\w.-]+\.local|[\w.-]+\.ts\.net|[\w.-]+\.internal|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})`;
const LOCAL_URL = new RegExp(String.raw`\b[a-z][a-z0-9+.-]*://${LOCAL_HOST}(?::\d+)?[^\s<>()"'\]]*`, "gi");
const BARE_LOCAL = new RegExp(String.raw`\b${LOCAL_HOST}:\d{2,5}\b[^\s<>()"'\]]*`, "gi");
/** Another account's home, written out: `/Users/x`, `/home/x`, `C:\Users\x`. */
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s"'`<>()]+/g;
/** Shown where a local address was. */
export const DECISION_EXPORT_LOCAL_LINK = "(local link)";

/** Free text as the export may carry it: no local addresses, no home folder. */
export function scrubDecisionText(text: string, home?: string | null): string {
  let out = text.replace(LOCAL_URL, DECISION_EXPORT_LOCAL_LINK).replace(BARE_LOCAL, DECISION_EXPORT_LOCAL_LINK);
  if (home && home.length > 1) out = out.split(home).join("~");
  return out.replace(HOME_PATH, "~");
}

/** A path or address by its last part only: `docs/plan.html` -> `plan.html`, `http://localhost:3000/a/b` -> `b`. */
function nameOnly(target: string): string {
  const path = target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
  const last = path.split(/[\\/]/).filter(Boolean).pop();
  return last ?? "";
}

// ── Times ──

/** The zone asked for, or UTC when the runtime does not know it. */
export function decisionExportZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());
const ms = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/** "Nov 8", "Nov 8 at 2:02 PM", "Nov 8 – Nov 10, 2026": the reader's zone, English, as the Inbox writes dates. */
export function decisionExportDates(tz: string) {
  const zone = decisionExportZone(tz);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" });
  const dayYear = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const year = (at: Date) => ymd.format(at).slice(0, 4);
  return {
    day: (value: string) => day.format(new Date(value)),
    at: (value: string) => `${day.format(new Date(value))} at ${time.format(new Date(value))}`,
    ymd: (value: string) => ymd.format(new Date(value)),
    range: (from: string | null, to: string | null): string => {
      if (!from || !to) return from ? dayYear.format(new Date(from)) : to ? dayYear.format(new Date(to)) : "";
      const [a, b] = [new Date(from), new Date(to)];
      if (ymd.format(a) === ymd.format(b)) return dayYear.format(a);
      if (year(a) === year(b)) return `${day.format(a)} – ${dayYear.format(b)}`;
      return `${dayYear.format(a)} – ${dayYear.format(b)}`;
    },
  };
}

/** `decisions-<subject slug, at most 50>-<yyyy-mm-dd>.<ext>`, the date in the reader's zone. */
export function decisionExportFileName(doc: Pick<DecisionExportV1, "thread" | "exported_at" | "tz">, ext: DecisionExportFormat): string {
  const slug =
    doc.thread.subject
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "") || "thread";
  return `decisions-${slug}-${decisionExportDates(doc.tz).ymd(doc.exported_at)}.${ext}`;
}

// ── The builder ──

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

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

  const lists = { decisions: [] as DecisionExportItem[], not_answered: [] as DecisionExportItem[], still_open: [] as DecisionExportItem[] };
  const counts = { decided: 0, skipped: 0, open: 0, replaced: 0 };
  const listOf = (fate: DecisionFate): keyof typeof lists | null =>
    (Object.keys(DECISION_EXPORT_LISTS) as (keyof typeof lists)[]).find((name) => DECISION_EXPORT_LISTS[name].includes(fate)) ?? null;
  const ordered: { list: keyof typeof lists; record: InboxQuestionRecord; row: (typeof rows)[number]["row"] }[] = [];
  for (const { record, row } of rows) {
    if (row.fate === "replaced") counts.replaced++;
    const list = listOf(row.fate);
    if (!list) continue;
    ordered.push({ list, record, row });
  }
  // Numbered across the lists, decisions first, each in the order asked (D1…Dn, then the short lists).
  const sequence = [...ordered.filter((e) => e.list === "decisions"), ...ordered.filter((e) => e.list === "not_answered"), ...ordered.filter((e) => e.list === "still_open")];
  sequence.forEach(({ list, record, row }, index) => {
    const message = input.byId.get(record.message_id)!;
    const facts = record.parsed;
    // Only a sent answer: an answered or skipped fate is one the agent received.
    const sent = row.fate === "answered" || row.fate === "skipped";
    const wire = sent ? toInboxQuestion(record, false).answer : null;
    const selected = new Set(wire?.selected ?? []);
    const labels = facts.choices.filter((c) => c.recommended).map((c) => clean(c.label));
    const recText = labels.length > 0 ? null : (facts.recommendation ?? facts.suggested_text ?? null);
    const offered = labels.length > 0 || recText !== null;
    const item: DecisionExportItem = {
      n: index + 1,
      id: record.id,
      status: list === "decisions" ? "decided" : row.fate,
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
        taken: list === "decisions" && offered && wire ? inboxAnswerTookRecommendation(record, wire) : null,
      },
      answer: wire
        ? {
            selected: [...wire.selected].map(clean),
            other: wire.other ? clean(wire.other) : null,
            text: wire.text ? clean(wire.text) : null,
            note: wire.note ? clean(wire.note) : null,
            skipped: wire.skipped === true,
          }
        : null,
      asked: { by: message.author.kind === "agent" ? agentLabel(message.author) : "An agent", at: iso(row.asked_at)!, message_id: message.id },
      ...(sent ? { answered: { at: iso(row.answered_at), sent_at: iso(row.sent_at) } } : {}),
      ...(list === "decisions" ? { replaces: replacedBy.get(record.id) ?? [] } : {}),
    };
    lists[list].push(item);
    if (list === "decisions") counts.decided++;
    else if (list === "not_answered") counts.skipped++;
    else counts.open++;
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
    ...lists,
    images: {},
  };
  return { doc, pictures };
}

/** The decisions' agent-free summary for the index: the answer in one line, cut for a table. */
export function decisionAnswerLine(item: Pick<DecisionExportItem, "answer">, cut: number | null = DECISION_EXPORT_INDEX_ANSWER_CHARS): string {
  const answer = item.answer;
  if (!answer) return "";
  const parts = [...answer.selected];
  if (answer.other) parts.push(`Other: ${answer.other}`);
  if (answer.text) parts.push(answer.text);
  const line = oneLine(parts.join(", "));
  return cut !== null && line.length > cut ? `${line.slice(0, cut - 1).trimEnd()}…` : line;
}
