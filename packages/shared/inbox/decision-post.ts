/** Posts a thread's decisions on a pull request as one comment, or as a section of the PR description between hidden markers; a repeat post edits in place. Thread text is untrusted: HTML-escaped inside HTML blocks, `mdInline` in Markdown. */
import { DECISION_EXPORT_OTHER_STATES, DECISION_EXPORT_STATE_TITLES, type DecisionExportItem, type DecisionExportState, type DecisionExportV1 } from "./decision-export";
import { decisionExportDesignDates } from "./decision-export-html";
import { DECISION_EXPORT_MARKER, mdInline } from "./decision-export-md";
import type { PRMarkedDestination } from "../pr-marked";

export const DECISION_POST_DESTINATION: PRMarkedDestination = "description";
export const DECISION_POST_DESTINATIONS: readonly PRMarkedDestination[] = ["description", "comment", "both"];

export function decisionPostDestinationOf(value: unknown): PRMarkedDestination {
  return DECISION_POST_DESTINATIONS.includes(value as PRMarkedDestination) ? (value as PRMarkedDestination) : DECISION_POST_DESTINATION;
}

export { DECISION_EXPORT_MARKER as DECISION_POST_COMMENT_MARKER };
/** The description section's bounds. Nothing outside them is ever changed. */
export const DECISION_POST_SECTION_START = (threadId: string) => `<!-- plannotator-decisions:start v1 thread=${threadId} -->`;
export const DECISION_POST_SECTION_END = "<!-- plannotator-decisions:end -->";

/** Hosted on the marketing site because GitHub strips inline SVG; a new look gets a new folder so a posted comment never changes under its readers. */
export const DECISION_POST_BANNER = {
  dark: "https://plannotator.ai/assets/decisions/v1/banner-dark.png",
  light: "https://plannotator.ai/assets/decisions/v1/banner-light.png",
  alt: "Decisions, from Plannotator",
} as const;

export const DECISION_POST_LANDING = "https://plannotator.ai/inbox/";

export type DecisionPostPlatform = "github" | "gitlab";

/** A pick saved and not sent is posted, marked `DECISION_POST_DRAFT`; only the embedded pictures are left out. */
export function decisionExportForPost(doc: DecisionExportV1): DecisionExportV1 {
  return { ...doc, images: {} };
}

export const DECISION_POST_DRAFT = "draft, not sent to the agent";

const html = (text: string) => text.replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1).replace(/[ ,.]+$/, "")}…`);
const joinWords = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const SHORT: Readonly<Record<Exclude<DecisionExportState, "decided">, string>> = {
  open: "open",
  picked_unsent: "draft",
  answered_in_words: "in words",
  skipped: "skipped",
  set_aside: "set aside",
  archived: "archived",
  replaced: "replaced",
};

function answerOf(item: DecisionExportItem): string {
  const a = item.answer;
  if (!a) return "";
  return [...a.selected, ...(a.other ? [a.other] : []), ...(a.text ? [a.text] : [])].join(", ");
}

export function decisionVerdict(item: DecisionExportItem): string | null {
  const labels = item.recommendation.labels;
  if (labels.length === 0 && !item.recommendation.text) return null;
  const a = item.answer;
  const selected = a?.selected ?? [];
  if (item.recommendation.taken) return "Took the recommendation.";
  if (item.kind === "multi" && labels.length > 0 && labels.every((l) => selected.includes(l)) && !a?.other) {
    const added = selected.filter((s) => !labels.includes(s));
    return `Took the recommendation and added ${joinWords(added)}.`;
  }
  if (a?.other || a?.text) return "Wrote their own answer instead of the recommendation.";
  return "Chose differently from the recommendation.";
}

function replacementOf(doc: DecisionExportV1, item: DecisionExportItem): DecisionExportItem | null {
  const id = item.replaced_by?.id;
  return id ? ([...doc.decisions, ...doc.others].find((x) => x.id === id) ?? null) : null;
}

function shortState(doc: DecisionExportV1, item: DecisionExportItem): string {
  if (item.state === "replaced") {
    const r = replacementOf(doc, item);
    return r ? `replaced by D${r.n}` : SHORT.replaced;
  }
  return SHORT[item.state as Exclude<DecisionExportState, "decided">];
}

function groups(doc: DecisionExportV1) {
  return DECISION_EXPORT_OTHER_STATES.filter((state) => state !== "picked_unsent")
    .map((state) => ({ state, items: doc.others.filter((d) => d.state === state) }))
    .filter((g) => g.items.length > 0);
}

const draftsOf = (doc: DecisionExportV1) => doc.others.filter((d) => d.state === "picked_unsent");

const orderedOf = (doc: DecisionExportV1) => [...doc.decisions, ...draftsOf(doc), ...groups(doc).flatMap((g) => g.items)];

export function decisionPostTally(doc: DecisionExportV1): string {
  const drafts = draftsOf(doc).length;
  return [`${doc.decisions.length} decided`, ...(drafts ? [`${drafts} ${SHORT.picked_unsent}`] : []), ...groups(doc).map(({ state, items }) => `${items.length} ${SHORT[state]}`)].join(", ");
}

function banner(platform: DecisionPostPlatform): string {
  // GitLab's sanitizer keeps no <picture>/<source>, and the banner is transparent with text coloured per theme, so one
  // image would vanish on GitLab's dark theme: there the banner is its words, as a link.
  if (platform === "gitlab") return `[**Decisions**, from Plannotator](${DECISION_POST_LANDING})`;
  // No width or height: a banner that fails to load (the site not deployed yet, a proxy refusing it) leaves only its
  // alt text on one line, never an empty block the size of the picture.
  const img = `<img alt="${DECISION_POST_BANNER.alt}" src="${DECISION_POST_BANNER.light}">`;
  return `<a href="${DECISION_POST_LANDING}"><picture><source media="(prefers-color-scheme: dark)" srcset="${DECISION_POST_BANNER.dark}">${img}</picture></a>`;
}

function head(doc: DecisionExportV1, when: ReturnType<typeof decisionExportDesignDates>): string {
  const sub = [doc.thread.project ? mdInline(doc.thread.project) : null, when.range(doc.thread.started_at, doc.thread.last_at) || null, decisionPostTally(doc)].filter(Boolean).join(" · ");
  return `**${mdInline(doc.thread.subject)}**<br><sub>${sub}</sub>`;
}

function table(doc: DecisionExportV1, max = Infinity): string[] {
  const rows = ["| | Question | Answer |", "|---|---|---|"];
  const cell = (text: string) => mdInline(text).replace(/\|/g, "\\|");
  const all = orderedOf(doc);
  for (const item of all.slice(0, max)) {
    if (item.state === "decided") rows.push(`| D${item.n} | ${cell(item.prompt)} | ${cell(clip(answerOf(item), 70))} |`);
    else if (item.state === "picked_unsent") rows.push(`| D${item.n} | ${cell(item.prompt)} | ${answerOf(item) ? `${cell(clip(answerOf(item), 50))} · ` : ""}_${DECISION_POST_DRAFT}_ |`);
    else rows.push(`| D${item.n} | ${cell(item.prompt)} | _${shortState(doc, item)}_ |`);
  }
  if (all.length > max) rows.push(`| | _and ${all.length - max} more, in the thread's download_ | |`);
  return rows;
}

type Level = "full" | "compact";

function choiceLine(c: DecisionExportItem["choices"][number], picked: ((label: string) => string) | null, level: Level): string {
  const label = mdInline(c.label);
  // Never task-list syntax (`- [x]`): in a PR description GitHub counts those as the PR's tasks ("N of M tasks") and
  // makes them clickable checkboxes that edit the text. The chosen option is "✓" and bold, read as plain text too.
  let line = picked ? picked(label) : `- ${label}`;
  if (c.description) line += ` · ${mdInline(c.description)}`;
  if (c.image) line += ` · _(picture: ${mdInline(c.image.alt)})_`;
  if (c.prototype) line += ` · prototype: ${mdInline(c.prototype)}`;
  if (c.recommended) line += " · _recommended_";
  if (c.settled) line += " · _already settled by the agent_";
  const signs = level === "full" ? [...(c.pros ?? []).map((p) => `+ ${mdInline(p)}`), ...(c.cons ?? []).map((p) => `− ${mdInline(p)}`)] : [];
  if (signs.length) line += `<br><sub>${signs.join(" &nbsp; ")}</sub>`;
  return line;
}

export function decisionMoreLabel(others: number, reasons: boolean): string {
  if (others === 0) return "The reasoning";
  return `${others} other ${others === 1 ? "choice" : "choices"}${reasons ? " and the reasoning" : ""}`;
}

function folded(doc: DecisionExportV1, item: DecisionExportItem, level: Level, when: ReturnType<typeof decisionExportDesignDates>): string[] {
  const draft = item.state === "picked_unsent";
  const mark = (label: string) => (draft ? `- **${label}** · _${DECISION_POST_DRAFT}_` : `- ✓ **${label}**`);
  const answer = html(clip(answerOf(item), 60));
  // The question is an <h3>: GitHub keeps it inside <summary> and draws it inline (h4 is no bigger than bold text).
  const line = `${answer}${draft ? `${answer ? " · " : ""}${DECISION_POST_DRAFT}` : ""}`;
  const out = [`<details><summary><h3>D${item.n} · ${html(item.prompt)}</h3>${line ? `<br>${line}` : ""}</summary>`, ""];
  for (const c of item.choices) if (c.chosen) out.push(choiceLine(c, mark, level));
  for (const own of [item.answer?.other, item.answer?.text]) if (own) out.push(`${mark(mdInline(own))} · own answer`);
  out.push("");
  const verdict = draft ? null : decisionVerdict(item);
  if (verdict) out.push(mdInline(verdict), "");
  if (item.answer?.note) out.push(`> ${mdInline(item.answer.note)}`, "");
  if (level === "full" && item.context) out.push(mdInline(item.context), "");
  const others = item.choices.filter((c) => !c.chosen);
  const facts: [string, string][] = [];
  if (level === "full") {
    if (item.stakes) facts.push(["Stakes", item.stakes]);
    if (item.recommendation.text) facts.push(["Recommendation", item.recommendation.text]);
    if (item.why) facts.push(["Why", item.why]);
    if (item.reversible) facts.push(["Can't be undone", item.reversible.why ?? "yes"]);
    if (item.holds_up?.length) facts.push(["Held up", item.holds_up.join(", ")]);
    if (item.shows) facts.push(["Shows", item.shows.label]);
    if (item.prototype) facts.push(["Prototype", item.prototype]);
    for (const old of item.replaces ?? []) {
      const kept = doc.others.find((x) => x.id === old.id);
      facts.push(["Replaces", `${kept ? `D${kept.n}, ` : ""}“${old.prompt}”`]);
    }
  }
  if (others.length > 0 || facts.length > 0) {
    out.push(`<details><summary>${decisionMoreLabel(others.length, facts.length > 0)}</summary>`, "");
    if (others.length) out.push(...others.map((c) => choiceLine(c, null, level)), "");
    if (facts.length) out.push(`<dl>${facts.map(([k, v]) => `<dt>${html(k)}</dt><dd>${html(v)}</dd>`).join("")}</dl>`, "");
    out.push("</details>", "");
  }
  const at = item.answered?.sent_at ?? item.answered?.at ?? null;
  out.push(`<sub>${mdInline(item.asked.by)} · asked ${when.stamp(item.asked.at)}${at ? ` · answered ${when.stamp(at)}` : ""}</sub>`, "", "</details>", "");
  return out;
}

function rest(doc: DecisionExportV1): string[] {
  const out: string[] = [];
  for (const { state, items } of groups(doc)) {
    out.push(`#### ${DECISION_EXPORT_STATE_TITLES[state]}`, "");
    for (const item of items) {
      let hint = "";
      if (state === "replaced") {
        const r = replacementOf(doc, item);
        hint = r ? `Replaced by D${r.n}, “${r.prompt}”` : item.replaced_by?.prompt ? `Replaced by “${item.replaced_by.prompt}”` : "Withdrawn";
      } else if (state === "skipped" && item.answer?.note) hint = `Note: ${item.answer.note}`;
      else {
        const recs = item.recommendation.labels.length ? item.recommendation.labels : item.recommendation.text ? [item.recommendation.text] : [];
        if (recs.length) hint = `Recommended: ${joinWords(recs)}`;
      }
      out.push(`- D${item.n} ${mdInline(item.prompt)}${hint ? ` <sub>${mdInline(hint)}</sub>` : ""}`);
    }
    out.push("");
  }
  return out;
}

export const DECISION_POST_TRIMMED = "_Too long for one comment: each decision's details are in the thread's download._";

export function renderDecisionComment(doc: DecisionExportV1, options: { platform: DecisionPostPlatform; room?: number }): string {
  const room = options.room ?? Infinity;
  const when = decisionExportDesignDates(doc.tz);
  const top = [DECISION_EXPORT_MARKER(doc.thread.id), banner(options.platform), "", head(doc, when), ""];
  const foot = `<sub>Posted from Plannotator · ${when.footer(doc.exported_at)}</sub>\n`;
  const build = (level: Level | "table", max = Infinity) =>
    [...top, ...table(doc, max), "", ...(level === "table" ? [DECISION_POST_TRIMMED, ""] : [...doc.decisions, ...draftsOf(doc)].flatMap((d) => folded(doc, d, level, when))), ...rest(doc), foot].join("\n");
  for (const level of ["full", "compact", "table"] as const) {
    const body = build(level);
    if (body.length <= room) return body;
  }
  // The table alone is still too long: fewer rows until it fits (the forge refuses the post otherwise).
  let max = doc.decisions.length + doc.others.length;
  let body = build("table", max);
  while (body.length > room && max > 0) body = build("table", (max = Math.floor(max / 2)));
  return body;
}

export function renderDecisionSection(doc: DecisionExportV1, options: { platform: DecisionPostPlatform; room?: number }): string | null {
  const room = options.room ?? Infinity;
  const when = decisionExportDesignDates(doc.tz);
  for (const level of ["full", "compact"] as const) {
    const body = [
      banner(options.platform),
      "",
      `<details><summary><b>Decisions: ${html(doc.thread.subject)}</b> · ${html(decisionPostTally(doc))}</summary>`,
      "",
      ...table(doc),
      "",
      ...[...doc.decisions, ...draftsOf(doc)].flatMap((d) => folded(doc, d, level, when)),
      ...rest(doc),
      `<sub>Posted from Plannotator · ${when.footer(doc.exported_at)}</sub>`,
      "",
      "</details>",
    ].join("\n");
    if (body.length <= room) return body;
  }
  return null;
}

export function renderDecisionSummary(doc: DecisionExportV1, options: { platform: DecisionPostPlatform; commentUrl?: string | null; room?: number }): string {
  const title = `Decisions: ${mdInline(doc.thread.subject)}`;
  const url = options.commentUrl && /^https:\/\/[^\s()<>]+$/.test(options.commentUrl) ? options.commentUrl : null;
  const line = `${url ? `**[${title}](${url})**` : `**${title}**`} · ${decisionPostTally(doc)}`;
  const text = `${banner(options.platform)}\n\n${line}`;
  return text.length <= (options.room ?? Infinity) ? text : line;
}
