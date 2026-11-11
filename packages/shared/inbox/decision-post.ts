/**
 * Post decisions (design brief "export-decisions" step 2, the owner's answers of 2026-11-10): a thread's decisions on
 * a pull request as ONE comment (a GitLab note) whose body is the Markdown export in the look of
 * `export-decisions-redesign/pr-comment.md`: a banner picture, the thread's title and counts, the table, each decision
 * folded in `<details>`, then the other states as short lists. Posting again from the same thread edits that same
 * comment, found by its first line, the `DECISION_EXPORT_MARKER` the download already carries.
 *
 * Where it goes is the person's setting (config.json `inboxDecisionsPostTo`, the Post group's "Where" in Export
 * decisions); the owner chose the DESCRIPTION as the default ("In the description only", 2026-11-10): a section of the
 * PR's description between hidden markers (`renderDecisionSection`: read raw it starts with a plain heading and one
 * line per decision, so a squash commit that inherits the description stays legible; the banner and the folds follow).
 * The other two: the comment, or a short section in the description that links to the comment.
 *
 * What a public post leaves out that the download keeps: a pick the person saved and did not send is not posted;
 * its question shows under "Still open" instead (`decisionExportForPost`).
 *
 * Every piece of thread text is untrusted: inside HTML blocks (`<details>`, `<dl>`) it is HTML-escaped, in Markdown
 * it goes through the download's own `mdInline`.
 */
import { DECISION_EXPORT_OTHER_STATES, DECISION_EXPORT_STATE_TITLES, type DecisionExportItem, type DecisionExportState, type DecisionExportV1 } from "./decision-export";
import { decisionExportDesignDates } from "./decision-export-html";
import { DECISION_EXPORT_MARKER, mdInline } from "./decision-export-md";
import type { PRMarkedDestination } from "../pr-marked";

// ── The switch (the owner's to choose; the comment until he answers) ──

/** Where Post decisions puts them when the person never chose: the description (the owner, 2026-11-10). */
export const DECISION_POST_DESTINATION: PRMarkedDestination = "description";
export const DECISION_POST_DESTINATIONS: readonly PRMarkedDestination[] = ["description", "comment", "both"];

/** A stored value as a destination: anything else (unset, an older or broken value) is the default. */
export function decisionPostDestinationOf(value: unknown): PRMarkedDestination {
  return DECISION_POST_DESTINATIONS.includes(value as PRMarkedDestination) ? (value as PRMarkedDestination) : DECISION_POST_DESTINATION;
}

// ── Markers and the banner ──

export { DECISION_EXPORT_MARKER as DECISION_POST_COMMENT_MARKER };
/** The description section's bounds. Nothing outside them is ever changed. */
export const DECISION_POST_SECTION_START = (threadId: string) => `<!-- plannotator-decisions:start v1 thread=${threadId} -->`;
export const DECISION_POST_SECTION_END = "<!-- plannotator-decisions:end -->";

/**
 * The banner, hosted on the marketing site (apps/marketing/public/assets/decisions/v1/): GitHub strips inline SVG, and
 * the picture carries no thread text. A new look gets a new folder (v2), so a posted comment never changes under
 * its readers.
 */
export const DECISION_POST_BANNER = {
  dark: "https://plannotator.ai/assets/decisions/v1/banner-dark.png",
  light: "https://plannotator.ai/assets/decisions/v1/banner-light.png",
  alt: "Decisions, from Plannotator",
} as const;

export type DecisionPostPlatform = "github" | "gitlab";

// ── Privacy for a public post ──

/**
 * The shape as a post shows it: a pick that was saved and not sent is not posted (its question is "Still open", with
 * no answer), and no other unsent answer is carried. The download keeps them (`buildDecisionExport`).
 */
export function decisionExportForPost(doc: DecisionExportV1): DecisionExportV1 {
  const unsent = (item: DecisionExportItem) => !!item.answer && !item.answer.sent && !item.answer.skipped;
  const others = doc.others
    .map((item): DecisionExportItem => (item.state === "picked_unsent" ? { ...item, state: "open", answer: null } : unsent(item) ? { ...item, answer: null } : item))
    .sort((a, b) => DECISION_EXPORT_OTHER_STATES.indexOf(a.state as never) - DECISION_EXPORT_OTHER_STATES.indexOf(b.state as never) || a.n - b.n);
  const counts = { ...doc.counts, open: doc.counts.open + doc.counts.picked_unsent, picked_unsent: 0 } as Record<DecisionExportState, number>;
  return { ...doc, others, counts, images: {} };
}

// ── Pieces ──

/** Text inside an HTML block (no Markdown runs there): entities only. */
const html = (text: string) => text.replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1).replace(/[ ,.]+$/, "")}…`);
const joinWords = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const SHORT: Readonly<Record<Exclude<DecisionExportState, "decided">, string>> = {
  open: "open",
  picked_unsent: "not sent",
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

/** The verdict sentence and the table's word (as the HTML download says them), or null with no recommendation. */
export function decisionVerdict(item: DecisionExportItem): { sentence: string; word: string } | null {
  const labels = item.recommendation.labels;
  if (labels.length === 0 && !item.recommendation.text) return null;
  const a = item.answer;
  const selected = a?.selected ?? [];
  if (item.recommendation.taken) return { sentence: "Took the recommendation.", word: "taken" };
  if (item.kind === "multi" && labels.length > 0 && labels.every((l) => selected.includes(l)) && !a?.other) {
    const added = selected.filter((s) => !labels.includes(s));
    return { sentence: `Took the recommendation and added ${joinWords(added)}.`, word: `taken +${added.length}` };
  }
  if (a?.other || a?.text) return { sentence: "Wrote their own answer instead of the recommendation.", word: "not taken" };
  return { sentence: "Chose differently from the recommendation.", word: "not taken" };
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
  return DECISION_EXPORT_OTHER_STATES.map((state) => ({ state, items: doc.others.filter((d) => d.state === state) })).filter((g) => g.items.length > 0);
}

/** "4 decided, 1 open, 1 skipped, 1 replaced". */
export function decisionPostTally(doc: DecisionExportV1): string {
  return [`${doc.decisions.length} decided`, ...groups(doc).map(({ state, items }) => `${items.length} ${SHORT[state]}`)].join(", ");
}

function banner(platform: DecisionPostPlatform): string {
  // GitLab's sanitizer keeps no <picture>/<source> (nor an <img>'s width): the light banner alone, as a Markdown image.
  if (platform === "gitlab") return `![${DECISION_POST_BANNER.alt}](${DECISION_POST_BANNER.light})`;
  // No width or height: a banner that fails to load (the site not deployed yet, a proxy refusing it) leaves only its
  // alt text on one line, never an empty block the size of the picture.
  const img = `<img alt="${DECISION_POST_BANNER.alt}" src="${DECISION_POST_BANNER.light}">`;
  return `<picture><source media="(prefers-color-scheme: dark)" srcset="${DECISION_POST_BANNER.dark}">${img}</picture>`;
}

function head(doc: DecisionExportV1, when: ReturnType<typeof decisionExportDesignDates>): string {
  const sub = [doc.thread.project ? mdInline(doc.thread.project) : null, when.range(doc.thread.started_at, doc.thread.last_at) || null, decisionPostTally(doc)].filter(Boolean).join(" · ");
  return `**${mdInline(doc.thread.subject)}**<br><sub>${sub}</sub>`;
}

function table(doc: DecisionExportV1, max = Infinity): string[] {
  const rows = ["| | Question | Answer | Recommendation |", "|---|---|---|---|"];
  const cell = (text: string) => mdInline(text).replace(/\|/g, "\\|");
  const all = [...doc.decisions, ...doc.others];
  for (const item of all.slice(0, max)) {
    if (item.state === "decided") rows.push(`| D${item.n} | ${cell(item.prompt)} | ${cell(clip(answerOf(item), 70))} | ${decisionVerdict(item)?.word ?? ""} |`);
    else rows.push(`| D${item.n} | ${cell(item.prompt)} | _${shortState(doc, item)}_ | |`);
  }
  if (all.length > max) rows.push(`| | _and ${all.length - max} more, in the thread's download_ | | |`);
  return rows;
}

type Level = "full" | "compact";

function folded(doc: DecisionExportV1, item: DecisionExportItem, level: Level, when: ReturnType<typeof decisionExportDesignDates>): string[] {
  const out = [`<details><summary>D${item.n} · <b>${html(item.prompt)}</b> ${html(clip(answerOf(item), 60))}</summary>`, ""];
  for (const c of item.choices) {
    const label = mdInline(c.label);
    // Never task-list syntax (`- [x]`): in a PR description GitHub counts those as the PR's tasks ("N of M tasks") and
    // makes them clickable checkboxes that edit the text. The chosen option is "✓" and bold, read as plain text too.
    let line = c.chosen ? `- ✓ **${label}**` : `- ${label}`;
    if (c.description) line += ` · ${mdInline(c.description)}`;
    if (c.image) line += ` · _(picture: ${mdInline(c.image.alt)})_`;
    if (c.prototype) line += ` · prototype: ${mdInline(c.prototype)}`;
    if (c.recommended) line += " · _recommended_";
    if (c.settled) line += " · _already settled by the agent_";
    const signs = level === "full" ? [...(c.pros ?? []).map((p) => `+ ${mdInline(p)}`), ...(c.cons ?? []).map((p) => `− ${mdInline(p)}`)] : [];
    if (signs.length) line += `<br><sub>${signs.join(" &nbsp; ")}</sub>`;
    out.push(line);
  }
  for (const own of [item.answer?.other, item.answer?.text]) if (own) out.push(`- ✓ **${mdInline(own)}** · own answer`);
  out.push("");
  const verdict = decisionVerdict(item);
  if (verdict) out.push(mdInline(verdict.sentence), "");
  if (item.answer?.note) out.push(`> ${mdInline(item.answer.note)}`, "");
  if (level === "full") {
    if (item.context) out.push(mdInline(item.context), "");
    const facts: [string, string][] = [];
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
    if (facts.length) out.push(`<dl>${facts.map(([k, v]) => `<dt>${html(k)}</dt><dd>${html(v)}</dd>`).join("")}</dl>`, "");
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

/** Shown where the folds were left out to fit the forge's limit. */
export const DECISION_POST_TRIMMED = "_Too long for one comment: each decision's details are in the thread's download._";

/**
 * The comment's whole body for `platform`, at most `room` characters: every decision folded with its context; past the
 * room, the folds without context, facts and pros/cons; past that, the table alone (cut, with "and N more").
 * `doc` should already be `decisionExportForPost`'s.
 */
export function renderDecisionComment(doc: DecisionExportV1, options: { platform: DecisionPostPlatform; room?: number }): string {
  const room = options.room ?? Infinity;
  const when = decisionExportDesignDates(doc.tz);
  const top = [DECISION_EXPORT_MARKER(doc.thread.id), banner(options.platform), "", head(doc, when), ""];
  const foot = `<sub>Posted from Plannotator · ${when.footer(doc.exported_at)}</sub>\n`;
  const build = (level: Level | "table", max = Infinity) =>
    [...top, ...table(doc, max), "", ...(level === "table" ? [DECISION_POST_TRIMMED, ""] : doc.decisions.flatMap((d) => folded(doc, d, level, when))), ...rest(doc), foot].join("\n");
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

/** The plain head every description form starts with: a heading, the counts, one line per question. No HTML. */
function plainSummary(doc: DecisionExportV1): string[] {
  const lines = [`### Decisions: ${mdInline(doc.thread.subject)}`, "", decisionPostTally(doc), ""];
  for (const item of doc.decisions) lines.push(`- D${item.n} ${mdInline(item.prompt)} **${mdInline(clip(answerOf(item), 80))}**`);
  for (const item of doc.others) lines.push(`- D${item.n} ${mdInline(item.prompt)} _${shortState(doc, item)}_`);
  return lines;
}

/**
 * The description section (the default destination): read raw, a plain heading, the counts and one line per
 * question come first, before any HTML, so a squash commit message that inherits the description stays legible; then
 * the banner, each decision folded, the other states and the footer, as the comment has them. Past `room`, the folds
 * without context, facts and pros/cons; past that, null (the caller posts a comment instead).
 */
export function renderDecisionSection(doc: DecisionExportV1, options: { platform: DecisionPostPlatform; room?: number }): string | null {
  const room = options.room ?? Infinity;
  const when = decisionExportDesignDates(doc.tz);
  for (const level of ["full", "compact"] as const) {
    const body = [...plainSummary(doc), "", banner(options.platform), "", ...doc.decisions.flatMap((d) => folded(doc, d, level, when)), ...rest(doc), `<sub>Posted from Plannotator · ${when.footer(doc.exported_at)}</sub>`].join("\n");
    if (body.length <= room) return body;
  }
  return null;
}

/**
 * The description's short form: the title, the counts, one line per decision (and per other question), and a link to
 * the comment when there is one. Plain Markdown, no HTML: it may end up in a squash commit's message.
 */
export function renderDecisionSummary(doc: DecisionExportV1, options: { commentUrl?: string | null; room?: number } = {}): string {
  const lines = [`**Decisions: ${mdInline(doc.thread.subject)}**`, decisionPostTally(doc), ""];
  for (const item of doc.decisions) lines.push(`- D${item.n} ${mdInline(item.prompt)} **${mdInline(clip(answerOf(item), 80))}**`);
  for (const item of doc.others) lines.push(`- D${item.n} ${mdInline(item.prompt)} _${shortState(doc, item)}_`);
  const link = options.commentUrl && /^https:\/\/[^\s()<>]+$/.test(options.commentUrl) ? `\n[Every decision, with its options and reasons](${options.commentUrl})` : "";
  let text = `${lines.join("\n")}\n${link}`.trim();
  const room = options.room ?? Infinity;
  while (text.length > room && lines.length > 3) {
    lines.splice(lines.length - 1, 1);
    text = `${lines.join("\n")}\n- …\n${link}`.trim();
  }
  return text;
}
