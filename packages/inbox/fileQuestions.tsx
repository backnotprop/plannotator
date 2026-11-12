import { useMemo } from 'react';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { IndexedQuestion, QuestionAnswer, QuestionStatus } from '@plannotator/core/question-block';

export interface FileQuestions {
  records: readonly InboxQuestion[];
  answers: ReadonlyMap<string, QuestionAnswer>;
  locked: boolean;
  onPick: (key: string, answer: QuestionAnswer | null) => void;
  footerFor: (key: string) => string | null;
  focus?: { key: string; seq: number } | null;
}

const DRAFT_STATUS = { label: 'Draft', tone: 'open' } as const;

export function fileQuestionRecords(message: Pick<InboxMessageWire, 'questions'> | undefined, attachmentId: string): InboxQuestion[] {
  return (message?.questions ?? []).filter((q) => q.attachment?.id === attachmentId);
}

export function recordsByFileKey(records: readonly InboxQuestion[]): Map<string, InboxQuestion> {
  const out = new Map<string, InboxQuestion>();
  for (const r of records) if (r.attachment) out.set(r.attachment.key, r);
  return out;
}

export function fileQuestionLocked(record: InboxQuestion | undefined, locked: boolean): boolean {
  if (locked || !record) return true;
  return record.state !== 'open' && record.state !== 'picked';
}

export function fileQuestionAnswers(byFileKey: ReadonlyMap<string, InboxQuestion>, answers: ReadonlyMap<string, QuestionAnswer>): Map<string, QuestionAnswer> {
  const out = new Map<string, QuestionAnswer>();
  for (const [fileKey, record] of byFileKey) {
    const answer = answers.get(record.key);
    if (answer) out.set(fileKey, answer);
  }
  return out;
}

export function useFileQuestionViewerProps(questions: FileQuestions | null | undefined) {
  const records = questions?.records;
  const answers = questions?.answers;
  const locked = questions?.locked ?? true;
  const onPick = questions?.onPick;
  const footerFor = questions?.footerFor;
  return useMemo(() => {
    if (!records || records.length === 0 || !answers || !onPick || !footerFor) return {};
    const byFileKey = recordsByFileKey(records);
    return {
      questionAnswers: fileQuestionAnswers(byFileKey, answers),
      onAnswerQuestion: (_blockId: string, answer: QuestionAnswer | null, fileKey: string) => {
        const record = byFileKey.get(fileKey);
        if (!fileQuestionLocked(record, locked)) onPick(record!.key, answer);
      },
      questionReadOnly: (indexed: IndexedQuestion) => fileQuestionLocked(byFileKey.get(indexed.question.key), locked),
      questionStatusLabel: (indexed: IndexedQuestion, status: QuestionStatus) => {
        if (status !== 'answered' && status !== 'skipped') return undefined;
        const record = byFileKey.get(indexed.question.key);
        return record && (record.state === 'open' || record.state === 'picked') ? DRAFT_STATUS : undefined;
      },
      renderQuestionFooter: (indexed: IndexedQuestion) => {
        const record = byFileKey.get(indexed.question.key);
        const text = record ? footerFor(record.key) : null;
        return text ? <span className="ib-qfoot-st">{text}</span> : null;
      },
      questionContractLines: true,
      questionOptionLines: true,
    };
  }, [records, answers, locked, onPick, footerFor]);
}
