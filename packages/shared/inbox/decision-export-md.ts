/**
 * The Markdown document of a thread's decisions (decision-export.ts's v1 shape), written to read well on GitHub:
 * a marker line, a heading, an index table, one section per decision with task-list boxes for the choices (`[x]` is
 * the chosen one, as in the question grammar), then the short "Skipped" and "Still open" lists. No picture is
 * embedded: a picture is "_(picture: alt)_".
 *
 * Every piece of thread text is untrusted: `<`, `>` and `&` become entities (no HTML, no comment that could pass for
 * the marker), a `![` cannot start an image, a table cell's `|` and line breaks are escaped, and a line that would
 * start a heading, list, quote, fence or table in a multi-line field is escaped at its start.
 */
import { decisionAnswerLine, decisionExportDates, decisionExportGroups, decisionOtherDetail, type DecisionExportChoice, type DecisionExportItem, type DecisionExportV1 } from "./decision-export";

/** The hidden first line a later step finds its own comment by (brief section 5). */
export const DECISION_EXPORT_MARKER = (threadId: string) => `<!-- plannotator-decisions v1 thread=${threadId} -->`;

/** Inline text: no HTML, no image, no autolinked angle brackets; one line. */
export function mdInline(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/!\[/g, "!\\[")
    .replace(/\\$/, "\\\\");
}

/** A table cell: inline, with its pipes escaped. */
export function mdCell(text: string): string {
  return mdInline(text).replace(/\|/g, "\\|");
}

/** A multi-line field: each line inline-escaped, a line that would start a block escaped at its start. */
export function mdBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const safe = line.trim() === "" ? "" : line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/!\[/g, "!\\[");
      return safe.replace(/^(\s*)([#>|=]|[-*+](?=\s|$)|\d+[.)](?=\s|$)|`{3,}|~{3,}|-{3,}|\*{3,}|_{3,})/, "$1\\$2");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function choiceLine(choice: DecisionExportChoice): string[] {
  const label = mdInline(choice.label);
  let line = `- [${choice.chosen ? "x" : " "}] ${choice.chosen ? `**${label}**` : label}`;
  if (choice.description) line += ` — ${mdInline(choice.description)}`;
  if (choice.image) line += ` _(picture: ${mdInline(choice.image.alt)})_`;
  if (choice.prototype) line += ` · prototype: ${mdInline(choice.prototype)}`;
  if (choice.recommended) line += " · _recommended_";
  if (choice.settled) line += " · _already settled by the agent_";
  const out = [line];
  if (choice.pros?.length) out.push(`  - Pros: ${choice.pros.map(mdInline).join("; ")}`);
  if (choice.cons?.length) out.push(`  - Cons: ${choice.cons.map(mdInline).join("; ")}`);
  return out;
}

function answerLine(item: DecisionExportItem): string {
  const answer = item.answer!;
  const parts: string[] = [];
  if (answer.selected.length > 0) parts.push(answer.selected.map(mdInline).join(", "));
  if (answer.other) parts.push(`Other: ${mdInline(answer.other)}`);
  let line = `**Answer:** ${parts.join(", ")}`;
  if (item.recommendation.taken === true) line += " · _took the recommendation_";
  else if (item.recommendation.taken === false) line += " · _chose differently from the recommendation_";
  return line;
}

function section(item: DecisionExportItem, when: ReturnType<typeof decisionExportDates>): string[] {
  const out = [`### D${item.n}. ${mdInline(item.prompt)}`, ""];
  const answer = item.answer!;
  if (answer.selected.length > 0 || answer.other) out.push(answerLine(item), "");
  if (answer.text) {
    const taken = item.recommendation.taken === true ? " · _took the recommendation_" : item.recommendation.taken === false ? " · _chose differently from the recommendation_" : "";
    out.push(`**Written answer:**${taken}`, "", ...mdBlock(answer.text).split("\n").map((line) => `> ${line}`.trimEnd()), "");
  }
  if (answer.note) out.push(...mdBlock(`Note: ${answer.note}`).replace(/^Note:/, "**Note:**").split("\n").map((line) => `> ${line}`.trimEnd()), "");
  for (const choice of item.choices) out.push(...choiceLine(choice));
  if (item.choices.length > 0) out.push("");
  const facts: string[] = [];
  if (item.stakes) facts.push(`**Stakes:** ${mdInline(item.stakes)}  `);
  if (item.recommendation.text) facts.push(`**Recommendation:** ${mdInline(item.recommendation.text)}  `);
  if (item.why) facts.push(`**Why the recommendation:** ${mdInline(item.why)}  `);
  if (item.reversible) facts.push(`**Can't be undone:** ${mdInline(item.reversible.why ?? "")}  `);
  if (item.holds_up?.length) facts.push(`**Held up:** ${item.holds_up.map(mdInline).join(", ")}  `);
  if (item.shows) facts.push(`**Shows:** ${item.shows.image ? `_(picture: ${mdInline(item.shows.image.alt)})_` : mdInline(item.shows.label)}  `);
  if (item.prototype) facts.push(`**Prototype:** ${mdInline(item.prototype)}  `);
  if (item.context || facts.length > 0) {
    out.push("<details><summary>Context</summary>", "");
    if (item.context) out.push(mdBlock(item.context), "");
    if (facts.length > 0) out.push(...facts, "");
    out.push("</details>", "");
  }
  for (const replaced of item.replaces ?? []) {
    out.push(`<sub>Replaces an earlier question, “${mdInline(replaced.prompt)}”${replaced.asked_at ? `, asked ${when.day(replaced.asked_at)}` : ""}.</sub>  `);
  }
  const answered = item.answered?.sent_at ?? item.answered?.at ?? null;
  out.push(`<sub>Asked by ${mdInline(item.asked.by)}, ${when.at(item.asked.at)}${answered ? ` · answered ${when.at(answered)}` : ""}</sub>`, "");
  return out;
}

/** The whole document. */
export function renderDecisionExportMarkdown(doc: DecisionExportV1): string {
  const when = decisionExportDates(doc.tz);
  const head = [doc.thread.project ? `**${mdInline(doc.thread.project)}**` : null, when.range(doc.thread.started_at, doc.thread.last_at) || null, `${doc.counts.decided} decided${doc.others.length > 0 ? `, ${doc.others.length} other ${doc.others.length === 1 ? "question" : "questions"}` : ""}`]
    .filter(Boolean)
    .join(" · ");
  const out = [DECISION_EXPORT_MARKER(doc.thread.id), `## Decisions: ${mdInline(doc.thread.subject)}`, "", head];
  if (doc.pulls.length > 0) out.push("", doc.pulls.map((pull) => (/^https:\/\/[^\s()<>]+$/.test(pull.url) ? `[${mdInline(pull.ref)}](${pull.url})` : mdInline(pull.ref))).join(" · "));
  out.push("");
  if (doc.decisions.length > 0) {
    out.push("| | Question | Answer | Recommendation |", "|---|---|---|---|");
    for (const item of doc.decisions) {
      const taken = item.recommendation.taken === true ? "Taken" : item.recommendation.taken === false ? "Not taken" : "";
      out.push(`| D${item.n} | ${mdCell(item.prompt)} | ${mdCell(decisionAnswerLine(item))} | ${taken} |`);
    }
    out.push("");
    for (const item of doc.decisions) out.push(...section(item, when));
  }
  for (const group of decisionExportGroups(doc)) {
    out.push(`### ${group.title}`, "");
    for (const item of group.items) {
      const detail = decisionOtherDetail(item);
      out.push(`- ${mdInline(item.prompt)}${detail ? ` — ${mdInline(detail)}` : ""} <sub>(${mdInline(item.asked.by)}, ${when.day(item.asked.at)})</sub>`);
    }
    out.push("");
  }
  out.push("---", `<sub>Exported from Plannotator on ${when.at(doc.exported_at)}.</sub>`, "");
  return out.join("\n");
}
