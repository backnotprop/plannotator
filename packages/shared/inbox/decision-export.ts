/**
 * Export decisions (design brief "export-decisions", 2026-11-10): one thread's decisions as the `plannotator.decisions`
 * v1 shape, which the Markdown and HTML documents (decision-export-md.ts, decision-export-html.ts) are drawn from.
 *
 * The shape and its pure builder are published in `@plannotator/core/inbox-decisions`, so a host can import them from
 * npm; the rules the builder runs on (the privacy scrub, the zone, the group order) are core's internal
 * `inbox-decision-rules.ts`, never exported from core. This file re-exports both and keeps what only Plannotator's own
 * documents and route read: the group titles, the picture caps, dates, file names and the one-line summaries.
 */
import { DECISION_EXPORT_OTHER_STATES, decisionExportZone, oneLine } from "../../core/inbox-decision-rules";
import type { DecisionExportItem, DecisionExportState, DecisionExportV1 } from "@plannotator/core/inbox-decisions";

export * from "@plannotator/core/inbox-decisions";
export { DECISION_EXPORT_LOCAL_LINK, DECISION_EXPORT_OTHER_STATES, decisionExportZone, scrubDecisionText } from "../../core/inbox-decision-rules";

/** A group's heading in both documents. */
export const DECISION_EXPORT_STATE_TITLES: Readonly<Record<Exclude<DecisionExportState, "decided">, string>> = {
  picked_unsent: "Draft, not sent to the agent",
  answered_in_words: "Answered in words",
  open: "Still open",
  skipped: "Skipped",
  set_aside: "Set aside",
  archived: "Closed by the archive",
  replaced: "Replaced",
};

/** Each picture at most this many bytes in the HTML, the file's pictures together at most `FILE`; past either, the alt text shows. */
export const DECISION_EXPORT_PICTURE_MAX_BYTES = 400 * 1024;
export const DECISION_EXPORT_PICTURES_MAX_BYTES = 5 * 1024 * 1024;
/** The index table cuts a long answer here, with "…". */
export const DECISION_EXPORT_INDEX_ANSWER_CHARS = 70;

export type DecisionExportFormat = "md" | "html" | "json";

/** The dates the documents write, in the reader's zone. */
export interface DecisionExportDateWords {
  day: (value: string) => string;
  at: (value: string) => string;
  ymd: (value: string) => string;
  range: (from: string | null, to: string | null) => string;
}

/** "Nov 8", "Nov 8 at 2:02 PM", "Nov 8 – Nov 10, 2026": the reader's zone, English, as the Inbox writes dates. */
export function decisionExportDates(tz: string): DecisionExportDateWords {
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

/** The other questions by group, in `DECISION_EXPORT_OTHER_STATES` order, empty groups left out. */
export function decisionExportGroups(doc: Pick<DecisionExportV1, "others">): { state: Exclude<DecisionExportState, "decided">; title: string; items: DecisionExportItem[] }[] {
  return DECISION_EXPORT_OTHER_STATES.map((state) => ({ state, title: DECISION_EXPORT_STATE_TITLES[state], items: doc.others.filter((item) => item.state === state) })).filter((group) => group.items.length > 0);
}

/** The one line a non-decision says after its prompt (plain text; each document escapes it): its pick, its replacement, or its recommendation. */
export function decisionOtherDetail(item: DecisionExportItem): string | null {
  if (item.state === "replaced") return item.replaced_by ? `Replaced by “${item.replaced_by.prompt ?? item.replaced_by.id}”` : "Withdrawn";
  if (item.answer && !item.answer.sent && !item.answer.skipped) {
    const line = decisionAnswerLine(item, null);
    const note = item.answer.note ? ` (note: ${oneLine(item.answer.note)})` : "";
    if (line || note) return `Draft: ${line || "—"}${note}`;
  }
  if (item.state === "skipped" && item.answer?.note) return `Note: ${oneLine(item.answer.note)}`;
  if (item.state === "open" || item.state === "answered_in_words") {
    const rec = item.recommendation.labels.length > 0 ? item.recommendation.labels.join(", ") : item.recommendation.text;
    return rec ? `Recommended: ${oneLine(rec)}` : null;
  }
  return null;
}
