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

export const questionAnswerToAnnotation = (
  blockId: string,
  answer: QuestionAnswer,
  createdA?: number,
): Annotation => {
  const record = buildQuestionAnswerAnnotation(blockId, answer, createdA);
  return { ...record, type: AnnotationType.COMMENT };
};

export const collectQuestionAnswers = (annotations: ReadonlyArray<Annotation>): Map<string, QuestionAnswer> => {
  const out = new Map<string, QuestionAnswer>();
  for (const ann of annotations) {
    if (ann.questionAnswer == null) continue;
    const answer = parseQuestionAnswer(ann.questionAnswer);
    if (answer && !out.has(answer.key)) out.set(answer.key, answer);
  }
  return out;
};

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

export const isQuestionAnswerAnnotation = (ann: Pick<Annotation, 'questionAnswer'>): boolean =>
  ann.questionAnswer != null && parseQuestionAnswer(ann.questionAnswer) !== null;

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

export interface QuestionPanelRow {
  key: string;
  number?: number;
  prompt: string;
  line?: number;
  blockId?: string;
  status: QuestionStatus;
  answerText?: string;
  hasNote: boolean;
  annotationId?: string;
  orphaned: boolean;
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const answerSummary = (answer: QuestionAnswer): string => {
  const parts = [...answer.selected.map(oneLine)];
  if (answer.other?.trim()) parts.push(`Other: ${oneLine(answer.other)}`);
  if (answer.text?.trim()) parts.push(oneLine(answer.text));
  return parts.join('; ');
};

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

export const questionProgress = (rows: ReadonlyArray<QuestionPanelRow>): { done: number; total: number } => {
  const live = rows.filter((r) => !r.orphaned);
  return {
    done: live.filter((r) => r.status === 'answered' || r.status === 'settled').length,
    total: live.length,
  };
};

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

export const focusQuestionCard = (key: string, root: ParentNode = document): boolean => {
  const card = root.querySelector<HTMLElement>(`fieldset[data-question-key="${key.replace(/"/g, '')}"]`);
  if (!card) return false;
  card.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  const control = card.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])');
  control?.focus({ preventScroll: true });
  return true;
};
