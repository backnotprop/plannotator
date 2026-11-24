/**
 * Decision mode's thread: the sitting's thread as the thread pane holds it (the query cache), read once if it is not
 * held, so each card draws its message with the thread's own card. And the prototype window a card's "Try prototype"
 * opens over the dialog: the thread's `PrototypeWindow`, its pick going to the same draft.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { useInboxQueryClient } from '../data/client';
import { putThread, readThread, useHeldThread } from '../data/queries/thread';
import { useThreadAttachments } from '../data/queries/files';
import type { HeldThread } from '../data/apply/record';
import { PrototypeWindow, openingOption, type PrototypeOption } from '../components/PrototypeWindow';
import { questionPrototypePages } from '../prototypes';
import { choiceLetters } from '../optionSets';
import { emptyAnswerFor } from '../thread/helpers';
import { readWithRetries } from './readRetry';

/** How long one read of a thread not held may take. */
const READ_MS = 15_000;
/** A read that fails or runs out goes again this many times, a little later each time, before the card says so. */
export const SITTING_READ_TRIES = 3;
const RETRY_MS = 1_500;

export interface SittingThread {
  held: HeldThread | null;
  /** Every try failed: the card says the question could not be read, with Try again. */
  failed: boolean;
  retry: () => void;
}

export function useSittingThread(threadId: string | null): SittingThread {
  const client = useInboxQueryClient();
  const held = useHeldThread(threadId, true);
  const missing = threadId !== null && held === null;
  const [failed, setFailed] = useState(false);
  /** Bumped by Try again: the tries start over. */
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!missing || !threadId) return;
    setFailed(false);
    return readWithRetries(() => readThread(threadId, READ_MS), { onRead: (model) => putThread(client, threadId, model), onFailed: () => setFailed(true) }, { tries: SITTING_READ_TRIES, waitMs: RETRY_MS });
  }, [missing, threadId, client, round]);
  const retry = useCallback(() => setRound((n) => n + 1), []);
  return { held, failed: failed && missing, retry };
}

/** The question's prototypes in the thread's full window, over the dialog; a Pick there answers the card's draft. */
export function DecisionPrototype({
  proto,
  held,
  answers,
  onPick,
  onClose,
}: {
  proto: { messageId: string; key: string };
  held: HeldThread | null;
  /** The question's answer now (its draft, or one on its way). */
  answers: QuestionAnswer | null;
  onPick: (answer: QuestionAnswer) => void;
  onClose: () => void;
}) {
  const thread = held?.thread ?? null;
  const { model: files, patch } = useThreadAttachments(thread?.thread_id ?? '', null, 0);
  const allFiles = useMemo(() => [...(files?.attachments ?? []), ...(files?.inline_images ?? [])], [files]);
  const message = thread?.messages.find((m) => m.id === proto.messageId);
  const q = message?.questions?.find((x) => x.key === proto.key);
  if (!thread || !message || !q) return null;
  const letters = choiceLetters(q.choices.map((c) => c.label));
  const { pages, shared } = questionPrototypePages(q, message, thread.project.root);
  const options: PrototypeOption[] = q.choices.map((c, i) => ({ label: c.label, ...letters[i]!, recommended: c.recommended, page: pages[i] ?? null }));
  if (!options.some((o) => o.page)) return null;
  const locked = message.author.kind !== 'agent' || (q.state !== 'open' && q.state !== 'picked');
  return (
    <PrototypeWindow
      key={`${message.id}/${q.key}`}
      threadId={thread.thread_id}
      options={options}
      start={openingOption(options)}
      shared={shared}
      picked={answers?.selected ?? []}
      readOnly={locked}
      records={files?.annotations ?? []}
      attachments={allFiles}
      onSaved={(record) => patch((list) => [...list.filter((r) => r.id !== record.id), record])}
      onPick={(label) => {
        const base = answers ?? emptyAnswerFor(message, { key: q.key, prompt: q.prompt, question: q });
        // Pick one: the option alone (no Other); pick any: added to what is ticked. Never a skip.
        const { other, skipped: _skipped, ...rest } = base;
        onPick(q.kind === 'multi' ? { ...rest, ...(other ? { other } : {}), selected: [...new Set([...base.selected, label])] } : { ...rest, selected: [label] });
      }}
      onClose={onClose}
    />
  );
}
