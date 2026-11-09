/**
 * Questions inside an attached Markdown file (issue #2828): the file's
 * `:::question` cards answer like the message body's. The store keeps each
 * as a question of its message (`InboxQuestion.attachment`), so the pick, the
 * thread's "N questions open", the reply's draft and the Send are the body's
 * own. Here: the Viewer props that make the open file's cards those records'
 * cards, mapped between the key a card computes in the file
 * (`attachment.key`) and the record's key (unique in its message), and the
 * rules the body's cards follow (Thread.tsx `MessageBody`): only an open or
 * picked question takes an answer; a pick not sent tags its card "Draft"; a
 * card the file shows that no record names (the file changed since it was
 * sent, or a message sent before this) stays read-only.
 */

import { useMemo } from 'react';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { IndexedQuestion, QuestionAnswer, QuestionStatus } from '@plannotator/core/question-block';

/** The open file's questions, as the thread hands them to the pane. */
export interface FileQuestions {
  /** The file's question records (each with `attachment`), as the thread reads them now. */
  records: readonly InboxQuestion[];
  /** The answers on screen, a pick being saved included, by record key. */
  answers: ReadonlyMap<string, QuestionAnswer>;
  /** No card takes an answer now (the message is closed, or every question of it was sent). */
  locked: boolean;
  /** A pick on a card, by record key (the thread's own pick). */
  onPick: (key: string, answer: QuestionAnswer | null) => void;
  /** The card's footer status ("Picked 8:48 AM · in your draft"), by record key. */
  footerFor: (key: string) => string | null;
  /** A card to bring into view (the open questions list, a reply's answer row): its record key; `seq` changes per ask. */
  focus?: { key: string; seq: number } | null;
}

/** The status tag a pick not sent shows, as on the body's cards. */
const DRAFT_STATUS = { label: 'Draft', tone: 'open' } as const;

/** The records of `message` asked inside the attachment `attachmentId`. */
export function fileQuestionRecords(message: Pick<InboxMessageWire, 'questions'> | undefined, attachmentId: string): InboxQuestion[] {
  return (message?.questions ?? []).filter((q) => q.attachment?.id === attachmentId);
}

/** The record a card computes `fileKey` for, by the file's key. */
export function recordsByFileKey(records: readonly InboxQuestion[]): Map<string, InboxQuestion> {
  const out = new Map<string, InboxQuestion>();
  for (const r of records) if (r.attachment) out.set(r.attachment.key, r);
  return out;
}

/** Whether a card takes no answer: locked, no record names it, or its record is not open or picked (sent, closed, replaced). */
export function fileQuestionLocked(record: InboxQuestion | undefined, locked: boolean): boolean {
  if (locked || !record) return true;
  return record.state !== 'open' && record.state !== 'picked';
}

/** The answers the cards read, by the file's keys. */
export function fileQuestionAnswers(byFileKey: ReadonlyMap<string, InboxQuestion>, answers: ReadonlyMap<string, QuestionAnswer>): Map<string, QuestionAnswer> {
  const out = new Map<string, QuestionAnswer>();
  for (const [fileKey, record] of byFileKey) {
    const answer = answers.get(record.key);
    if (answer) out.set(fileKey, answer);
  }
  return out;
}

/**
 * The file Viewer's question props for `questions` (absent or null: none, and
 * the cards stay read-only as before). The cards draw as the body's do: the
 * contract lines and the option lines read (Thread.tsx `MessageBody`).
 */
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
