/**
 * Plannotator Inbox: question blocks in a message, their derived state, the
 * person's picks, and the reply text a Send writes.
 *
 * The blocks are found and read with Plannotator's own parser
 * (`./question-block`), so the card the window draws and the record the store
 * keeps are one and the same, with one key. Two plain lines inside a block are
 * read here, as Workspaces reads them (they stay in the block's context, so
 * Plannotator renders them as text):
 *
 *   Stopped: <why>                the asker cannot go on until this is answered
 *   Holds up: <name>; <name>      the asker goes on; these pieces of work wait
 *
 * One guard on top of Workspaces' reading: a value that is only a negative
 * word (`Stopped: no`, a `Holds up:` entry `none`) is no stop and holds
 * nothing up; see `isNegativeWaitValue`. An empty `Stopped:` is still a stop
 * (a claim with no why), as Workspaces reads it.
 *
 * A third, `Replaces: <message id>/<key>`, is read by core's parser itself
 * (`ParsedQuestion.replaces`) when every token on it is id-shaped: it is then
 * never the prompt and never context. Any other `Replaces:` line is prose.
 *
 * Pure: no I/O, no clock unless passed in. Never throws on any input.
 */

import { resolveReferenceLinks } from "./markdown-structure";
import { cutText } from "./text-cut";
// The grapheme-safe cuts, re-exported here: core's export map is checked against the published package, and the Inbox is what uses them.
export { cutText, sliceText } from "./text-cut";
// The subject of a thread the person starts: beside deriveInboxSubject, so the store and compose's preview share it.
export {
  derivePersonThreadSubject,
  PERSON_THREAD_SUBJECT_COLUMNS,
  suggestPersonThreadName,
  PERSON_THREAD_NAME_COLUMNS,
  PERSON_THREAD_NAME_WORDS,
} from "./inbox-thread-subject";
import {
  canonicalQuestionAnswer,
  findQuestionBlocks,
  formatQuestionAnswerLines,
  formatQuestionAnswersSection,
  isQuestionAnswerEmpty,
  isRecommendedQuestionAnswer,
  QUESTION_ANSWERS_HEADING,
  isQuestionAnswered,
  capQuestionPrompt,
  MAX_QUESTION_PROMPT_CHARS,
  normalizeQuestionText,
  parseQuestionAnswer,
  parseQuestionBlock,
  questionChoicesNeedCanonicalLabels,
  type QuestionAnswer,
  type QuestionChoice,
  type QuestionExportItem,
  type QuestionKind,
  type ParsedQuestion,
  questionLabelWithoutImage,
  questionChoiceWithoutRecommendedMarker,
  parseQuestionChoiceText,
} from "./question-block";
import { INBOX_ROW_WAITS_MAX, INBOX_ROW_WAIT_ENTRY_MAX, INBOX_ROW_WAIT_HOLDS_MAX, INBOX_ROW_WAIT_TEXT_MAX, readInboxQuestionKind } from "./inbox-types";
import type {
  InboxRowWait,
  InboxQuestionContract,
  InboxQuestion,
  InboxQuestionFacts,
  InboxQuestionRecord,
  InboxQuestionState,
  InboxQuestionSummary,
} from "./inbox-types";

/** One question block of a message body, in block order. */
export interface ParsedInboxQuestion {
  key: string;
  position: number;
  kind: QuestionKind;
  prompt: string;
  parsed: InboxQuestionFacts;
  stopped: string | null;
  holds_up: string[];
  /** The block's `Replaces:` tokens, as written (checked by the store). */
  replaces: string[];
}

const STOPPED_RE = /^stopped\s*:\s*(.*)$/i;
const HOLDS_UP_RE = /^holds up\s*:\s*(.*)$/i;
const CLOSE_RE = /^\s*:::\s*$/;

/**
 * The keys of a body's questions written with a recommended marker in a
 * choice label or description (`Foo (Recommended)`, `[Recommended] Foo`),
 * whether or not the block also has a `Recommended:` line: the Inbox nudges
 * the agent to keep labels plain.
 */
export function inboxQuestionKeysWithRecommendedMarker(markdown: string): string[] {
  return questionBlocksOf(markdown).flatMap(({ key, parsed }) => (parsed.recommendedMarker ? [key] : []));
}

/** Each question block of a body, parsed as the Inbox reads it. */
function questionBlocksOf(markdown: string): { key: string; startLine: number; parsed: ParsedQuestion }[] {
  if (typeof markdown !== "string" || !markdown.includes(":::question")) return [];
  // Each block is read over the markdown with reference links resolved, as
  // the renderer reads it, so a prompt written with a reference link keeps
  // the key the card computes.
  const resolved = resolveReferenceLinks(markdown).split("\n");
  const out: { key: string; startLine: number; parsed: ParsedQuestion }[] = [];
  for (const location of findQuestionBlocks(markdown, { frontmatter: false })) {
    const lines = resolved
      .slice(location.startLine - 1, location.endLine)
      .join("\n")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const inner = lines.slice(1, CLOSE_RE.test(lines.at(-1) ?? "") && lines.length > 1 ? -1 : undefined);
    // The Inbox records no decisions: a `Decision:` line is context.
    const parsed = parseQuestionBlock(location.directiveKind, inner.join("\n"), { decisionLines: false });
    if (parsed !== null) out.push({ key: location.key, startLine: location.startLine, parsed });
  }
  return out;
}

/**
 * The question blocks of a message body, in block order. A body is read like
 * a comment: no frontmatter. A body with no block (or none that parses)
 * answers [].
 */
export function parseInboxQuestionBlocks(markdown: string): ParsedInboxQuestion[] {
  const out: ParsedInboxQuestion[] = [];
  for (const { key, startLine, parsed } of questionBlocksOf(markdown)) {
    const location = { key, startLine };
    const context = parsed.context.trim();
    out.push({
      key: location.key,
      position: out.length,
      kind: parsed.kind,
      prompt: parsed.prompt,
      parsed: {
        context: context === "" ? null : context,
        choices: parsed.choices.map((choice) => ({
          label: choice.label,
          description: choice.description ?? null,
          recommended: choice.recommended,
          settled: choice.settled,
          ...(choice.image ? { image: { alt: choice.image.alt, src: choice.image.src } } : {}),
        })),
        aliases: parsed.choices.map((choice) => (choice.aliases?.length ? [...choice.aliases] : null)),
        recommendation: parsed.recommendation ?? null,
        suggested_text: parsed.suggestedText ?? null,
        line: location.startLine + 1 + parsed.promptLine,
        ...contractFacts(parsed),
      },
      ...waitsOf(context),
      replaces: parsed.replaces ? [...parsed.replaces] : [],
    });
  }
  return out;
}

/** The block's contract lines as the record keeps them (each only when present). */
function contractFacts(parsed: Pick<ParsedQuestion, "stakes" | "shows" | "why" | "reversible">): InboxQuestionContract {
  return {
    ...(parsed.stakes ? { stakes: parsed.stakes } : {}),
    ...(parsed.shows ? { shows: { kind: parsed.shows.kind, label: parsed.shows.label, src: parsed.shows.src } } : {}),
    ...(parsed.why ? { why: parsed.why } : {}),
    ...(parsed.reversible ? { reversible: { value: false as const, why: parsed.reversible.why ?? null } } : {}),
  };
}

/** A record's contract lines for the wire (copies; absent when absent). */
function wireContract(facts: InboxQuestionContract): InboxQuestionContract {
  return {
    ...(typeof facts.stakes === "string" && facts.stakes ? { stakes: facts.stakes } : {}),
    ...(facts.shows ? { shows: { ...facts.shows } } : {}),
    ...(typeof facts.why === "string" && facts.why ? { why: facts.why } : {}),
    ...(facts.reversible ? { reversible: { value: false as const, why: facts.reversible.why ?? null } } : {}),
  };
}

/**
 * A `Stopped:` value or `Holds up:` entry that is only a negative word: no,
 * none, n/a, na, nothing, false, nil, null, or a dash, in any case, with
 * trailing punctuation and whitespace allowed. An agent filling in a template
 * writes `Stopped: no`; that is not a stop.
 *
 * Only a bare negative word counts, and the guard errs toward a stop:
 * `no API key yet`, `none of the fixtures load`, `No; I need the DB password
 * first`, `no, the key is missing` are all real stops. An empty value is not
 * a negative word (an empty `Stopped:` is a claim with no why, still a stop).
 */
const NEGATIVE_WAIT_RE = /^(?:no|none|n\/a|na|nothing|false|nil|null|[-\u2013\u2014]+)[\s.,;:!?\-\u2013\u2014]*$/i;

/** Whether a `Stopped:` value or `Holds up:` entry is only a negative word. */
export function isNegativeWaitValue(value: string): boolean {
  return NEGATIVE_WAIT_RE.test(value.trim());
}

/**
 * The `Stopped:` and `Holds up:` lines of a block's context; the first of each
 * wins. A first `Stopped:` that is a bare negative (`Stopped: no`) decides
 * there is no stop; bare-negative `Holds up:` entries are dropped. The lines
 * stay in the context either way.
 */
function waitsOf(context: string): { stopped: string | null; holds_up: string[] } {
  let stopped: string | null = null;
  let sawStopped = false;
  let holdsUp: string[] | null = null;
  for (const raw of context.split("\n")) {
    const line = raw.trim();
    if (!sawStopped) {
      const match = STOPPED_RE.exec(line);
      if (match !== null) {
        sawStopped = true;
        const why = (match[1] ?? "").trim();
        if (!isNegativeWaitValue(why)) stopped = why;
        continue;
      }
    }
    if (holdsUp === null) {
      const match = HOLDS_UP_RE.exec(line);
      if (match !== null) {
        holdsUp = (match[1] ?? "")
          .split(";")
          .map((name) => name.trim())
          .filter((name) => name !== "" && !isNegativeWaitValue(name));
      }
    }
  }
  return { stopped, holds_up: holdsUp ?? [] };
}

/**
 * Derived, never stored: superseded when an agent replaced or withdrew it,
 * else closed when the thread is resolved or the person's Mark read closed
 * it (`set_aside`), else open / picked / sent.
 */
export function inboxQuestionState(
  record: Pick<InboxQuestionRecord, "answer" | "revision" | "sent_revision" | "superseded_by" | "set_aside"> &
    Partial<Pick<InboxQuestionRecord, "kind" | "action_result">>,
  threadResolved: boolean,
): InboxQuestionState {
  if (record.superseded_by) return "superseded";
  // An action item the agent saw done itself is closed: nothing waits on the person, nothing is sent.
  if (record.kind === "action" && record.action_result?.by === "agent") return "closed";
  if (threadResolved || record.set_aside) return "closed";
  if (record.kind === "action") {
    // An action item: open until the person's Done or Can't do it, "picked" while its
    // Undo window runs, "sent" once the reply carrying it is written.
    if (!record.action_result) return "open";
    return record.revision > 0 && record.sent_revision === record.revision ? "sent" : "picked";
  }
  if (record.answer === null) return "open";
  if (record.revision > 0 && record.sent_revision === record.revision) return "sent";
  return "picked";
}

// Where a build through 0.28.26 may have joined a `Context:` line onto the
// plain bullet above it: `Keep it pinned forever Context: an archived thread…`.
// A build from before contract lines joined one (`Stakes:`, `Shows:`, `Why:`,
// `Reversible:`) onto it the same way.
const STORED_CONTEXT_SPLIT_RE = /\s+(?:[*_]{1,2})?(?:context|stakes|shows|why|reversible)(?:[*_]{1,2})?\s*:/gi;

/** A label holding `![` with no complete `![alt](src)` after it: what an older parser stored when a dash in the alt text split the label. */
const UNCLOSED_IMAGE_RE = /!\[(?![^\]\n]*\]\([^)\n]+\))/;

/** Every label before a ` Context:` in a stored label (each split point:
 *  the bullet's own words may hold the word too). */
function storedContextHeads(label: string): string[] {
  const heads: string[] = [];
  for (const match of label.matchAll(STORED_CONTEXT_SPLIT_RE)) {
    const head = label.slice(0, match.index).trim();
    if (head) heads.push(head);
  }
  return heads;
}

/**
 * The choices with their older names, for `canonicalQuestionAnswer`. A label
 * stored with a `Context:` line joined on (a record from 0.28.26 or older)
 * also answers to the part before it, which is the label the card reads
 * today, so the card's pick is not refused as an unknown choice. A head is
 * added only when no other choice has that name and no other choice yields
 * the same head, so two choices never share a name.
 */
function storedChoices(record: Pick<InboxQuestionRecord, "parsed">): QuestionChoice[] {
  const names = record.parsed.choices.map((choice, index) =>
    new Set([choice.label, ...(record.parsed.aliases[index] ?? [])].map(normalizeQuestionText)),
  );
  // A label stored with an image in it (a record from before picture
  // choices: `![B](b.png) B`) also answers to the plain label the card reads
  // today, as a `Context:` head does.
  const heads = record.parsed.choices.map((choice) => {
    const list = storedContextHeads(choice.label);
    const plain = questionLabelWithoutImage(choice.label);
    const out = plain ? [...list, plain, ...list.flatMap((head) => questionLabelWithoutImage(head) ?? [])] : [...list];
    // An older parser split a label at a dash inside an image's alt text:
    // `- [ ] ![Drawer A - closest](a.png) Drawer A` was stored as the label
    // `![Drawer A` and the description `closest](a.png) Drawer A`. Joined
    // again and read as the card reads it today, it answers to `Drawer A`.
    if (UNCLOSED_IMAGE_RE.test(choice.label) && choice.description) {
      const rebuilt = parseQuestionChoiceText(`${choice.label} — ${choice.description}`).label;
      if (rebuilt && rebuilt !== choice.label && !out.includes(rebuilt)) out.push(rebuilt);
    }
    // A label stored with a recommended marker in it (a record from before
    // the parser read `Foo (Recommended)` as the recommendation) also
    // answers to the label without it, which the card reads today.
    const unmarked = questionChoiceWithoutRecommendedMarker({ label: choice.label })?.label;
    if (unmarked && unmarked !== choice.label && !out.includes(unmarked)) out.push(unmarked);
    return out;
  });
  const headOwners = new Map<string, Set<number>>();
  heads.forEach((list, index) => {
    for (const head of list) {
      const key = normalizeQuestionText(head);
      if (!headOwners.has(key)) headOwners.set(key, new Set());
      headOwners.get(key)!.add(index);
    }
  });
  return record.parsed.choices.map((choice, index) => {
    const aliases = [...(record.parsed.aliases[index] ?? [])];
    for (const head of heads[index]!) {
      const key = normalizeQuestionText(head);
      if (!key || names[index]!.has(key) || headOwners.get(key)!.size > 1) continue;
      if (names.some((set, other) => other !== index && set.has(key))) continue;
      names[index]!.add(key);
      aliases.push(head);
    }
    return {
      label: choice.label,
      settled: choice.settled,
      recommended: choice.recommended,
      ...(choice.description !== null ? { description: choice.description } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
    };
  });
}

/** The question as the wire serves it. */
export function toInboxQuestion(record: InboxQuestionRecord, threadResolved: boolean): InboxQuestion {
  return {
    key: record.key,
    position: record.position,
    kind: record.kind,
    prompt: record.prompt,
    context: record.parsed.context,
    choices: record.parsed.choices.map((c) => ({ ...c, ...(c.image ? { image: { ...c.image } } : {}) })),
    recommendation: record.parsed.recommendation,
    suggested_text: record.parsed.suggested_text,
    stopped: record.stopped,
    holds_up: [...record.holds_up],
    asked_by_agent_id: record.asked_by_agent_id,
    orphaned: false,
    state: inboxQuestionState(record, threadResolved),
    answer: record.answer === null || record.kind === "action" ? null : canonicalQuestionAnswer({ choices: storedChoices(record) }, record.answer),
    revision: record.revision,
    sent_revision: record.sent_revision,
    picked_by: record.picked_by,
    picked_at: record.picked_at,
    sent_reply_id: record.sent_reply_id,
    message_id: record.message_id,
    superseded_by: record.superseded_by ? { message_id: record.superseded_by.message_id, key: record.superseded_by.key ?? null } : null,
    set_aside_at: record.set_aside?.at ?? null,
    ...wireContract(record.parsed),
    ...(record.kind === "action"
      ? {
          action: record.action ? { ...record.action } : { where: null, where_url: null, run: null, watching: null },
          action_result: record.action_result ? { ...record.action_result } : null,
        }
      : {}),
  };
}

// ─────────────────────────────── Superseding ───────────────────────────────

// `q-` a question, `a-` an action item (an Inbox `:::action`).
const SUPERSEDE_REF_RE = /^(msg_[0-9A-HJKMNP-TV-Z]{26})(?:\/((?:q|a)-[0-9a-f]{8}(?:-\d{1,3})?))?$/;

/**
 * One id an agent supersedes with (send_message's `supersedes`, or a token of
 * a `Replaces:` line): `<message id>` (every open question of that message)
 * or `<message id>/<key>` (one). Null when it is neither.
 */
export function parseInboxSupersedeRef(value: unknown): { message_id: string; key: string | null } | null {
  if (typeof value !== "string") return null;
  const match = SUPERSEDE_REF_RE.exec(value.trim());
  if (!match) return null;
  return { message_id: match[1]!, key: match[2] ?? null };
}

/** A question that can still be superseded: one the person has not answered and sent. */
export function isInboxQuestionSupersedable(state: InboxQuestionState): boolean {
  return state === "open" || state === "picked";
}

/**
 * What waits on the person, as the list counts it (its sections, the
 * Stopped / Holding / Waiting badges, "Answered, not sent"): a question or
 * action item that is `open`, or a question `picked` and not sent (its answer
 * waits only for a Send). An action item the person marked is on its way (its
 * Undo window: `picked`) and waits on nobody. Never an orphaned record.
 *
 * A kind this build does not know (written by a newer Inbox) still counts
 * here, exactly as the list counted it before decision mode: the thread still
 * waits on the person, who answers it in a newer window. Only the readers that
 * answer (decision mode, the thread's open-questions list) leave it out, through
 * `inboxQuestionWaitsOnPerson`. Whether the message is still live (not closed
 * by an archive) is already in `state`, which the store derives.
 */
export function inboxQuestionWaitsForList(q: Pick<InboxQuestion, "state" | "kind" | "orphaned">): boolean {
  if (q.orphaned) return false;
  if (q.state === "open") return true;
  return q.state === "picked" && q.kind !== "action";
}

/**
 * The one rule for "this waits on the person and can be answered here"
 * (approval "inbox-decision-mode", brief §10): decision mode's queue and a
 * thread's open-questions list read it. It is the list's rule
 * (`inboxQuestionWaitsForList`) without the kinds this build does not know,
 * since no reader here may answer one. So the Decide count, the list and the
 * popover agree on every known kind.
 */
export function inboxQuestionWaitsOnPerson(q: Pick<InboxQuestion, "state" | "kind" | "orphaned">): boolean {
  return inboxQuestionWaitsForList(q) && readInboxQuestionKind(q.kind) !== "unknown";
}

/**
 * How urgently a waiting question holds an agent up: 0 Stopped (the agent
 * cannot go on), 1 Holds up named work, 2 neither. The list's sections
 * (Stopped on you, Holding up work, Waiting on you) and decision mode's order
 * read it.
 */
export type InboxUrgency = 0 | 1 | 2;

export function inboxUrgencyOf(facts: { stopped: string | boolean | null; holds_up: readonly string[] }): InboxUrgency {
  if (facts.stopped !== null && facts.stopped !== false) return 0;
  return facts.holds_up.length > 0 ? 1 : 2;
}

/** Workspaces' row summary over a thread's questions (open ones only for the badges). */
export function summarizeInboxQuestions(questions: readonly InboxQuestion[]): InboxQuestionSummary {
  let open = 0;
  let picked = 0;
  let actions = 0;
  let staged = 0;
  let stopped = false;
  const holdsUp: string[] = [];
  let prompt: string | null = null;
  for (const q of questions) {
    // A Done or Can't do it waiting in the reply draft: the agent is still stopped on it, so it keeps the
    // row's Stopped / Holds up (approval "inbox-action-items-in-reply", Q2). Not open, not a pick.
    if (q.kind === "action" && q.state === "picked" && q.action_result?.by === "person" && q.action_result.staged === true && !q.orphaned) {
      staged += 1;
      if (q.stopped !== null) stopped = true;
      for (const name of q.holds_up) if (!holdsUp.includes(name)) holdsUp.push(name);
      continue;
    }
    // The list's rule: a kind this build does not know still counts (see inboxQuestionWaitsForList).
    if (!inboxQuestionWaitsForList(q)) continue;
    if (q.state === "picked") picked += 1;
    if (q.state !== "open") continue;
    open += 1;
    if (q.kind === "action") actions += 1;
    if (q.stopped !== null) stopped = true;
    for (const name of q.holds_up) if (!holdsUp.includes(name)) holdsUp.push(name);
    if (prompt === null) prompt = q.prompt;
  }
  return { open, picked, stopped, holds_up: holdsUp, prompt, actions, ...(staged > 0 ? { staged } : {}) };
}

/**
 * What a row's Stopped / Holds up badge holds (approval "inbox-row-badges"):
 * the open questions and action items that stop the agent or hold something
 * up, in the order given (thread order), capped. The same open rule as the
 * badges' summary (`summarizeInboxQuestions`), so the card never lists a
 * question the badge does not count.
 */
export function inboxRowWaits(questions: readonly InboxQuestion[]): InboxRowWait[] {
  const out: InboxRowWait[] = [];
  for (const q of questions) {
    if (out.length >= INBOX_ROW_WAITS_MAX) break;
    if (!inboxQuestionWaitsForList(q) || q.state !== "open") continue;
    if (q.stopped === null && q.holds_up.length === 0) continue;
    out.push({
      message_id: q.message_id,
      key: q.key,
      position: q.position,
      prompt: cutText(q.prompt, INBOX_ROW_WAIT_TEXT_MAX),
      stopped: q.stopped === null ? null : cutText(q.stopped, INBOX_ROW_WAIT_TEXT_MAX),
      holds_up: q.holds_up.slice(0, INBOX_ROW_WAIT_HOLDS_MAX).map((h) => cutText(h, INBOX_ROW_WAIT_ENTRY_MAX)),
    });
  }
  return out;
}

// ─────────────────────────────── Picks ───────────────────────────────

export type InboxAnswerRefusal =
  | { code: "validation_error"; field: string; message: string }
  | { code: "question_not_found"; key: string }
  | { code: "question_revision_conflict"; key: string; current_revision: number }
  | { code: "question_already_sent"; key: string }
  | { code: "question_superseded"; key: string; superseded_by: { message_id: string; key: string | null } };

/**
 * Plannotator's record checked against its question: the fail-closed parser
 * first, then key, kind and prompt, then every picked label (read through the
 * choice's older names first). Returns the canonical answer to store.
 */
export function checkInboxAnswer(
  record: Pick<InboxQuestionRecord, "key" | "kind" | "prompt" | "parsed">,
  raw: unknown,
  field: string,
): { ok: true; answer: QuestionAnswer } | { ok: false; refusal: InboxAnswerRefusal } {
  const parsed = parseQuestionAnswer(raw);
  const invalid = (message: string) => ({ ok: false as const, refusal: { code: "validation_error" as const, field, message } });
  if (parsed === null) return invalid("not a valid QuestionAnswer v1 record");
  if (parsed.key !== record.key) return invalid("key does not match the question");
  if (parsed.kind !== record.kind) return invalid("kind does not match the question");
  // The cut every build makes now, or the plain 400-unit cut a client from before it made (the phone app's, until it updates).
  if (parsed.prompt !== capQuestionPrompt(record.prompt) && parsed.prompt !== record.prompt.slice(0, MAX_QUESTION_PROMPT_CHARS)) {
    return invalid("prompt does not match the question");
  }
  const answer = canonicalQuestionAnswer({ choices: storedChoices(record) }, parsed);
  if (record.kind === "text" && answer.selected.length > 0) return invalid("a text question takes no selected choices");
  if (record.kind === "single" && answer.selected.length > 1) return invalid("a single-choice question takes one choice");
  const labels = new Set(record.parsed.choices.map((c) => c.label));
  for (const label of answer.selected) {
    if (!labels.has(label)) return invalid(`"${label}" is not one of the question's choices`);
  }
  return { ok: true, answer };
}

// ─────────────────────────────── Send ───────────────────────────────

function exportItem(record: InboxQuestionRecord, number: number): QuestionExportItem {
  const settled = record.parsed.choices.filter((c) => c.settled).map((c) => c.label);
  // The export prints current labels for answers stored under an older name
  // or cut at 200 characters by a build through 0.28.17.
  const needsChoices = questionChoicesNeedCanonicalLabels(storedChoices(record));
  return {
    key: record.key,
    number,
    prompt: record.prompt,
    line: record.parsed.line,
    recommendedLabels: record.parsed.choices.filter((c) => c.recommended).map((c) => c.label),
    ...(record.parsed.suggested_text === null ? {} : { suggestedText: record.parsed.suggested_text }),
    ...(record.parsed.recommendation === null ? {} : { recommendation: record.parsed.recommendation }),
    choiceLabels: record.parsed.choices.map((c) => c.label),
    choiceAliases: storedChoices(record).map((c) => c.aliases),
    settled: settled.length > 0,
    settledLabels: settled,
    ...(needsChoices
      ? {
          choices: storedChoices(record).map(({ label, aliases }) => ({ label, ...(aliases ? { aliases } : {}) })),
        }
      : {}),
  };
}

/**
 * The body a Send writes: "Answered N questions.", "Skipped N questions." or
 * "Answered N questions, skipped M." when it carries answers or skips,
 * the person's words if any, then the line saying which questions stay open
 * (when any do), then Plannotator's "Answers to your questions" section over
 * every question of the message, with the answers this Send carries and
 * earlier sent answers that still stand. Empty when there is nothing to send.
 *
 * A Send never skips on its own (approval "inbox-explicit-skip",
 * 2026-10-21): every question it neither answers nor skips stays open, and
 * the reply says so, so the agent does not guess or ask again.
 */
export function composeInboxReplyBody(input: {
  questions: readonly InboxQuestionRecord[];
  sent: readonly QuestionAnswer[];
  earlier: readonly QuestionAnswer[];
  words: string | undefined;
  /**
   * The questions the still-open line counts. Default: the questions of
   * every message the reply answers. The Inbox passes every question the
   * replied-to message's session asked in the thread, so a reply to one
   * message also tells the agent about its questions in the others. The
   * questions this reply sends are never counted.
   */
  stillOpen?: readonly InboxQuestionRecord[];
  /**
   * One reply for one session (approval "inbox-explicit-skip", 2026-10-21):
   * every message of the session the reply answers questions on, in thread
   * order, each with its questions, the answers this reply sends on it and
   * its earlier sent answers. Replaces `questions` / `sent` / `earlier` when
   * given. When the reply sends answers on a message other than `replyTo`
   * (or on several), the answers section names each message by its id.
   */
  messages?: readonly InboxReplyMessageAnswers[];
  /** The message the reply answers (`reply_to`), for `messages`. */
  replyTo?: string;
}): string {
  // Action items (`kind: "action"`) are reported in their own section ("Actions
  // you asked for"), never numbered or counted as questions here.
  const questionsOnly = <T extends { kind: string }>(list: readonly T[]): T[] => list.filter((q) => q.kind !== "action");
  const groups: readonly InboxReplyMessageAnswers[] = (
    input.messages ?? [
      { message_id: input.questions[0]?.message_id ?? input.replyTo ?? "", questions: input.questions, sent: input.sent, earlier: input.earlier },
    ]
  ).map((g) => ({ ...g, questions: questionsOnly(g.questions), sent: questionsOnly(g.sent), earlier: questionsOnly(g.earlier) }));
  // The same rule as the answers section's "x of y answered" line
  // (formatQuestionAnswersSection): a pick, Other or text answers; a note
  // alone answers only a settled question; a skip that answers nothing is a
  // skip; a note alone on an open question is neither.
  let answered = 0;
  let skipped = 0;
  for (const group of groups) {
    const settled = new Set(group.questions.filter((q) => q.parsed.choices.some((c) => c.settled)).map((q) => q.key));
    for (const a of group.sent) {
      if (isQuestionAnswerEmpty(a)) continue;
      if (isQuestionAnswered(a) || (settled.has(a.key) && !a.skipped)) answered += 1;
      else if (a.skipped) skipped += 1;
    }
  }
  const sentence = replySentence(answered, skipped);
  const sentGroups = groups.filter((g) => g.sent.length > 0);
  const labelled = sentGroups.length > 1 || (sentGroups.length === 1 && input.replyTo !== undefined && sentGroups[0]!.message_id !== input.replyTo);
  let section = "";
  if (sentGroups.length === 1 && !labelled) {
    section = answersSection(sentGroups[0]!, 2);
  } else if (sentGroups.length > 0) {
    // One section, a sub-heading per message: the agent can tell which "Q1" is which.
    const parts = sentGroups.flatMap((g) => {
      const body = answersSection(g, 3).replace(/^### [^\n]*\n\n/, "");
      return body === "" ? [] : [`### Your message ${g.message_id}\n\n${body}`];
    });
    if (parts.length > 0) section = `## ${QUESTION_ANSWERS_HEADING}\n\n${parts.join("\n\n")}`;
  }
  const words = input.words?.trim() ?? "";
  // The questions this reply leaves open, and says so: the agent must not ask
  // again. A reply that answers and skips nothing keeps its own wording.
  const sentIds = new Set(groups.flatMap((g) => g.sent.map((a) => `${g.message_id}/${a.key}`)));
  const pool = questionsOnly(input.stillOpen ?? groups.flatMap((g) => g.questions)).filter((q) => !sentIds.has(`${q.message_id ?? ""}/${q.key}`));
  const stillOpen = sentGroups.length === 0 ? inboxStillOpenLine(pool) : inboxOtherStillOpenLine(pool);
  return [sentence, words, stillOpen, section].filter((part) => part !== "").join("\n\n");
}

/** One message a reply answers questions on (`composeInboxReplyBody`'s `messages`). */
export interface InboxReplyMessageAnswers {
  message_id: string;
  questions: readonly InboxQuestionRecord[];
  sent: readonly QuestionAnswer[];
  earlier: readonly QuestionAnswer[];
}

/** One message's "Answers to your questions" section, at a heading level (its questions numbered as its cards are). */
function answersSection(group: InboxReplyMessageAnswers, headingLevel: 2 | 3): string {
  // A superseded question is neither answered nor "Unanswered": the agent
  // withdrew it. The others keep their numbers ("Q2" stays the card's 2).
  const items = [...group.questions]
    .sort((a, b) => a.position - b.position)
    .map((q, i) => (q.superseded_by ? null : exportItem(q, i + 1)))
    .filter((item): item is QuestionExportItem => item !== null);
  return formatQuestionAnswersSection(items, [...group.sent, ...group.earlier], { headingLevel }).trimEnd();
}

/**
 * The body of the person's Re-ask note (approval "inbox-reask"): what the
 * agent is asked to do with its open questions, then the answers the person
 * had picked and not sent, which go with the note. `noteId` is the note's
 * own id, the `reply_to` of the agent's new message.
 */
export function composeInboxReaskBody(input: {
  /** The open questions and action items (`kind: "action"`, approval "inbox-next-actions") asked again. */
  reask: readonly (Pick<InboxQuestionRecord, "id" | "prompt"> & { kind?: string })[];
  answered: readonly { record: Pick<InboxQuestionRecord, "id" | "prompt" | "parsed">; answer: QuestionAnswer }[];
  noteId: string;
  /**
   * The agent that asked, when the note goes to another session because the
   * asking one ended: named from its host ("Claude Code"), so the note says
   * whose questions they are instead of "your".
   */
  askedBy?: string | null;
}): string {
  const n = input.reask.length;
  const actions = input.reask.filter((r) => r.kind === "action").length;
  const questions = n - actions;
  // Questions alone keep their words; with action items the note names both.
  const items =
    actions === 0
      ? n === 1
        ? "open question"
        : `${n} open questions`
      : questions === 0
        ? actions === 1
          ? "open action item"
          : `${actions} open action items`
        : `${questions} open question${questions === 1 ? "" : "s"} and ${actions} open action item${actions === 1 ? "" : "s"}`;
  const whose = input.askedBy ? `the ${items} ${input.askedBy} asked` : `your ${items}`;
  const lines = [
    n === 1
      ? `Please ask ${whose} in this thread again, in one new message, so the person can answer it in one place.`
      : `Please ask ${whose} in this thread again, together in one new message, so the person can answer them in one place.`,
  ];
  if (input.answered.length > 0) {
    const k = input.answered.length;
    lines.push(`The person answered ${k === 1 ? "one more question" : `${k} more questions`} with this note; the ${k === 1 ? "answer is" : "answers are"} below. Don't ask ${k === 1 ? "it" : "them"} again.`);
  }
  lines.push(
    "",
    "Still open:",
    ...input.reask.map((q) => `- ${q.id}: ${q.kind === "action" ? "(action item) " : ""}${q.prompt.replace(/\s+/g, " ").trim()}`),
    "",
    `Check ${n === 1 ? "it" : "each one"} against where the work is now:`,
    actions === 0
      ? "- Still needed: ask it again with the context the person needs today (what changed since you asked, your recommendation), and put a `Replaces: <id>` line in its question block."
      : "- Still needed: ask it again with the context the person needs today (what changed since you asked, your recommendation), and put a `Replaces: <id>` line in its block (a question in a question block, an action item in a `:::action` block).",
    "- No longer needed: leave it out, put its id in `supersedes`, and say in one line why.",
    ...(actions > 0 ? ["- An action item you saw done yourself: put its id in `done`."] : []),
    actions === 0
      ? `Send one message (send_message) with reply_to ${input.noteId}. Until every id above is replaced or in \`supersedes\`, the old ${n === 1 ? "question stays" : "questions stay"} open for the person.`
      : `Send one message (send_message) with reply_to ${input.noteId}. Until every id above is replaced, in \`supersedes\` or in \`done\`, the old ${n === 1 ? "one stays" : "ones stay"} open for the person.`,
  );
  if (input.answered.length > 0) {
    let section = `## ${QUESTION_ANSWERS_HEADING}\n\n`;
    for (const { record, answer } of input.answered) {
      const recommended = record.parsed.choices.filter((c) => c.recommended).map((c) => c.label);
      const suggested = record.parsed.suggested_text ?? undefined;
      section += `### ${record.prompt.replace(/\s+/g, " ").trim()} (${record.id})\n`;
      section += formatQuestionAnswerLines(answer, { recommended: isQuestionAnswered(answer) && isRecommendedQuestionAnswer(answer, recommended, suggested, {
        ...(record.parsed.recommendation === null ? {} : { recommendation: record.parsed.recommendation }),
        choiceLabels: record.parsed.choices.map((c) => c.label),
        choiceAliases: storedChoices(record).map((c) => c.aliases),
      }) });
      section += "\n";
    }
    lines.push("", section.trimEnd());
  }
  return lines.join("\n");
}

/**
 * The line a reply that answers and skips nothing carries (approval
 * "inbox-words-only-reply", 2026-10-13): the message's questions are still
 * open and the person will answer them in the Inbox. Empty when none is left
 * waiting on the person. `INBOX_STILL_OPEN_LINE` matches it, so the window
 * can tell it from the person's own words.
 */
export function inboxStillOpenLine(questions: readonly InboxQuestionRecord[]): string {
  const states = questions.map((q) => inboxQuestionState(q, false));
  const open = states.filter((s) => s === "open" || s === "picked").length;
  if (open === 0) return "";
  // Some were answered in an earlier reply: "No questions answered yet" would not be true.
  if (states.includes("sent")) {
    return `No new answers in this reply; ${questionsWord(open)} ${open === 1 ? "is" : "are"} still open. Don't re-ask ${open === 1 ? "it" : "them"}; the person will answer in the Inbox.`;
  }
  if (open === 1) return "No question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.";
  return `No questions answered yet; all ${open} are still open. Don't re-ask them; the person will answer in the Inbox.`;
}

/**
 * The line a reply that answers or skips some questions carries when others
 * stay open (approval "inbox-explicit-skip", 2026-10-21): how many, that they
 * stay open, and not to ask them again. Empty when none is left waiting on
 * the person. `INBOX_STILL_OPEN_LINE` matches it too.
 */
export function inboxOtherStillOpenLine(questions: readonly InboxQuestionRecord[]): string {
  const open = questions.filter((q) => {
    const state = inboxQuestionState(q, false);
    return state === "open" || state === "picked";
  }).length;
  if (open === 0) return "";
  if (open === 1) return "You have 1 other question open in this thread. It stays open; the person will answer it in the Inbox. Don't re-ask it.";
  return `You have ${open} other questions open in this thread. They stay open; the person will answer them in the Inbox. Don't re-ask them.`;
}

/** Matches `inboxStillOpenLine`'s and `inboxOtherStillOpenLine`'s line (one line of a reply body). */
export const INBOX_STILL_OPEN_LINE =
  /^(?:(?:No questions? answered yet|No new answers in this reply); .* still open\. Don't re-ask (?:it|them); the person will answer in the Inbox\.|You have \d+ other questions? open in this thread\. (?:It stays|They stay) open; the person will answer (?:it|them) in the Inbox\. Don't re-ask (?:it|them)\.)$/;

const questionsWord = (n: number): string => `${n} question${n === 1 ? "" : "s"}`;

/** The reply's first line as `composeInboxReplyBody` writes it ("Answered 2 questions.", "Skipped 1 question.", "Answered 1 question, skipped 2."). */
export const INBOX_REPLY_SENTENCE_LINE = /^(?:Answered \d+ questions?(?:, skipped \d+)?|Skipped \d+ questions?)\.$/;

const ANSWERS_SECTION_HEADING_LINE = `## ${QUESTION_ANSWERS_HEADING}`;
const ANSWERS_GROUP_LINE = /^### Your message msg_[A-Za-z0-9]+$/;

/**
 * Where a reply's "Answers to your questions" section that starts at line
 * `at` ends, read by the grammar `formatQuestionAnswersSection` and
 * `composeInboxReplyBody` write: the heading, a blank line, the "N of M
 * questions answered." line, a blank line, then `### …` blocks of answer
 * lines (`Answer…`, `- …`, `> …`, `Note…`, `Skipped…`), each ended by a blank
 * line; or, for answers on several messages, `### Your message <id>`
 * sub-sections with the same grammar one level down. Returns the index of the
 * first line after it, or null when the text does not follow that grammar
 * exactly (then nothing may be cut).
 */
export function inboxAnswersSectionEnd(lines: readonly string[], at: number): number | null {
  if (lines[at] !== ANSWERS_SECTION_HEADING_LINE || lines[at + 1] !== "") return null;
  if (ANSWERS_GROUP_LINE.test(lines[at + 2] ?? "")) {
    let i = at + 2;
    let groups = 0;
    while (i < lines.length && ANSWERS_GROUP_LINE.test(lines[i]!)) {
      if (lines[i + 1] !== "") return null;
      const end = answerBlocksEnd(lines, i + 2, "####");
      if (end === null) return null;
      i = end;
      groups += 1;
    }
    return groups > 0 ? i : null;
  }
  return answerBlocksEnd(lines, at + 2, "###");
}

/** The "N of M questions answered." line at `from`, a blank line, then `<h> …` blocks of answer lines; the index after them. */
function answerBlocksEnd(lines: readonly string[], from: number, h: "###" | "####"): number | null {
  if (!/^\d+ of \d+ questions? answered\./.test(lines[from] ?? "") || lines[from + 1] !== "") return null;
  let i = from + 2;
  let blocks = 0;
  while (i < lines.length && lines[i]!.startsWith(`${h} `)) {
    i += 1;
    let body = 0;
    while (i < lines.length && lines[i] !== "") {
      if (!/^(Answer|Note|Skipped|- |> |>$)/.test(lines[i]!)) return null;
      i += 1;
      body += 1;
    }
    if (body === 0 && lines[i - 1] !== `${h} Unanswered`) return null;
    blocks += 1;
    // The block's closing blank line; the section ends at the end of the text.
    if (i < lines.length) i += 1;
  }
  return blocks > 0 ? i : null;
}

/** A person's reply body in its parts (`splitInboxReplyBody`). */
export interface InboxReplyBodyParts {
  /** The person's own words (without the reply's first line and the still-open line). */
  words: string;
  /** The "Answers to your questions" section was found (and is not in `words` or `rest`). */
  answers: boolean;
  /** What follows: the annotations' feedback and the skills block, as sent. */
  rest: string;
  /** Anything was taken out (the first line, the still-open line or the answers section). */
  changed: boolean;
}

/**
 * A person's reply as `composeInboxReplyBody` (plus the feedback and skills
 * block the reply route appends) wrote it, in its parts, for showing the
 * person what they sent: their words, then (drawn by the window from the
 * questions themselves) the answers, then the rest. The parts the store
 * writes for the agent come out: the first line ("Answered 2 questions."),
 * the still-open line ("You have 1 other question open…") and the answers
 * section, cut only when it follows its grammar exactly
 * (`inboxAnswersSectionEnd`). The folded line (`replyWords`) and search
 * (`inboxSearchReplyText`) read the words with their own, looser rule (they
 * cut at the first heading or still-open line, grammar or not); for a body
 * the store wrote the three give the same words (reply-display.test.ts checks
 * search). Display only: the stored body and what agents receive never change.
 */
export function splitInboxReplyBody(body: string): InboxReplyBodyParts {
  const lines = body.split("\n");
  let start = 0;
  if (INBOX_REPLY_SENTENCE_LINE.test(lines[0] ?? "") && (lines.length === 1 || lines[1] === "")) start = Math.min(2, lines.length);
  let sectionAt = -1;
  let sectionEnd = -1;
  for (let at = start; at < lines.length; at++) {
    if (lines[at] !== ANSWERS_SECTION_HEADING_LINE || (at > start && lines[at - 1] !== "")) continue;
    const end = inboxAnswersSectionEnd(lines, at);
    if (end === null) continue;
    sectionAt = at;
    sectionEnd = end;
    break;
  }
  const head = lines.slice(start, sectionAt >= 0 ? sectionAt : lines.length);
  const tail = sectionAt >= 0 ? lines.slice(sectionEnd) : [];
  // The still-open line is a paragraph of its own, after the words.
  const open = head.findIndex((line, i) => INBOX_STILL_OPEN_LINE.test(line) && (i === 0 || head[i - 1] === "") && (i === head.length - 1 || head[i + 1] === ""));
  const words = (open >= 0 ? head.slice(0, open) : head).join("\n").trim();
  const rest = [...(open >= 0 ? head.slice(open + 1) : []), ...tail].join("\n").trim();
  return { words, answers: sectionAt >= 0, rest, changed: start > 0 || open >= 0 || sectionAt >= 0 };
}

/**
 * The reply's first line: "Answered 2 questions.", "Skipped 3 questions.", or
 * "Answered 1 question, skipped 2." A skip is not an answer, so a Send of
 * skips alone never opens with "Answered".
 */
function replySentence(answered: number, skipped: number): string {
  if (answered > 0 && skipped > 0) return `Answered ${questionsWord(answered)}, skipped ${skipped}.`;
  if (answered > 0) return `Answered ${questionsWord(answered)}.`;
  if (skipped > 0) return `Skipped ${questionsWord(skipped)}.`;
  return "";
}

/**
 * A skip the Inbox writes for the person: a Send's, for a question the person
 * chose to skip with "Skip them" (`by_reply`: the agent reads "Skipped by
 * the person", the card "Skipped · <time>"), or a Mark read's for a question
 * it closed.
 */
export function inboxSkipAnswer(record: { key: string; kind: QuestionKind; prompt: string }, options: { byReply: boolean }): QuestionAnswer {
  return {
    v: 1,
    key: record.key,
    kind: record.kind,
    prompt: capQuestionPrompt(record.prompt),
    selected: [],
    skipped: true,
    ...(options.byReply ? { by_reply: true } : {}),
  };
}

/** Questions as `- Q1. <prompt>`, then action items as `- A1. <what to do>` (each numbered as its card). */
function numberedLines(records: readonly (Pick<InboxQuestionRecord, "position" | "prompt"> & { kind?: string })[]): string[] {
  const line = (prefix: string) => (q: Pick<InboxQuestionRecord, "position" | "prompt">) => `- ${prefix}${q.position + 1}. ${q.prompt.replace(/\s+/g, " ").trim()}`;
  const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;
  return [
    ...records.filter((q) => q.kind !== "action").sort(byPosition).map(line("Q")),
    ...records.filter((q) => q.kind === "action").sort(byPosition).map(line("A")),
  ];
}

/** The first line of a Mark read's note to the asking agent. */
export const INBOX_SET_ASIDE_HEADING = "Set aside for now; don't wait on these:";

/**
 * The note a Mark read sends the agent that asked the questions it closed
 * (approval 2026-10-11: "tells the asking agent once"): the heading, then
 * each question with its card number.
 */
export function composeInboxSetAsideBody(questions: readonly (Pick<InboxQuestionRecord, "position" | "prompt"> & { kind?: string })[]): string {
  const lines = numberedLines(questions);
  return [INBOX_SET_ASIDE_HEADING, "", ...lines, "", "The person closed them unanswered in the Inbox. Ask again if you still need an answer to go on."].join("\n");
}

/** The first line of the note an Undo of Mark read sends once the agent was told. */
export const INBOX_REOPENED_HEADING = "The person reopened these:";

/**
 * The note an Undo of Mark read sends when the asking agent was already told
 * not to wait on those questions: they are open again, and wait on the
 * person, so the agent must not go on as if they were set aside.
 */
export function composeInboxReopenedBody(questions: readonly (Pick<InboxQuestionRecord, "position" | "prompt"> & { kind?: string })[]): string {
  const lines = numberedLines(questions);
  return [INBOX_REOPENED_HEADING, "", ...lines, "", "They are open again in the Inbox; wait for the person's answer before you rely on them."].join("\n");
}

// ─────────────────────────────── Subject ───────────────────────────────

const SUBJECT_MAX = 120;

/**
 * A thread's subject when the agent gave none: the first open question's
 * prompt, else the first heading or non-empty line of the body, plain.
 * A thread the PERSON starts (compose) is named by
 * `derivePersonThreadSubject` instead (./inbox-thread-subject, re-exported
 * below): a short name, not the first 120 characters of a dictated paragraph.
 */
export function deriveInboxSubject(body: string, questions: readonly Pick<ParsedInboxQuestion, "prompt">[]): string | null {
  const pick = questions[0]?.prompt ?? firstLine(body);
  if (!pick) return null;
  const plain = pick.replace(/^#+\s*/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  // Never inside a character: a cut mid-emoji drew "�…" (cutText keeps whole graphemes).
  return cutText(plain, SUBJECT_MAX);
}

function firstLine(body: string): string | null {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line && !line.startsWith(":::") && !line.startsWith("```")) return line;
  }
  return null;
}
