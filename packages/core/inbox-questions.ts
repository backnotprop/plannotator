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
 * Pure: no I/O, no clock unless passed in. Never throws on any input.
 */

import { resolveReferenceLinks } from "./markdown-structure";
import {
  canonicalQuestionAnswer,
  findQuestionBlocks,
  formatQuestionAnswersSection,
  isQuestionAnswerEmpty,
  MAX_QUESTION_PROMPT_CHARS,
  parseQuestionAnswer,
  parseQuestionBlock,
  type QuestionAnswer,
  type QuestionChoice,
  type QuestionExportItem,
  type QuestionKind,
} from "./question-block";
import type {
  InboxDecisionDraft,
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
  decision_on_answer: boolean;
}

const STOPPED_RE = /^stopped\s*:\s*(.*)$/i;
const HOLDS_UP_RE = /^holds up\s*:\s*(.*)$/i;
const CLOSE_RE = /^\s*:::\s*$/;

/**
 * The question blocks of a message body, in block order. A body is read like
 * a comment: no frontmatter. A body with no block (or none that parses)
 * answers [].
 */
export function parseInboxQuestionBlocks(markdown: string): ParsedInboxQuestion[] {
  if (typeof markdown !== "string" || !markdown.includes(":::question")) return [];
  // Each block is read over the markdown with reference links resolved, as
  // the renderer reads it, so a prompt written with a reference link keeps
  // the key the card computes.
  const resolved = resolveReferenceLinks(markdown).split("\n");
  const out: ParsedInboxQuestion[] = [];
  for (const location of findQuestionBlocks(markdown, { frontmatter: false })) {
    const lines = resolved
      .slice(location.startLine - 1, location.endLine)
      .join("\n")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const inner = lines.slice(1, CLOSE_RE.test(lines.at(-1) ?? "") && lines.length > 1 ? -1 : undefined);
    const parsed = parseQuestionBlock(location.directiveKind, inner.join("\n"));
    if (parsed === null) continue;
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
        })),
        aliases: parsed.choices.map((choice) => (choice.aliases?.length ? [...choice.aliases] : null)),
        recommendation: parsed.recommendation ?? null,
        suggested_text: parsed.suggestedText ?? null,
        line: location.startLine + 1 + parsed.promptLine,
      },
      ...waitsOf(context),
      decision_on_answer: parsed.decisionOnAnswer === true,
    });
  }
  return out;
}

/** The `Stopped:` and `Holds up:` lines of a block's context; the first of each wins. */
function waitsOf(context: string): { stopped: string | null; holds_up: string[] } {
  let stopped: string | null = null;
  let holdsUp: string[] | null = null;
  for (const raw of context.split("\n")) {
    const line = raw.trim();
    if (stopped === null) {
      const match = STOPPED_RE.exec(line);
      if (match !== null) {
        stopped = (match[1] ?? "").trim();
        continue;
      }
    }
    if (holdsUp === null) {
      const match = HOLDS_UP_RE.exec(line);
      if (match !== null) {
        holdsUp = (match[1] ?? "")
          .split(";")
          .map((name) => name.trim())
          .filter((name) => name !== "");
      }
    }
  }
  return { stopped, holds_up: holdsUp ?? [] };
}

/** Derived, never stored: closed when the thread is resolved, else open / picked / sent. */
export function inboxQuestionState(
  record: Pick<InboxQuestionRecord, "answer" | "revision" | "sent_revision">,
  threadResolved: boolean,
): InboxQuestionState {
  if (threadResolved) return "closed";
  if (record.answer === null) return "open";
  if (record.revision > 0 && record.sent_revision === record.revision) return "sent";
  return "picked";
}

/** The choices with their older names, for `canonicalQuestionAnswer`. */
function storedChoices(record: Pick<InboxQuestionRecord, "parsed">): QuestionChoice[] {
  return record.parsed.choices.map((choice, index) => {
    const aliases = record.parsed.aliases[index];
    return {
      label: choice.label,
      settled: choice.settled,
      recommended: choice.recommended,
      ...(choice.description !== null ? { description: choice.description } : {}),
      ...(aliases ? { aliases } : {}),
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
    choices: record.parsed.choices.map((c) => ({ ...c })),
    recommendation: record.parsed.recommendation,
    suggested_text: record.parsed.suggested_text,
    decision_on_answer: record.decision_on_answer,
    stopped: record.stopped,
    holds_up: [...record.holds_up],
    asked_by_agent_id: record.asked_by_agent_id,
    orphaned: false,
    state: inboxQuestionState(record, threadResolved),
    answer: record.answer === null ? null : canonicalQuestionAnswer({ choices: storedChoices(record) }, record.answer),
    revision: record.revision,
    sent_revision: record.sent_revision,
    picked_by: record.picked_by,
    picked_at: record.picked_at,
    sent_reply_id: record.sent_reply_id,
    decision_id: record.decision_id,
    message_id: record.message_id,
    decision_recording: inboxDecisionRecording(record),
    decision_draft: record.decision_draft ?? null,
  };
}

/** Workspaces' row summary over a thread's questions (open ones only for the badges). */
export function summarizeInboxQuestions(questions: readonly InboxQuestion[]): InboxQuestionSummary {
  let open = 0;
  let picked = 0;
  let stopped = false;
  const holdsUp: string[] = [];
  let prompt: string | null = null;
  for (const q of questions) {
    if (q.orphaned) continue;
    if (q.state === "picked") picked += 1;
    if (q.state !== "open") continue;
    open += 1;
    if (q.stopped !== null) stopped = true;
    for (const name of q.holds_up) if (!holdsUp.includes(name)) holdsUp.push(name);
    if (prompt === null) prompt = q.prompt;
  }
  return { open, picked, stopped, holds_up: holdsUp, prompt };
}

// ─────────────────────────────── Picks ───────────────────────────────

export type InboxAnswerRefusal =
  | { code: "validation_error"; field: string; message: string }
  | { code: "question_not_found"; key: string }
  | { code: "question_revision_conflict"; key: string; current_revision: number }
  | { code: "question_already_sent"; key: string };

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
  if (parsed.prompt !== record.prompt.slice(0, MAX_QUESTION_PROMPT_CHARS)) {
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
  const hasAliases = record.parsed.aliases.some((a) => a !== null);
  return {
    key: record.key,
    number,
    prompt: record.prompt,
    line: record.parsed.line,
    recommendedLabels: record.parsed.choices.filter((c) => c.recommended).map((c) => c.label),
    ...(record.parsed.suggested_text === null ? {} : { suggestedText: record.parsed.suggested_text }),
    settled: settled.length > 0,
    settledLabels: settled,
    ...(hasAliases
      ? {
          choices: record.parsed.choices.map((c, i) => ({
            label: c.label,
            ...(record.parsed.aliases[i] ? { aliases: record.parsed.aliases[i]! } : {}),
          })),
        }
      : {}),
  };
}

/**
 * The body a Send writes: "Answered N questions." when it carries answers,
 * the person's words if any, then Plannotator's "Answers to your questions"
 * section over every question of the message, with the answers this Send
 * carries and earlier sent answers that still stand. Empty when there is
 * nothing to send.
 */
export function composeInboxReplyBody(input: {
  questions: readonly InboxQuestionRecord[];
  sent: readonly QuestionAnswer[];
  earlier: readonly QuestionAnswer[];
  words: string | undefined;
}): string {
  const count = input.sent.filter((a) => !isQuestionAnswerEmpty(a)).length;
  const sentence = count > 0 ? `Answered ${count} question${count === 1 ? "" : "s"}.` : "";
  const items = [...input.questions].sort((a, b) => a.position - b.position).map((q, i) => exportItem(q, i + 1));
  const section = input.sent.length > 0 ? formatQuestionAnswersSection(items, [...input.sent, ...input.earlier]).trimEnd() : "";
  const words = input.words?.trim() ?? "";
  return [sentence, words, section].filter((part) => part !== "").join("\n\n");
}

// ─────────────────────────────── Subject ───────────────────────────────

const SUBJECT_MAX = 120;

/**
 * A thread's subject when the agent gave none: the first open question's
 * prompt, else the first heading or non-empty line of the body, plain.
 */
export function deriveInboxSubject(body: string, questions: readonly Pick<ParsedInboxQuestion, "prompt">[]): string | null {
  const pick = questions[0]?.prompt ?? firstLine(body);
  if (!pick) return null;
  const plain = pick.replace(/^#+\s*/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  return plain.length > SUBJECT_MAX ? `${plain.slice(0, SUBJECT_MAX - 1)}…` : plain;
}

function firstLine(body: string): string | null {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line && !line.startsWith(":::") && !line.startsWith("```")) return line;
  }
  return null;
}

// ─────────────────────── Decisions drafted from an answer (step 3) ───────────────────────
//
// The words of a decision drafted from an answer, and whether a question
// records one. The window's decision card shows these words before Send, and
// the server records the same words at Send when the person left them as
// drafted. The approved Workspaces words (`inbox-decision-toggle`,
// 2026-10-06, item 4, "the answer first"): the statement is the answer, the
// Why line is "Asked by <agent>: <question>".

const oneDecisionLine = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** "A", "A and B", "A, B and C". */
function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * The statement drafted from an answer: the chosen label(s) as a sentence
 * ("Retry with the same idempotency key."), several joined with commas and
 * "and", Other or a written answer as written. Null when the answer decides
 * nothing: a Skip, or nothing picked or written.
 */
export function draftInboxDecisionText(answer: Pick<QuestionAnswer, "selected" | "other" | "text" | "skipped"> | null): string | null {
  if (!answer || answer.skipped) return null;
  const parts = [...answer.selected, ...(answer.other ? [answer.other] : []), ...(answer.text ? [answer.text] : [])]
    .map(oneDecisionLine)
    .filter((part) => part !== "");
  if (parts.length === 0) return null;
  const joined = joinWords(parts);
  const sentence = `${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
  return /[.!?…]$/u.test(sentence) ? sentence : `${sentence}.`;
}

/** The Why line: "Asked by <agent>: <the question>". */
export function draftInboxDecisionReason(askerName: string, prompt: string): string {
  return `Asked by ${oneDecisionLine(askerName) || "An agent"}: ${oneDecisionLine(prompt)}`;
}

/**
 * Whether Send records this question's answer as a decision: the person's
 * switch when they touched it, else on exactly when the block says
 * `Decision: when answered`.
 */
export function inboxDecisionRecording(record: Pick<InboxQuestionRecord, "decision_recording" | "decision_on_answer">): boolean {
  return record.decision_recording ?? record.decision_on_answer;
}

/**
 * The words a decision from this answer records: the card's edits where the
 * person made them, the drafted words elsewhere. `text` is null when there
 * is nothing to record (a Skip, nothing picked, and no edited statement).
 */
export function inboxDecisionWords(input: {
  answer: Pick<QuestionAnswer, "selected" | "other" | "text" | "skipped"> | null;
  prompt: string;
  askerName: string;
  draft: InboxDecisionDraft | null | undefined;
}): { text: string | null; reason: string } {
  const edited = input.draft?.text?.trim() || null;
  return {
    text: input.answer?.skipped ? null : (edited ?? draftInboxDecisionText(input.answer)),
    reason: input.draft?.reason ?? draftInboxDecisionReason(input.askerName, input.prompt),
  };
}
