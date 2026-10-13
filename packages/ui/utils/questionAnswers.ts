/**
 * Glue between `:::question` answers (`@plannotator/core/question-block`)
 * and the UI's `Annotation` list. An answer is ONE annotation carrying
 * `questionAnswer`, id `ann-question-<key>`, so drafts, reload, the panel and
 * host persistence carry it with no second store. These helpers are pure; a
 * host (or Plannotator's editor) calls `upsertQuestionAnswerAnnotation` from
 * the Viewer's `onAnswerQuestion` and stores the returned list.
 */
import {
  buildQuestionAnswerAnnotation,
  canonicalQuestionAnswer,
  indexQuestionBlocks,
  isQuestionAnswerEmpty,
  isQuestionAnswered,
  parseQuestionAnswer,
  questionAnswerAnnotationId,
  questionStatus,
  type QuestionAnswer,
  type QuestionSourceBlock,
  type QuestionStatus,
} from '@plannotator/core/question-block';
import { AnnotationType, type Annotation } from '../types';

/** The answer annotation for a question block, typed for the UI. */
export const questionAnswerToAnnotation = (
  blockId: string,
  answer: QuestionAnswer,
  createdA?: number,
): Annotation => {
  const record = buildQuestionAnswerAnnotation(blockId, answer, createdA);
  return { ...record, type: AnnotationType.COMMENT };
};

/** Valid answers in an annotation list, keyed by question key (first wins).
 *  Malformed `questionAnswer` values are skipped, never thrown on. */
export const collectQuestionAnswers = (annotations: ReadonlyArray<Annotation>): Map<string, QuestionAnswer> => {
  const out = new Map<string, QuestionAnswer>();
  for (const ann of annotations) {
    if (ann.questionAnswer == null) continue;
    const answer = parseQuestionAnswer(ann.questionAnswer);
    if (answer && !out.has(answer.key)) out.set(answer.key, answer);
  }
  return out;
};

/** The answers the cards draw, keyed by question key. A host that keeps its
 *  answers itself passes them (a Map or a plain object keyed by the
 *  de-duplicated question key) and they replace the annotation-derived ones
 *  outright; each entry is validated like any other reader, so a malformed
 *  one is dropped. Without host answers this is `collectQuestionAnswers`. */
export const resolveQuestionAnswers = (
  annotations: ReadonlyArray<Annotation>,
  hostAnswers?: ReadonlyMap<string, QuestionAnswer> | Readonly<Record<string, QuestionAnswer>> | null,
): Map<string, QuestionAnswer> => {
  if (!hostAnswers) return collectQuestionAnswers(annotations);
  const entries: Array<[string, unknown]> = hostAnswers instanceof Map
    ? [...hostAnswers.entries()]
    : Object.entries(hostAnswers);
  const out = new Map<string, QuestionAnswer>();
  for (const [key, value] of entries) {
    const answer = parseQuestionAnswer(value);
    if (answer) out.set(key, answer);
  }
  return out;
};

/** Whether an annotation is a question answer (validated). */
export const isQuestionAnswerAnnotation = (ann: Pick<Annotation, 'questionAnswer'>): boolean =>
  ann.questionAnswer != null && parseQuestionAnswer(ann.questionAnswer) !== null;

/**
 * Apply one `onAnswerQuestion(blockId, answer, key)` call to an annotation
 * list: replace the question's answer annotation in place (keeping its
 * `createdA` and position), append it when new, or remove it when `answer`
 * is null or empty. Returns the same array when nothing changed.
 */
export const upsertQuestionAnswerAnnotation = (
  annotations: ReadonlyArray<Annotation>,
  blockId: string,
  answer: QuestionAnswer | null,
  key: string,
): Annotation[] => {
  const id = questionAnswerAnnotationId(key);
  const index = annotations.findIndex((a) => a.id === id);
  const valid = answer ? parseQuestionAnswer(answer) : null;
  if (!valid || isQuestionAnswerEmpty(valid)) {
    if (index === -1) return annotations as Annotation[];
    return annotations.filter((_, i) => i !== index);
  }
  const existing = index === -1 ? undefined : annotations[index];
  const next = questionAnswerToAnnotation(blockId, valid, existing?.createdA);
  if (existing?.author) next.author = existing.author;
  if (index === -1) return [...annotations, next];
  const copy = annotations.slice();
  copy[index] = next;
  return copy;
};

// ─────────────────────────── Panel + progress ───────────────────────────

/** One row of the annotations panel's Questions section. */
export interface QuestionPanelRow {
  key: string;
  /** "Question N of M" number; absent for an answer whose question is gone. */
  number?: number;
  prompt: string;
  /** Document line of the prompt, when the question is in the document. */
  line?: number;
  /** The question block, when the question is in the document. */
  blockId?: string;
  status: QuestionStatus;
  /** One line describing the answer: the picks, Other or free text; the
   *  settled choice; `Skipped`. Absent while the question is open. */
  answerText?: string;
  hasNote: boolean;
  /** The answer's annotation, when there is one. */
  annotationId?: string;
  /** The answer's question is no longer in the document (the prompt was
   *  edited or the block removed). The answer still exports. */
  orphaned: boolean;
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const answerSummary = (answer: QuestionAnswer): string => {
  const parts = [...answer.selected.map(oneLine)];
  if (answer.other?.trim()) parts.push(`Other: ${oneLine(answer.other)}`);
  if (answer.text?.trim()) parts.push(oneLine(answer.text));
  return parts.join('; ');
};

/**
 * The Questions section rows for a document: every question block in
 * document order, then one row per answer whose question is no longer in the
 * document (`orphaned`). Pure; the status rule is core's `questionStatus`, the
 * same one the card draws.
 */
export const buildQuestionPanelRows = (
  blocks: ReadonlyArray<QuestionSourceBlock>,
  annotations: ReadonlyArray<Annotation>,
): QuestionPanelRow[] => {
  const index = indexQuestionBlocks(blocks);
  const answers = collectQuestionAnswers(annotations);
  const rows: QuestionPanelRow[] = [];
  const seen = new Set<string>();
  for (const { blockId, number, line, question } of index) {
    seen.add(question.key);
    const stored = answers.get(question.key);
    const answer = stored && canonicalQuestionAnswer(question, stored);
    const status = questionStatus(question, answer);
    const settledLabels = question.choices.filter((c) => c.settled).map((c) => oneLine(c.label));
    const answerText = status === 'answered' && answer
      ? answerSummary(answer)
      : status === 'skipped'
        ? 'Skipped'
        : status === 'settled'
          ? `${settledLabels.join('; ')} (settled)`
          : undefined;
    rows.push({
      key: question.key,
      number,
      prompt: question.prompt,
      line,
      blockId,
      status,
      ...(answerText ? { answerText } : {}),
      hasNote: !!answer?.note?.trim(),
      ...(answer ? { annotationId: questionAnswerAnnotationId(question.key) } : {}),
      orphaned: false,
    });
  }
  for (const answer of answers.values()) {
    if (seen.has(answer.key)) continue;
    const status: QuestionStatus = isQuestionAnswered(answer) ? 'answered' : answer.skipped ? 'skipped' : 'open';
    const answerText = status === 'answered' ? answerSummary(answer) : status === 'skipped' ? 'Skipped' : undefined;
    rows.push({
      key: answer.key,
      prompt: answer.prompt,
      status,
      ...(answerText ? { answerText } : {}),
      hasNote: !!answer.note?.trim(),
      annotationId: questionAnswerAnnotationId(answer.key),
      orphaned: true,
    });
  }
  return rows;
};

/** Progress over the document's questions (orphaned answers excluded):
 *  `done` counts answered and settled questions, `total` every question. */
export const questionProgress = (rows: ReadonlyArray<QuestionPanelRow>): { done: number; total: number } => {
  const live = rows.filter((r) => !r.orphaned);
  return {
    done: live.filter((r) => r.status === 'answered' || r.status === 'settled').length,
    total: live.length,
  };
};

/**
 * The key of the next open question after `afterKey` in document order,
 * wrapping around; the first open question when `afterKey` is absent or not
 * a question. Null when no question is open (answered, settled and skipped
 * questions are not open).
 */
export const nextOpenQuestionKey = (
  rows: ReadonlyArray<QuestionPanelRow>,
  afterKey?: string | null,
): string | null => {
  const live = rows.filter((r) => !r.orphaned);
  const start = afterKey ? live.findIndex((r) => r.key === afterKey) : -1;
  for (let step = 1; step <= live.length; step++) {
    const row = live[(start + step) % live.length];
    if (row.status === 'open') return row.key;
  }
  return null;
};

/** Scroll a question card into view and focus its first control (the
 *  first choice, or the text box). Returns false when the card is not in
 *  the DOM. The focus does not scroll; the card scrolls smoothly to the
 *  centre. */
export const focusQuestionCard = (key: string, root: ParentNode = document): boolean => {
  const card = root.querySelector<HTMLElement>(`fieldset[data-question-key="${key.replace(/"/g, '')}"]`);
  if (!card) return false;
  card.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  const control = card.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])');
  control?.focus({ preventScroll: true });
  return true;
};
