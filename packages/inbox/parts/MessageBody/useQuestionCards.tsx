/** MessageBody's cards (parts/MessageBody/MessageBody.tsx). */
import { useCallback, useMemo, useRef } from 'react';
import type { Block } from '@plannotator/ui/types';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import type { InboxNoteBlock } from '@plannotator/core/inbox-context-notes';
import { ContextNoteChip } from '../../contextNotes/ContextNotes';
import { rangeWord } from '../../contextNotes/model';
import type { InboxQuestion } from '@plannotator/core/inbox-types';
import type { IndexedQuestion, QuestionStatus } from '@plannotator/core/question-block';
import { TryPrototypeTab } from '../../components/PrototypeWindow';
import { prototypePageCount } from '../../prototypes';
import type { MessageBodyProps } from './types';

/** An unsent pick's tag on its card (statusLabel). */
// A pick saved and not sent is part of the person's draft (approval "inbox-reply-drafts": "Draft" replaces "Not sent").
const NOT_SENT_STATUS = { label: 'Draft', tone: 'open' } as const;

/** What the body's question cards, action items and context notes draw from the host. */
export function useQuestionCards({
  message,
  projectRoot,
  readOnly,
  footerFor,
  renderReplacedCard,
  renderReplacesLine,
  renderActions,
  onTryPrototype,
  blocks,
  noteAtLine,
  notesRef,
  refRepo,
}: Pick<MessageBodyProps, 'message' | 'projectRoot' | 'readOnly' | 'footerFor' | 'renderReplacedCard' | 'renderReplacesLine' | 'renderActions' | 'onTryPrototype'> & {
  blocks: Block[];
  noteAtLine: ReadonlyMap<number, InboxNoteBlock>;
  notesRef: { readonly current: MessageBodyProps['contextNotes'] };
  refRepo: { display: string; host?: string } | null;
}) {
  // The host's callbacks are new on every render of the thread. A closure here that React keeps (an effect, a
  // memoized callback, a listener) holds this render's scope, so none names them directly: they are read through
  // refs. Else each message drawn after a re-read pinned that read's whole thread view (#2948, a window left open
  // on a busy thread grew without end).
  const footerRef = useRef(footerFor);
  footerRef.current = footerFor;
  const renderFooter = useCallback(
    (question: IndexedQuestion) => {
      const text = footerRef.current(question.question.key);
      return text ? <span className="ib-qfoot-st">{text}</span> : null;
    },
    // A new identity when the footers may have changed, so the cards redraw.
    [footerFor],
  );
  // Replaced questions: the host's Quiet card in place of the answer card, and
  // the newer card's "Replaces …" line. Kept stable across renders.
  const replacedRef = useRef(renderReplacedCard);
  replacedRef.current = renderReplacedCard;
  const replacesRef = useRef(renderReplacesLine);
  replacesRef.current = renderReplacesLine;
  const questionCard = useCallback(
    (question: IndexedQuestion) => replacedRef.current?.(question.question.key, question.number),
    // A new identity when the questions change, so a card that was just replaced redraws.
    [message.questions],
  );
  const belowPrompt = useCallback(
    (question: IndexedQuestion) => replacesRef.current?.(question.question.key) ?? null,
    [message.questions],
  );
  // Action items: one checklist card per run of adjacent `:::action` blocks, in place of
  // the run's first block; the run's other blocks draw nothing (inbox.css hides their empty
  // wrapper). Prose between two blocks ends a run, so each stays where the agent put it.
  const actionsRef = useRef(renderActions);
  actionsRef.current = renderActions;
  const actionRuns = useMemo(() => {
    const runs = new Map<string, { first: boolean; records: InboxQuestion[] }>();
    const draw = actionsRef.current;
    if (!draw) return runs;
    let run: InboxQuestion[] | null = null;
    for (const block of blocks) {
      const record = block.type === 'directive' && block.directiveKind === 'action' ? draw.recordFor(block) : null;
      if (!record) {
        run = null;
        continue;
      }
      const first = run === null;
      if (run === null) run = [];
      run.push(record);
      runs.set(block.id, { first, records: run });
    }
    return runs;
  }, [blocks, message.actions, renderActions !== undefined]);
  const directiveBlock = useCallback(
    (block: Block) => {
      if (block.directiveKind === 'note') {
        const note = noteAtLine.get(block.startLine);
        if (!note) return undefined;
        const open = notesRef.current?.onOpen;
        return (
          <div className="ib-ctxn-msg" data-context-note-block="">
            <ContextNoteChip file={note.file} lines={`${note.side === 'old' ? 'removed ' : ''}${rangeWord([note.lineStart, note.lineEnd])}`} {...(open ? { onOpen: () => open(note) } : {})} />
            <div className="ib-ctxn-msg-t">
              <InlineMarkdown text={note.text} githubRepo={refRepo?.display} repoHost={refRepo?.host} />
            </div>
          </div>
        );
      }
      if (block.directiveKind !== 'action') return undefined;
      const run = actionRuns.get(block.id);
      if (!run) return undefined;
      return run.first ? actionsRef.current?.render(run.records) : null;
    },
    [actionRuns, noteAtLine, refRepo],
  );

  // The whole card, per question: only an open or picked question can be
  // answered. A sent one, one a Mark read or the archive closed, and a
  // replaced one draw read-only (no ticks, no Accept recommended, no Skip),
  // even while another question in the same message is still open. The store
  // would take a new pick on a sent question (it goes back to picked), but the
  // window does not offer it (adr/implementation/inbox-thread-state.md, Pick).
  // "Try prototype" (approval "inbox-question-tradeoffs"): a tab hanging from the right end of the options' tray, on a
  // question with a page to try (an attached HTML file, or an app the send checked).
  const tryRef = useRef(onTryPrototype);
  tryRef.current = onTryPrototype;
  const afterChoices = useCallback(
    (indexed: IndexedQuestion) => {
      // "Try prototypes" when the window steps between several options' pages.
      const pages = prototypePageCount(indexed.question, message, projectRoot);
      return pages > 0 ? <TryPrototypeTab pages={pages} onOpen={() => tryRef.current?.(indexed.question.key)} /> : null;
    },
    [message, projectRoot],
  );

  const answerLocked = useCallback(
    (question: IndexedQuestion) => {
      // A message whose questions take no answers now (all sent, none, or closed): every card locked.
      if (readOnly) return true;
      const wire = message.questions?.find((q) => q.key === question.question.key);
      return wire !== undefined && wire.state !== 'open' && wire.state !== 'picked';
    },
    [message.questions, readOnly],
  );

  // A pick not sent yet tags its card "Draft", not "Answered" (the footer says when it was picked);
  // a sent answer, and a question a Mark read closed, keep the card's own tag.
  const statusLabel = useCallback(
    (question: IndexedQuestion, status: QuestionStatus) => {
      if (status !== 'answered' && status !== 'skipped') return undefined;
      const wire = message.questions?.find((q) => q.key === question.question.key);
      return wire && (wire.state === 'open' || wire.state === 'picked') ? NOT_SENT_STATUS : undefined;
    },
    [message.questions],
  );
  return { renderFooter, questionCard, belowPrompt, directiveBlock, afterChoices, answerLocked, statusLabel };
}
