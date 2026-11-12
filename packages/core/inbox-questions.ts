import { resolveReferenceLinks } from "./markdown-structure";
import { cutText } from "./text-cut";
export { cutText, sliceText } from "./text-cut";
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
  replaces: string[];
}

const STOPPED_RE = /^stopped\s*:\s*(.*)$/i;
const HOLDS_UP_RE = /^holds up\s*:\s*(.*)$/i;
const CLOSE_RE = /^\s*:::\s*$/;

export function inboxQuestionKeysWithRecommendedMarker(markdown: string): string[] {
  return questionBlocksOf(markdown).flatMap(({ key, parsed }) => (parsed.recommendedMarker ? [key] : []));
}

/** One question of a body worth a second look, in block order: `position` 1-based among the questions. */
export interface InboxQuestionToCheck {
  key: string;
  position: number;
  no_choices: string;
}

export function inboxQuestionsToCheck(markdown: string): InboxQuestionToCheck[] {
  return questionBlocksOf(markdown).flatMap(({ key, parsed }, index) =>
    parsed.directiveKind !== "question-text" && parsed.choices.length === 0 ? [{ key, position: index + 1, no_choices: `:::${parsed.directiveKind}` }] : [],
  );
}

export interface PrototypeAppTarget {
  target: string;
  prompt: string;
  label: string | null;
}
export interface PrototypeTarget extends PrototypeAppTarget {
  kind: "app" | "file";
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Every prototype a body's questions name, in block and choice order (the shared line first). Pure; never throws. */
export function prototypeTargets(markdown: string): PrototypeTarget[] {
  const out: PrototypeTarget[] = [];
  for (const { parsed } of questionBlocksOf(markdown)) {
    const named = [
      ...(parsed.prototype ? [{ target: parsed.prototype.target, label: null }] : []),
      ...parsed.choices.flatMap((choice) => (choice.prototype ? [{ target: choice.prototype.target, label: choice.label }] : [])),
    ];
    for (const { target, label } of named) out.push({ target, prompt: parsed.prompt, label, kind: SCHEME_RE.test(target) ? "app" : "file" });
  }
  return out;
}

function questionBlocksOf(markdown: string, frontmatter = false): { key: string; startLine: number; parsed: ParsedQuestion }[] {
  if (typeof markdown !== "string" || !markdown.includes(":::question")) return [];
  const resolved = resolveReferenceLinks(markdown).split("\n");
  const out: { key: string; startLine: number; parsed: ParsedQuestion }[] = [];
  for (const location of findQuestionBlocks(markdown, { frontmatter })) {
    const lines = resolved
      .slice(location.startLine - 1, location.endLine)
      .join("\n")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const inner = lines.slice(1, CLOSE_RE.test(lines.at(-1) ?? "") && lines.length > 1 ? -1 : undefined);
    const parsed = parseQuestionBlock(location.directiveKind, inner.join("\n"), { decisionLines: false, optionLines: true });
    if (parsed !== null) out.push({ key: location.key, startLine: location.startLine, parsed });
  }
  return out;
}

/** The question blocks of a message body, in block order. */
export function parseInboxQuestionBlocks(markdown: string, options: { frontmatter?: boolean } = {}): ParsedInboxQuestion[] {
  const out: ParsedInboxQuestion[] = [];
  for (const { key, startLine, parsed } of questionBlocksOf(markdown, options.frontmatter === true)) {
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
          ...(choice.pros ? { pros: [...choice.pros] } : {}),
          ...(choice.cons ? { cons: [...choice.cons] } : {}),
          ...(choice.prototype ? { prototype: prototypeFact(choice.prototype) } : {}),
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

function prototypeFact(prototype: { target: string; label?: string }): { target: string; label?: string } {
  return { target: prototype.target, ...(prototype.label ? { label: prototype.label } : {}) };
}

function contractFacts(parsed: Pick<ParsedQuestion, "stakes" | "shows" | "why" | "reversible" | "prototype">): InboxQuestionContract {
  return {
    ...(parsed.prototype ? { prototype: prototypeFact(parsed.prototype) } : {}),
    ...(parsed.stakes ? { stakes: parsed.stakes } : {}),
    ...(parsed.shows ? { shows: { kind: parsed.shows.kind, label: parsed.shows.label, src: parsed.shows.src } } : {}),
    ...(parsed.why ? { why: parsed.why } : {}),
    ...(parsed.reversible ? { reversible: { value: false as const, why: parsed.reversible.why ?? null } } : {}),
  };
}

function wireContract(facts: InboxQuestionContract): InboxQuestionContract {
  return {
    ...(typeof facts.stakes === "string" && facts.stakes ? { stakes: facts.stakes } : {}),
    ...(facts.shows ? { shows: { ...facts.shows } } : {}),
    ...(typeof facts.why === "string" && facts.why ? { why: facts.why } : {}),
    ...(facts.reversible ? { reversible: { value: false as const, why: facts.reversible.why ?? null } } : {}),
    ...(facts.prototype && typeof facts.prototype.target === "string" ? { prototype: prototypeFact(facts.prototype) } : {}),
  };
}

const NEGATIVE_WAIT_RE = /^(?:no|none|n\/a|na|nothing|false|nil|null|[-\u2013\u2014]+)[\s.,;:!?\-\u2013\u2014]*$/i;

/** Whether a `Stopped:` value or `Holds up:` entry is only a negative word. */
export function isNegativeWaitValue(value: string): boolean {
  return NEGATIVE_WAIT_RE.test(value.trim());
}

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

export function inboxQuestionState(
  record: Pick<InboxQuestionRecord, "answer" | "revision" | "sent_revision" | "superseded_by" | "set_aside"> &
    Partial<Pick<InboxQuestionRecord, "kind" | "action_result">>,
  threadResolved: boolean,
): InboxQuestionState {
  if (record.superseded_by) return "superseded";
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

// Builds through 0.28.26 may have joined a `Context:` line onto the bullet above it.
const STORED_CONTEXT_SPLIT_RE = /\s+(?:[*_]{1,2})?(?:context|stakes|shows|why|reversible)(?:[*_]{1,2})?\s*:/gi;

const UNCLOSED_IMAGE_RE = /!\[(?![^\]\n]*\]\([^)\n]+\))/;

function storedContextHeads(label: string): string[] {
  const heads: string[] = [];
  for (const match of label.matchAll(STORED_CONTEXT_SPLIT_RE)) {
    const head = label.slice(0, match.index).trim();
    if (head) heads.push(head);
  }
  return heads;
}

function storedChoices(record: Pick<InboxQuestionRecord, "parsed">): QuestionChoice[] {
  const names = record.parsed.choices.map((choice, index) =>
    new Set([choice.label, ...(record.parsed.aliases[index] ?? [])].map(normalizeQuestionText)),
  );
  const heads = record.parsed.choices.map((choice) => {
    const list = storedContextHeads(choice.label);
    const plain = questionLabelWithoutImage(choice.label);
    const out = plain ? [...list, plain, ...list.flatMap((head) => questionLabelWithoutImage(head) ?? [])] : [...list];
    if (UNCLOSED_IMAGE_RE.test(choice.label) && choice.description) {
      const rebuilt = parseQuestionChoiceText(`${choice.label} — ${choice.description}`).label;
      if (rebuilt && rebuilt !== choice.label && !out.includes(rebuilt)) out.push(rebuilt);
    }
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

export function inboxAnswerTookRecommendation(record: Pick<InboxQuestionRecord, "parsed">, answer: QuestionAnswer): boolean {
  const recommended = record.parsed.choices.filter((c) => c.recommended).map((c) => c.label);
  const suggested = record.parsed.suggested_text ?? undefined;
  return isQuestionAnswered(answer) && isRecommendedQuestionAnswer(answer, recommended, suggested, {
    ...(record.parsed.recommendation === null ? {} : { recommendation: record.parsed.recommendation }),
    choiceLabels: record.parsed.choices.map((c) => c.label),
    choiceAliases: storedChoices(record).map((c) => c.aliases),
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
    choices: record.parsed.choices.map((c) => ({
      ...c,
      ...(c.image ? { image: { ...c.image } } : {}),
      ...(c.pros ? { pros: [...c.pros] } : {}),
      ...(c.cons ? { cons: [...c.cons] } : {}),
      ...(c.prototype ? { prototype: { ...c.prototype } } : {}),
    })),
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
    ...(record.attachment ? { attachment: { ...record.attachment } } : {}),
  };
}

export function inboxFileQuestionKey(fileKey: string, taken: Set<string>): string | null {
  if (!taken.has(fileKey)) {
    taken.add(fileKey);
    return fileKey;
  }
  const base = fileKey.replace(/-\d{1,3}$/, "");
  for (let n = 2; n <= 999; n++) {
    const key = `${base}-${n}`;
    if (taken.has(key)) continue;
    taken.add(key);
    return key;
  }
  return null;
}

/** A question's place in its message: the body (null) or the attached file it is in. Sorted: the body first, then each file in the message's attachment order. */
export function inboxQuestionPlace(q: { attachment?: { id: string } | null }): string | null {
  return q.attachment?.id ?? null;
}

export function inboxQuestionsInPlaceOrder<T extends { position: number; attachment?: { id: string } | null }>(list: readonly T[]): T[] {
  const rank = new Map<string | null, number>([[null, 0]]);
  for (const q of list) {
    const place = inboxQuestionPlace(q);
    if (!rank.has(place)) rank.set(place, rank.size);
  }
  return [...list].sort((a, b) => rank.get(inboxQuestionPlace(a))! - rank.get(inboxQuestionPlace(b))! || a.position - b.position);
}

const SUPERSEDE_REF_RE = /^(msg_[0-9A-HJKMNP-TV-Z]{26})(?:\/((?:q|a)-[0-9a-f]{8}(?:-\d{1,3})?))?$/;

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

export function inboxQuestionWaitsForList(q: Pick<InboxQuestion, "state" | "kind" | "orphaned">): boolean {
  if (q.orphaned) return false;
  if (q.state === "open") return true;
  return q.state === "picked" && q.kind !== "action";
}

export function inboxQuestionWaitsOnPerson(q: Pick<InboxQuestion, "state" | "kind" | "orphaned">): boolean {
  return inboxQuestionWaitsForList(q) && readInboxQuestionKind(q.kind) !== "unknown";
}

/**
 * How urgently a waiting question holds an agent up: 0 Stopped (the agent cannot go on), 1 Holds up
 * named work, 2 neither.
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

export type InboxAnswerRefusal =
  | { code: "validation_error"; field: string; message: string }
  | { code: "question_not_found"; key: string }
  | { code: "question_revision_conflict"; key: string; current_revision: number }
  | { code: "question_already_sent"; key: string }
  | { code: "question_superseded"; key: string; superseded_by: { message_id: string; key: string | null } };

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

function exportItem(record: InboxQuestionRecord, number: number): QuestionExportItem {
  const settled = record.parsed.choices.filter((c) => c.settled).map((c) => c.label);
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

function composeReplyParts(input: {
  questions: readonly InboxQuestionRecord[];
  sent: readonly QuestionAnswer[];
  earlier: readonly QuestionAnswer[];
  words: string | undefined;
  stillOpen?: readonly InboxQuestionRecord[];
  messages?: readonly InboxReplyMessageAnswers[];
  replyTo?: string;
}): { head: string; stillOpen: string; section: string } {
  // Action items (`kind: "action"`) are reported in their own section ("Actions
  // you asked for"), never numbered or counted as questions here.
  const questionsOnly = <T extends { kind: string }>(list: readonly T[]): T[] => list.filter((q) => q.kind !== "action");
  const groups: readonly PlaceAnswers[] = (
    input.messages ?? [
      { message_id: input.questions[0]?.message_id ?? input.replyTo ?? "", questions: input.questions, sent: input.sent, earlier: input.earlier },
    ]
  )
    .map((g) => ({ ...g, questions: questionsOnly(g.questions), sent: questionsOnly(g.sent), earlier: questionsOnly(g.earlier) }))
    .flatMap(splitByPlace);
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
  const labelled =
    sentGroups.length > 1 ||
    (sentGroups.length === 1 && (sentGroups[0]!.file !== null || (input.replyTo !== undefined && sentGroups[0]!.message_id !== input.replyTo)));
  let section = "";
  if (sentGroups.length === 1 && !labelled) {
    section = answersSection(sentGroups[0]!, 2);
  } else if (sentGroups.length > 0) {
    const parts = sentGroups.flatMap((g) => {
      const body = answersSection(g, 3).replace(/^### [^\n]*\n\n/, "");
      return body === "" ? [] : [`${answersGroupHeading(g)}\n\n${body}`];
    });
    if (parts.length > 0) section = `## ${QUESTION_ANSWERS_HEADING}\n\n${parts.join("\n\n")}`;
  }
  const words = input.words?.trim() ?? "";
  // The questions this reply leaves open, and says so: the agent must not ask
  // again. A reply that answers and skips nothing keeps its own wording.
  const sentIds = new Set(groups.flatMap((g) => g.sent.map((a) => `${g.message_id}/${a.key}`)));
  const pool = questionsOnly(input.stillOpen ?? groups.flatMap((g) => g.questions)).filter((q) => !sentIds.has(`${q.message_id ?? ""}/${q.key}`));
  const stillOpen = sentGroups.length === 0 ? inboxStillOpenLine(pool) : inboxOtherStillOpenLine(pool);
  return { head: [sentence, words].filter((part) => part !== "").join("\n\n"), stillOpen, section };
}

export function composeInboxReplyBody(input: Parameters<typeof composeReplyParts>[0]): string {
  const { head, stillOpen, section } = composeReplyParts(input);
  return [head, stillOpen, section].filter((part) => part !== "").join("\n\n");
}

/** What `composeInboxReplyBody` puts before its still-open sentence, and that sentence ('' with none): how the store knows it wrote it, whatever the person typed. */
export function inboxReplyStillOpenOf(input: Parameters<typeof composeReplyParts>[0]): { head: string; stillOpen: string } {
  const { head, stillOpen } = composeReplyParts(input);
  return { head, stillOpen };
}

/** One message a reply answers questions on (`composeInboxReplyBody`'s `messages`). */
export interface InboxReplyMessageAnswers {
  message_id: string;
  questions: readonly InboxQuestionRecord[];
  sent: readonly QuestionAnswer[];
  earlier: readonly QuestionAnswer[];
}

type PlaceAnswers = InboxReplyMessageAnswers & { file: InboxQuestionRecord["attachment"] | null };

/** A file's name as one line of the reply (a name never holds a newline, but a reply's grammar must not break if one did). */
const fileNameLine = (name: string): string => name.replace(/\s+/g, " ").trim() || "file";

function splitByPlace(group: InboxReplyMessageAnswers): PlaceAnswers[] {
  if (!group.questions.some((q) => q.attachment)) return [{ ...group, file: null }];
  const places = new Map<string | null, PlaceAnswers>([[null, { message_id: group.message_id, questions: [], sent: [], earlier: [], file: null }]]);
  const placeOfKey = new Map<string, string | null>();
  for (const q of group.questions) {
    const place = inboxQuestionPlace(q);
    if (!places.has(place)) places.set(place, { message_id: group.message_id, questions: [], sent: [], earlier: [], file: q.attachment ?? null });
    (places.get(place)!.questions as InboxQuestionRecord[]).push(q);
    placeOfKey.set(q.key, place);
  }
  for (const a of group.sent) (places.get(placeOfKey.get(a.key) ?? null)!.sent as QuestionAnswer[]).push(a);
  for (const a of group.earlier) (places.get(placeOfKey.get(a.key) ?? null)!.earlier as QuestionAnswer[]).push(a);
  return [...places.values()].filter((p) => p.file === null || p.questions.length > 0);
}

function answersGroupHeading(group: PlaceAnswers): string {
  return group.file ? `### Your file ${fileNameLine(group.file.name)}, attached to message ${group.message_id}` : `### Your message ${group.message_id}`;
}

function answersSection(group: InboxReplyMessageAnswers, headingLevel: 2 | 3): string {
  const items = [...group.questions]
    .sort((a, b) => a.position - b.position)
    .map((q, i) => (q.superseded_by ? null : exportItem(q, i + 1)))
    .filter((item): item is QuestionExportItem => item !== null);
  return formatQuestionAnswersSection(items, [...group.sent, ...group.earlier], { headingLevel }).trimEnd();
}

export function composeInboxReaskBody(input: {
  reask: readonly (Pick<InboxQuestionRecord, "id" | "prompt"> & { kind?: string })[];
  answered: readonly { record: Pick<InboxQuestionRecord, "id" | "prompt" | "parsed">; answer: QuestionAnswer }[];
  noteId: string;
  askedBy?: string | null;
}): string {
  const n = input.reask.length;
  const actions = input.reask.filter((r) => r.kind === "action").length;
  const questions = n - actions;
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
      section += `### ${record.prompt.replace(/\s+/g, " ").trim()} (${record.id})\n`;
      section += formatQuestionAnswerLines(answer, { recommended: inboxAnswerTookRecommendation(record, answer) });
      section += "\n";
    }
    lines.push("", section.trimEnd());
  }
  return lines.join("\n");
}

export function inboxStillOpenLine(questions: readonly InboxQuestionRecord[]): string {
  const states = questions.map((q) => inboxQuestionState(q, false));
  const open = states.filter((s) => s === "open" || s === "picked").length;
  if (open === 0) return "";
  if (states.includes("sent")) {
    return `No new answers in this reply; ${questionsWord(open)} ${open === 1 ? "is" : "are"} still open. Don't re-ask ${open === 1 ? "it" : "them"}; the person will answer in the Inbox.`;
  }
  if (open === 1) return "No question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.";
  return `No questions answered yet; all ${open} are still open. Don't re-ask them; the person will answer in the Inbox.`;
}

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
const ANSWERS_GROUP_LINE = /^### Your (?:message|file .+, attached to message) msg_[A-Za-z0-9]+$/;

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

function answerBlocksEnd(lines: readonly string[], from: number, h: "###" | "####"): number | null {
  if (!/^\d+ of \d+ questions? answered\./.test(lines[from] ?? "") || lines[from + 1] !== "") return null;
  let i = from + 2;
  let blocks = 0;
  while (i < lines.length && lines[i]!.startsWith(`${h} `)) {
    i += 1;
    let body = 0;
    while (i < lines.length && lines[i] !== "") {
      if (!/^(Answer|Note|Skipped|- |> |>$| {2}> | {2}>$)/.test(lines[i]!)) return null;
      i += 1;
      body += 1;
    }
    if (body === 0 && lines[i - 1] !== `${h} Unanswered`) return null;
    blocks += 1;
    if (i < lines.length) i += 1;
  }
  return blocks > 0 ? i : null;
}

/** A person's reply body in its parts (`splitInboxReplyBody`). */
export interface InboxReplyBodyParts {
  words: string;
  answers: boolean;
  rest: string;
  changed: boolean;
}

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
  const open = head.findIndex((line, i) => INBOX_STILL_OPEN_LINE.test(line) && (i === 0 || head[i - 1] === "") && (i === head.length - 1 || head[i + 1] === ""));
  const words = (open >= 0 ? head.slice(0, open) : head).join("\n").trim();
  const rest = [...(open >= 0 ? head.slice(open + 1) : []), ...tail].join("\n").trim();
  return { words, answers: sectionAt >= 0, rest, changed: start > 0 || open >= 0 || sectionAt >= 0 };
}

function replySentence(answered: number, skipped: number): string {
  if (answered > 0 && skipped > 0) return `Answered ${questionsWord(answered)}, skipped ${skipped}.`;
  if (answered > 0) return `Answered ${questionsWord(answered)}.`;
  if (skipped > 0) return `Skipped ${questionsWord(skipped)}.`;
  return "";
}

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

function numberedLines(records: readonly (Pick<InboxQuestionRecord, "position" | "prompt" | "attachment"> & { kind?: string })[]): string[] {
  const line = (prefix: string) => (q: Pick<InboxQuestionRecord, "position" | "prompt" | "attachment">) =>
    `- ${prefix}${q.position + 1}. ${q.prompt.replace(/\s+/g, " ").trim()}${q.attachment ? ` (in your file ${fileNameLine(q.attachment.name)})` : ""}`;
  return [
    ...inboxQuestionsInPlaceOrder(records.filter((q) => q.kind !== "action")).map(line("Q")),
    ...inboxQuestionsInPlaceOrder(records.filter((q) => q.kind === "action")).map(line("A")),
  ];
}

/** The first line of a Mark read's note to the asking agent. */
export const INBOX_SET_ASIDE_HEADING = "Set aside for now; don't wait on these:";

export function composeInboxSetAsideBody(questions: readonly (Pick<InboxQuestionRecord, "position" | "prompt" | "attachment"> & { kind?: string })[]): string {
  const lines = numberedLines(questions);
  return [INBOX_SET_ASIDE_HEADING, "", ...lines, "", "The person closed them unanswered in the Inbox. Ask again if you still need an answer to go on."].join("\n");
}

/** The first line of the note an Undo of Mark read sends once the agent was told. */
export const INBOX_REOPENED_HEADING = "The person reopened these:";

export function composeInboxReopenedBody(questions: readonly (Pick<InboxQuestionRecord, "position" | "prompt" | "attachment"> & { kind?: string })[]): string {
  const lines = numberedLines(questions);
  return [INBOX_REOPENED_HEADING, "", ...lines, "", "They are open again in the Inbox; wait for the person's answer before you rely on them."].join("\n");
}

const SUBJECT_MAX = 120;

/**
 * A thread's subject when the agent gave none: the first open question's prompt, else the first
 * heading or non-empty line of the body, plain.
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
