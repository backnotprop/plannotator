import React, { useId, useRef, useState } from 'react';
import {
  emptyQuestionAnswer,
  isQuestionAnswerEmpty,
  isQuestionAnswered,
  recommendedQuestionAnswer,
  type IndexedQuestion,
  type QuestionAnswer,
} from '@plannotator/core/question-block';
import { InlineMarkdown } from '../InlineMarkdown';
import { renderProseBody } from './proseBody';

/**
 * A `:::question` block rendered as an answer card (the approved "Card"
 * variant): an eyebrow with "Question N of M" and a status tag, the prompt,
 * its context, then the choices (native radios / checkboxes plus an always
 * present "Other…"), or a text box for a free-text question, and a footer
 * with Add note · Skip · Accept recommended.
 *
 * The prompt, context and choice text stay ordinary document prose, so a
 * reviewer can select and annotate any of it; only the chrome (eyebrow, tags,
 * footer) is `annotation-exclude`. A click on a choice row picks it only when
 * the pointer barely moved and no text is selected, so a drag across option
 * text makes an annotation, never a pick.
 *
 * State is derived: `answer` comes from the document's annotations (the one
 * carrying `questionAnswer` for this key). Every change calls `onAnswer` with
 * the next answer, or null when it became empty; the host upserts or removes
 * the annotation. Without `onAnswer` the block is read-only.
 */

/** Pointer travel (px) above which a press on a choice row is a drag. */
const DRAG_THRESHOLD_MOUSE = 4;
const DRAG_THRESHOLD_TOUCH = 10;

type Status = 'open' | 'answered' | 'skipped' | 'settled';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

const Tag: React.FC<{ tone: 'rec' | 'ok' | 'skip' | 'open'; children: React.ReactNode; className?: string }> = ({ tone, children, className }) => (
  <span
    className={cx(
      'annotation-exclude select-none inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px align-[1px] text-[10.5px] font-semibold tracking-[0.03em]',
      tone === 'rec' && 'bg-primary/15 text-primary',
      tone === 'ok' && 'bg-success/15 text-success',
      tone === 'skip' && 'bg-muted text-muted-foreground',
      tone === 'open' && 'border border-dashed border-border text-muted-foreground',
      className,
    )}
    data-pinpoint-ignore=""
  >
    {children}
  </span>
);

const CheckGlyph = () => (
  <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export interface QuestionBlockProps {
  blockId: string;
  indexed: IndexedQuestion;
  /** How many question blocks the document has (for "Question N of M"). */
  total: number;
  answer?: QuestionAnswer;
  onAnswer?: (blockId: string, answer: QuestionAnswer | null, key: string) => void;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  githubRepo?: string;
  repoHost?: string;
  onNavigateAnchor?: (hash: string) => void;
}

export const QuestionBlock: React.FC<QuestionBlockProps> = ({
  blockId,
  indexed,
  total,
  answer,
  onAnswer,
  onOpenLinkedDoc,
  onOpenCodeFile,
  imageBaseDir,
  onImageClick,
  githubRepo,
  repoHost,
  onNavigateAnchor,
}) => {
  const { question, number } = indexed;
  const readOnly = !onAnswer;
  const uid = useId().replace(/:/g, '');
  const promptId = `q-prompt-${uid}`;
  const contextId = `q-context-${uid}`;
  const suggestId = `q-suggest-${uid}`;
  const noteLabelId = `q-note-${uid}`;
  // null = follow the answer (open while a note exists); a click pins it.
  const [notePinned, setNotePinned] = useState<boolean | null>(null);
  const noteOpen = notePinned ?? !!answer?.note?.trim();
  const pressRef = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const inline = (text: string) => (
    <InlineMarkdown
      text={text}
      imageBaseDir={imageBaseDir}
      onImageClick={onImageClick}
      onOpenLinkedDoc={onOpenLinkedDoc}
      onOpenCodeFile={onOpenCodeFile}
      githubRepo={githubRepo}
      repoHost={repoHost}
      onNavigateAnchor={onNavigateAnchor}
    />
  );

  const answered = !!answer && isQuestionAnswered(answer);
  const skipped = !!answer?.skipped && !answered;
  const settledLabels = question.choices.filter((c) => c.settled).map((c) => c.label);
  // A note alone does not change a settled choice: the [x] stays drawn (and
  // the status stays Settled) until the reviewer picks, fills Other or skips.
  const settled = !answered && !skipped && settledLabels.length > 0;
  const status: Status = answered ? 'answered' : skipped ? 'skipped' : settled ? 'settled' : 'open';
  const hasRecommendation = question.choices.some((c) => c.recommended) || !!question.suggestedText;
  const selected = answered || skipped ? answer!.selected : settledLabels;
  const base = answer ?? emptyQuestionAnswer(indexed);

  const commit = (next: QuestionAnswer) => {
    if (!onAnswer) return;
    onAnswer(blockId, isQuestionAnswerEmpty(next) ? null : next, question.key);
  };

  const pick = (label: string, checked: boolean) => {
    const { skipped: _s, ...rest } = base;
    if (question.kind === 'multi') {
      const nextSelected = checked
        ? [...selected.filter((l) => l !== label), label]
        : selected.filter((l) => l !== label);
      // Keep document order, not click order.
      const order = question.choices.map((c) => c.label);
      nextSelected.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      commit({ ...rest, selected: nextSelected });
    } else if (checked) {
      const { other: _o, ...single } = rest;
      commit({ ...single, selected: [label] });
    }
  };

  const setOther = (value: string) => {
    const { skipped: _s, other: _o, ...rest } = base;
    const keepSelected = question.kind === 'multi' ? selected : value.trim() ? [] : rest.selected;
    commit({ ...rest, selected: keepSelected, ...(value ? { other: value } : {}) });
  };

  const setText = (value: string) => {
    const { skipped: _s, text: _t, ...rest } = base;
    commit({ ...rest, ...(value ? { text: value } : {}) });
  };

  const setNote = (value: string) => {
    const { note: _n, ...rest } = base;
    commit({ ...rest, ...(value ? { note: value } : {}) });
  };

  const toggleSkip = () => {
    if (base.skipped) {
      const { skipped: _s, ...rest } = base;
      commit(rest);
      return;
    }
    const { other: _o, text: _t, ...rest } = base;
    commit({ ...rest, selected: [], skipped: true });
  };

  const acceptRecommended = () => {
    const next = recommendedQuestionAnswer(indexed, base);
    if (next) commit(next);
  };

  const toggleNote = () => {
    const opening = !noteOpen;
    setNotePinned(opening);
    if (opening) requestAnimationFrame(() => noteRef.current?.focus());
  };

  // Drag-vs-pick guard. A native <label> forwards its click to the input, so
  // cancelling the click is what keeps a text drag from also picking. It runs
  // in the capture phase so the cancel lands before any label activation.
  const onRowPointerDown = (event: React.PointerEvent) => {
    pressRef.current = { x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' };
  };
  const onRowClick = (event: React.MouseEvent) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (event.target instanceof HTMLInputElement) return;
    const limit = press?.touch ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE;
    const moved = !!press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > limit;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const selecting = !!selection && !selection.isCollapsed && selection.toString().trim() !== '';
    if (moved || selecting) event.preventDefault();
  };

  const eyebrow = number > 0
    ? `Question ${number} of ${total}${question.kind === 'multi' ? ' · pick any' : ''}`
    : `Question${question.kind === 'multi' ? ' · pick any' : ''}`;
  const groupName = `question-${uid}`;
  const inputType = question.kind === 'multi' ? 'checkbox' : 'radio';
  const other = answer?.other ?? '';
  const otherOn = other.trim() !== '';

  const describedBy = [question.context ? contextId : null, question.kind === 'text' && question.suggestedText && !answered ? suggestId : null]
    .filter(Boolean)
    .join(' ') || undefined;

  return (
    <fieldset
      className={cx(
        'question-block my-5 min-w-0 rounded-[10px] border px-3.5 pb-2.5 pt-3',
        // Native radios/checkboxes follow the theme's mode. ThemeProvider marks
        // light mode with `.light` on the root; a host without theme classes
        // keeps the page's own color-scheme.
        '[:root[class*=theme-]:not(.light)_&]:[color-scheme:dark]',
        'bg-[color-mix(in_oklab,var(--background)_35%,var(--card))]',
        answered ? 'border-primary/45' : 'border-border/85',
      )}
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind={question.directiveKind}
      data-question-key={question.key}
      data-question-status={status}
      aria-labelledby={promptId}
      aria-describedby={describedBy}
      disabled={readOnly}
    >
      <div className="annotation-exclude select-none mb-1.5 flex items-center gap-2" data-pinpoint-ignore="">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{eyebrow}</span>
        <span className="ml-auto">
          {status === 'answered' && <Tag tone="ok"><CheckGlyph />Answered</Tag>}
          {status === 'settled' && <Tag tone="ok"><CheckGlyph />Settled</Tag>}
          {status === 'skipped' && <Tag tone="skip">Skipped</Tag>}
          {status === 'open' && <Tag tone="open">Open</Tag>}
        </span>
      </div>

      <p id={promptId} className="m-0 text-[15px] font-semibold leading-[1.45] text-foreground">
        {inline(question.prompt)}
      </p>
      {question.context && (
        <div id={contextId} className="mt-1 text-[13px] leading-normal text-muted-foreground">
          {renderProseBody({
            body: question.context,
            paragraphClassName: 'text-[13px] leading-normal',
            listClassName: 'text-[13px] leading-normal',
            imageBaseDir,
            onImageClick,
            onOpenLinkedDoc,
            onOpenCodeFile,
            onNavigateAnchor,
            githubRepo,
            repoHost,
          })}
        </div>
      )}

      {question.kind === 'text' ? (
        <>
          {question.suggestedText && !answered && (
            <div id={suggestId} className="mt-2 flex items-start gap-2 text-[12.5px] text-muted-foreground">
              <span className="min-w-0 flex-1">
                <Tag tone="rec">Suggested</Tag> {inline(question.suggestedText)}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={acceptRecommended}
                  className="shrink-0 rounded-md bg-primary/15 px-2.5 py-[3px] text-xs font-medium text-primary hover:bg-primary/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  Use
                </button>
              )}
            </div>
          )}
          <textarea
            className={cx(
              'mt-2.5 block min-h-[74px] w-full resize-y rounded-[7px] border border-border bg-background px-2.5 py-2 text-[13.5px] leading-normal text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-1 focus:ring-ring disabled:cursor-default',
              skipped && 'opacity-55',
            )}
            aria-labelledby={promptId}
            placeholder={readOnly ? '' : 'Type your answer…'}
            value={answer?.text ?? ''}
            onChange={(e) => setText(e.target.value)}
          />
        </>
      ) : (
        <div
          className={cx('mt-2.5 grid gap-0.5', skipped && 'opacity-55')}
          role={inputType === 'radio' ? 'radiogroup' : 'group'}
          aria-labelledby={promptId}
        >
          {question.choices.map((choice) => {
            const checked = selected.includes(choice.label);
            return (
              <label
                key={choice.label}
                className={cx(
                  'flex items-start gap-2.5 rounded-[7px] px-[9px] py-1.5 transition-colors',
                  readOnly ? 'cursor-default' : 'cursor-pointer hover:bg-muted/45',
                  checked && 'bg-primary/12 hover:bg-primary/12',
                )}
                onPointerDown={onRowPointerDown}
                onClickCapture={onRowClick}
              >
                <input
                  type={inputType}
                  name={groupName}
                  checked={checked}
                  onChange={(e) => pick(choice.label, e.target.checked)}
                  className="mt-[3px] h-[15px] w-[15px] shrink-0 cursor-pointer accent-primary disabled:cursor-default"
                />
                <span className="min-w-0 flex-1 select-text text-[13.5px] leading-[1.45] text-foreground">
                  <span className="font-[550]">{inline(choice.label)}</span>
                  {choice.description && (
                    <span className="text-muted-foreground"> — {inline(choice.description)}</span>
                  )}
                  {choice.recommended && <> <Tag tone="rec">Recommended</Tag></>}
                </span>
              </label>
            );
          })}
          <div className="flex items-center gap-2.5 rounded-[7px] px-[9px] py-[5px]">
            <span
              aria-hidden="true"
              className={cx(
                'annotation-exclude select-none grid h-[15px] w-[15px] shrink-0 place-items-center border-[1.5px] text-[11px] leading-none',
                question.kind === 'multi' ? 'rounded-[3px]' : 'rounded-full',
                otherOn ? 'border-solid border-primary bg-primary text-primary-foreground' : 'border-dashed border-border text-muted-foreground',
              )}
            >
              {otherOn ? <CheckGlyph /> : '+'}
            </span>
            <input
              type="text"
              value={other}
              onChange={(e) => setOther(e.target.value)}
              placeholder={readOnly ? '' : 'Other…'}
              aria-label={number > 0 ? `Other answer to question ${number}` : 'Other answer'}
              className="min-w-0 flex-1 border-0 border-b border-transparent bg-transparent py-[3px] text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring"
            />
          </div>
        </div>
      )}

      {noteOpen && (!readOnly || !!answer?.note?.trim()) && (
        <div className="mt-2">
          <p id={noteLabelId} className="annotation-exclude select-none mb-1 ml-0.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            Note
          </p>
          <textarea
            ref={noteRef}
            className="block min-h-[54px] w-full resize-y rounded-[7px] border border-border bg-background px-2.5 py-2 text-[13.5px] leading-normal text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-1 focus:ring-ring"
            aria-labelledby={noteLabelId}
            placeholder="Context for the agent…"
            value={answer?.note ?? ''}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}

      {!readOnly && (
        <div
          className="annotation-exclude select-none mt-2 flex items-center gap-1 border-t border-border/55 pt-1.5"
          data-pinpoint-ignore=""
        >
          <button
            type="button"
            onClick={toggleNote}
            aria-expanded={noteOpen}
            className={cx(
              'rounded-[5px] px-[7px] py-[3px] text-xs hover:bg-muted hover:text-foreground',
              noteOpen ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {noteOpen ? 'Hide note' : 'Add note'}
          </button>
          <button
            type="button"
            onClick={toggleSkip}
            aria-pressed={skipped}
            className={cx(
              'rounded-[5px] px-[7px] py-[3px] text-xs hover:bg-muted hover:text-foreground',
              skipped ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {skipped ? 'Unskip' : 'Skip'}
          </button>
          {!answered && !settled && hasRecommendation && (
            <button
              type="button"
              onClick={acceptRecommended}
              className="ml-auto rounded-md border border-primary/45 bg-primary/10 px-2.5 py-[3px] text-[12.5px] font-medium text-primary hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Accept recommended
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
};
