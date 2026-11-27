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
 * sent, or a message sent before this) stays read-only. A card that repeats
 * a body question (`inboxFileQuestionTwin`: the store recorded none for it)
 * is the body's record's card.
 */

import { useMemo } from 'react';
import { inboxFileQuestionTwin } from '@plannotator/core/inbox-file-question-twin';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { IndexedQuestion, QuestionAnswer, QuestionStatus } from '@plannotator/core/question-block';

/** The open file's questions, as the thread hands them to the pane. */
export interface FileQuestions {
  /** The file's question records (each with `attachment`) and the body's questions its cards may repeat, as the thread reads them now. */
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
  /** The thread's questions moved to another thread (its root's `moved_to`): an archive-closed card reads "Closed". */
  moved?: boolean;
}

/** The status tag a pick not sent shows, as on the body's cards. */
const DRAFT_STATUS = { label: 'Draft', tone: 'open' } as const;
/**
 * A question the archive closed (state `closed` with no Mark read): the card's own tag reads its answer, and it has
 * none, so it would say "Open". The words and muted tone an archived action item's badge already has
 * (ActionChecklist). The body's cards use it too (useQuestionCards).
 */
export const ARCHIVE_CLOSED_STATUS = { label: 'Closed', tone: 'skip' } as const;
/**
 * The archive closed it unanswered: `closed` with no Mark read's `set_aside_at` (a Mark read's has its skip
 * answer's tag) and never sent. An answer or skip the person sent before the archive reads `closed` too, and keeps
 * its own "Answered" / "Skipped" tag.
 */
export const closedByArchive = (q: Pick<InboxQuestion, 'state' | 'set_aside_at' | 'sent_reply_id' | 'revision' | 'sent_revision'> | undefined): boolean =>
  q?.state === 'closed' && !q.set_aside_at && !q.sent_reply_id && !(q.revision > 0 && q.sent_revision === q.revision);

/** The records of `message` asked inside the attachment `attachmentId`, then the questions of its body. */
export function fileQuestionRecords(message: Pick<InboxMessageWire, 'questions'> | undefined, attachmentId: string): InboxQuestion[] {
  const all = message?.questions ?? [];
  return [...all.filter((q) => q.attachment?.id === attachmentId), ...all.filter((q) => !q.attachment && q.kind !== 'action')];
}

/**
 * The record a card computes `fileKey` for, by the file's key: the file's own
 * record first (an older message has one for a repeated question too), else
 * the body's record of the same key.
 */
export function recordsByFileKey(records: readonly InboxQuestion[]): Map<string, InboxQuestion> {
  const out = new Map<string, InboxQuestion>();
  for (const r of records) if (!r.attachment) out.set(r.key, r);
  for (const r of records) if (r.attachment) out.set(r.attachment.key, r);
  return out;
}

/** The record a card answers through: a body record only when the card repeats it (its choices too). */
function cardRecord(byFileKey: ReadonlyMap<string, InboxQuestion>, indexed: IndexedQuestion): InboxQuestion | undefined {
  const record = byFileKey.get(indexed.question.key);
  if (!record || record.attachment) return record;
  return inboxFileQuestionTwin(indexed.question, [record]) ?? undefined;
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
  const moved = questions?.moved === true;
  return useMemo(() => {
    if (!records || records.length === 0 || !answers || !onPick || !footerFor) return {};
    const byFileKey = recordsByFileKey(records);
    return {
      questionAnswers: fileQuestionAnswers(byFileKey, answers),
      onAnswerQuestion: (_blockId: string, answer: QuestionAnswer | null, fileKey: string) => {
        const record = byFileKey.get(fileKey);
        if (!fileQuestionLocked(record, locked)) onPick(record!.key, answer);
      },
      questionReadOnly: (indexed: IndexedQuestion) => fileQuestionLocked(cardRecord(byFileKey, indexed), locked),
      questionStatusLabel: (indexed: IndexedQuestion, status: QuestionStatus) => {
        const record = cardRecord(byFileKey, indexed);
        // Closed by the archive of a moved thread: "Closed", as the body's cards (useQuestionCards), never "Open".
        if (moved && closedByArchive(record)) return ARCHIVE_CLOSED_STATUS;
        if (status !== 'answered' && status !== 'skipped') return undefined;
        return record && (record.state === 'open' || record.state === 'picked') ? DRAFT_STATUS : undefined;
      },
      renderQuestionFooter: (indexed: IndexedQuestion) => {
        const record = cardRecord(byFileKey, indexed);
        const text = record ? footerFor(record.key) : null;
        return text ? <span className="ib-qfoot-st">{text}</span> : null;
      },
      questionContractLines: true,
      questionOptionLines: true,
      questionChangeLines: true,
    };
  }, [records, answers, locked, onPick, footerFor, moved]);
}
