import React, { useId, useMemo, useRef, useState } from 'react';
import {
  canonicalQuestionAnswer,
  emptyQuestionAnswer,
  isQuestionAnswerEmpty,
  questionStatus,
  recommendedQuestionAnswer,
  type IndexedQuestion,
  type ParsedQuestion,
  type QuestionAnswer,
} from '@plannotator/core/question-block';
import { InlineMarkdown } from '../InlineMarkdown';
import { QuestionContext } from './QuestionContext';

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
 * State is derived: `answer` comes from the host (Plannotator: the document's
 * annotation carrying `questionAnswer` for this key). Two ways to write:
 * - live (`onAnswer`): every change calls it with the next answer, or null
 *   when it became empty; the host upserts or removes the annotation.
 * - explicit save (`onSaveAnswer`): changes stay a local draft; the footer
 *   shows Save answer and Cancel (and no Skip), Save calls `onSaveAnswer`
 *   once, Cancel returns to the host's answer.
 * With neither the block is read-only.
 *
 * A host can add its own actions at the right of the footer
 * (`renderFooter`), and a question carrying `Decision: when answered` or a
 * `Decision: [statement](url)` link shows that beside the prompt. A host can
 * also let the reviewer switch a question's decision recording off and on
 * (`decisionRecording` + `onToggleDecisionRecording`; with
 * `decisionScope: 'any'`, any question without a recorded decision once the
 * host supplies a state), open its own decision
 * card from the tag's words (`onOpenDecision`), and hide the card's own
 * status tag to draw its own (`statusTag: 'none'`).
 */

/** Pointer travel (px) above which a press on a choice row is a drag. */
const DRAG_THRESHOLD_MOUSE = 4;
const DRAG_THRESHOLD_TOUCH = 10;
/** A second click on the same choice within this window is a double-click:
 *  it selects a word, so the pick its first click made is taken back. */
const DOUBLE_CLICK_REVERT_MS = 800;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

const Tag: React.FC<{ tone: 'rec' | 'ok' | 'skip' | 'open'; children: React.ReactNode; className?: string; style?: React.CSSProperties }> = ({ tone, children, className, style }) => (
  <span
    className={cx(
      'annotation-exclude select-none inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px align-[1px] text-[10.5px] font-semibold tracking-[0.03em]',
      tone === 'rec' && 'bg-primary/15 text-primary',
      tone === 'ok' && 'bg-success/15 text-success',
      tone === 'skip' && 'bg-muted text-muted-foreground',
      tone === 'open' && 'border border-dashed border-border text-muted-foreground',
      className,
    )}
    style={style}
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

const DiamondGlyph = () => (
  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0">
    <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z" strokeLinejoin="round" />
  </svg>
);

/** Draws a decision tag in its "off" state: the same words, dimmed, with a
 *  dotted outline instead of the tinted fill. Dimmed means the theme's
 *  muted-foreground, not opacity: 60% opacity on primary text dropped the
 *  default light theme under 3:1, while muted-foreground is the token every
 *  theme already tunes for secondary text. Inline so it adds no utility
 *  classes to the shared stylesheet and wins over the tag's `text-primary`. */
const DECISION_OFF_STYLE: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--muted-foreground)',
  outline: '1px dotted currentColor',
  outlineOffset: '-1px',
};

/** Two answers say the same thing (identity and line ignored). */
const sameAnswer = (a: QuestionAnswer | null | undefined, b: QuestionAnswer | null | undefined): boolean => {
  const norm = (x: QuestionAnswer | null | undefined) =>
    !x || isQuestionAnswerEmpty(x)
      ? ''
      : JSON.stringify([x.selected, x.other ?? '', x.text ?? '', x.note ?? '', !!x.skipped]);
  return norm(a) === norm(b);
};

/** What `onSaveAnswer` may return: nothing (the save is done), or a promise
 *  the card waits on (rejecting keeps the draft so the reviewer can retry). */
export type QuestionSaveResult = void | Promise<unknown>;

export interface QuestionBlockProps {
  blockId: string;
  indexed: IndexedQuestion;
  /** How many question blocks the document has (for "Question N of M"). */
  total: number;
  answer?: QuestionAnswer;
  onAnswer?: (blockId: string, answer: QuestionAnswer | null, key: string) => void;
  /** Explicit save mode (takes precedence over `onAnswer`): edits stay a
   *  draft in the card until Save, which calls this with the question's key
   *  and the answer (null when the draft is empty). The host stores it and
   *  passes it back as `answer`. */
  onSaveAnswer?: (key: string, answer: QuestionAnswer | null) => QuestionSaveResult;
  /** Label of the explicit-save-mode Save button (default "Save answer"),
   *  or a function of the question that returns it. */
  saveLabel?: string | ((question: ParsedQuestion) => string);
  /** Host actions at the right end of the footer, given the question and its
   *  saved answer (never the unsaved draft). Rendered in read-only cards too;
   *  return null for nothing. */
  renderFooter?: (question: IndexedQuestion, answer: QuestionAnswer | undefined) => React.ReactNode;
  /** Whether answering this question records a decision. On a question
   *  carrying `Decision: when answered` it defaults to true; false draws the
   *  "Records a decision" tag dimmed with a dotted outline and hides the
   *  "Answering this records a decision" row. On a question WITHOUT a
   *  decision line it is ignored unless `decisionScope` is `'any'` (ui
   *  0.52.1); then a defined value adds the tag in that state (false: off;
   *  true: on, with the row), so a host can let any answer become a
   *  decision, and undefined leaves the question with no tag. Has no effect
   *  on a question whose decision is already recorded
   *  (`Decision: [statement](url)`). */
  decisionRecording?: boolean;
  /** Which questions can carry the "Records a decision" tag (ui 0.52.1).
   *  `'when-answered'` (default, the 0.52.0 behaviour): only a question that
   *  carries `Decision: when answered`. `'any'`: also a question with no
   *  decision line, once the host passes a `decisionRecording` for it. */
  decisionScope?: 'when-answered' | 'any';
  /** Makes the "Records a decision" tag a toggle button (`aria-pressed`):
   *  a click calls this with the question's key and the next state. The host
   *  stores it and passes it back as `decisionRecording`. Not offered in a
   *  read-only card (no answer handler), which draws the tag as it stands. */
  onToggleDecisionRecording?: (key: string, next: boolean) => void;
  /** Opens the host's decision card (ui 0.52.1). Given, the tag splits into
   *  two targets inside one visual tag: the diamond is the switch
   *  (`onToggleDecisionRecording`, labelled "Record as a decision") and the
   *  words "Records a decision" are a button (`aria-haspopup="dialog"`) that
   *  calls this with the question's key and the words' own element, to
   *  anchor a popover. Offered whether recording is on or off (the host
   *  decides what an off question's card does). Not offered in a read-only
   *  card. */
  onOpenDecision?: (key: string, anchor: HTMLElement) => void;
  /** `'none'` hides the card's own status tag (Open / Answered / Settled /
   *  Skipped) so the host can draw its own; the decision tags stay. Default
   *  `'card'`. */
  statusTag?: 'card' | 'none';
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
  answer: storedAnswer,
  onAnswer: onLiveAnswer,
  onSaveAnswer,
  saveLabel,
  renderFooter,
  decisionRecording,
  decisionScope = 'when-answered',
  onToggleDecisionRecording,
  onOpenDecision,
  statusTag = 'card',
  onOpenLinkedDoc,
  onOpenCodeFile,
  imageBaseDir,
  onImageClick,
  githubRepo,
  repoHost,
  onNavigateAnchor,
}) => {
  const { question, number } = indexed;
  // An answer saved under an older label of a choice (0.28.1 read a wrapped
  // plain bullet's first line as its label) shows that choice picked; the
  // next edit stores the current label.
  const savedAnswer = useMemo(
    () => (storedAnswer ? canonicalQuestionAnswer(question, storedAnswer) : storedAnswer),
    [question, storedAnswer],
  );
  const saveMode = !!onSaveAnswer;
  // Save mode: the unsaved draft (null = the reviewer emptied it). Absent
  // means the card shows the host's answer.
  const [draft, setDraft] = useState<{ answer: QuestionAnswer | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const answer: QuestionAnswer | undefined = saveMode && draft ? draft.answer ?? undefined : savedAnswer;
  const dirty = saveMode && !!draft && !sameAnswer(draft.answer, savedAnswer);
  // Every edit goes through here: straight to the host in live mode, into the
  // draft in save mode.
  // A draft edited back to the saved answer is dropped, so a later host
  // update to `answer` shows instead of a stale copy.
  const onAnswer = onSaveAnswer
    ? (_blockId: string, next: QuestionAnswer | null) =>
        setDraft(sameAnswer(next, savedAnswer) ? null : { answer: next })
    : onLiveAnswer;
  const readOnly = !onAnswer;

  const save = () => {
    if (!onSaveAnswer || !draft || saving) return;
    const next = draft.answer && !isQuestionAnswerEmpty(draft.answer) ? draft.answer : null;
    const submitted = draft;
    const result = onSaveAnswer(question.key, next);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      setSaving(true);
      (result as Promise<unknown>).then(
        () => {
          setSaving(false);
          // An edit made while the save was in flight stays a draft.
          setDraft((current) => (current === submitted ? null : current));
        },
        // A failed save keeps the draft; the host reports the error.
        () => setSaving(false),
      );
    } else {
      setDraft(null);
    }
  };
  const cancel = () => {
    setDraft(null);
    setNotePinned(null);
  };
  const hostFooter = renderFooter?.(indexed, savedAnswer);
  const hasHostFooter = hostFooter !== null && hostFooter !== undefined && hostFooter !== false;
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
  const lastPickRef = useRef<{ label: string; before: QuestionAnswer | undefined; at: number } | null>(null);

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

  // A note alone does not change a settled choice: the [x] stays drawn (and
  // the status stays Settled) until the reviewer picks, fills Other or skips.
  const status = questionStatus(question, answer);
  const answered = status === 'answered';
  const skipped = status === 'skipped';
  const settled = status === 'settled';
  const settledLabels = question.choices.filter((c) => c.settled).map((c) => c.label);
  const hasRecommendation = question.choices.some((c) => c.recommended) || !!question.suggestedText;
  const selected = answered || skipped ? answer!.selected : settledLabels;
  const base = answer ?? emptyQuestionAnswer(indexed);

  const commit = (next: QuestionAnswer) => {
    if (!onAnswer) return;
    onAnswer(blockId, isQuestionAnswerEmpty(next) ? null : next, question.key);
  };

  const pick = (label: string, checked: boolean) => {
    lastPickRef.current = { label, before: answer, at: now() };
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
  const onRowClick = (event: React.MouseEvent, label: string) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (event.target instanceof HTMLInputElement) return;
    // A double-click selects a word to annotate, never picks: the second
    // click is cancelled, and the pick the first click made (if any, on this
    // choice, just now) is taken back.
    if (event.detail >= 2) {
      event.preventDefault();
      const last = lastPickRef.current;
      lastPickRef.current = null;
      if (onAnswer && last && last.label === label && now() - last.at <= DOUBLE_CLICK_REVERT_MS) {
        const before = last.before;
        onAnswer(blockId, before && !isQuestionAnswerEmpty(before) ? before : null, question.key);
      }
      return;
    }
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

  // A `Decision: when answered` question the host may switch off, or (with
  // `decisionScope: 'any'`) any other question once the host supplies a
  // recording state for it. A recorded decision (`question.decision`) is
  // never affected.
  const decisionCapable = !question.decision
    && (!!question.decisionOnAnswer || (decisionScope === 'any' && decisionRecording !== undefined));
  const recordingOn = decisionRecording ?? true;
  const decisionToggleable = decisionCapable && !readOnly && !!onToggleDecisionRecording;
  const decisionOpenable = decisionCapable && !readOnly && !!onOpenDecision;
  // Present only when the host speaks to recording, so a card without these
  // props carries exactly the attributes it always did.
  const recordingAttr = decisionCapable && (decisionRecording !== undefined || !!onToggleDecisionRecording)
    ? (recordingOn ? 'on' : 'off')
    : undefined;

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
      aria-disabled={readOnly || undefined}
      data-question-decision={question.decision ? 'recorded' : question.decisionOnAnswer ? 'on-answer' : undefined}
      data-question-decision-recording={recordingAttr}
    >
      <div className="annotation-exclude select-none mb-1.5 flex items-center gap-2" data-pinpoint-ignore="">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{eyebrow}</span>
        <span className="ml-auto">
          {question.decision && <><Tag tone="rec"><DiamondGlyph />Decision</Tag>{' '}</>}
          {decisionCapable && (decisionOpenable ? (
            // Two targets in one tag: the diamond switches recording, the
            // words open the host's decision card. Siblings, never nested.
            // Target size (WCAG 2.5.8) without changing the drawn tag: the
            // diamond's invisible `before:` box reaches 6 px past it on every
            // side (24 px wide, about 30 px tall), and the words, positioned
            // and later in the tree, paint over its right-hand part, so a
            // click on the words is always the words. The words (110 px wide)
            // meet the spacing exception: nothing else to click within 12 px
            // of their centre line.
            <><span
              className="annotation-exclude select-none inline-flex items-stretch whitespace-nowrap rounded align-[1px] text-[10.5px] font-semibold tracking-[0.03em] bg-primary/15 text-primary"
              style={recordingOn ? undefined : DECISION_OFF_STYLE}
              data-pinpoint-ignore=""
              data-question-decision-tag=""
            >{decisionToggleable ? (
              <button
                type="button"
                aria-pressed={recordingOn}
                aria-label="Record as a decision"
                title="Record as a decision"
                onClick={() => onToggleDecisionRecording!(question.key, !recordingOn)}
                className="relative inline-flex cursor-pointer items-center rounded pl-1.5 pr-0.5 before:absolute before:-inset-1.5 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                data-question-decision-toggle=""
              ><DiamondGlyph /></button>
            ) : (
              <span className="inline-flex items-center pl-1.5 pr-0.5"><DiamondGlyph /></span>
            )}<button
              type="button"
              aria-haspopup="dialog"
              onClick={(event) => onOpenDecision!(question.key, event.currentTarget)}
              className="relative cursor-pointer rounded py-px pl-0.5 pr-1.5 hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              data-question-decision-open=""
            >Records a decision</button></span>{' '}</>
          ) : decisionToggleable ? (
            // Focus shows as a ring, not an outline: the dotted outline is
            // what draws the off state.
            <><button
              type="button"
              aria-pressed={recordingOn}
              onClick={() => onToggleDecisionRecording!(question.key, !recordingOn)}
              className="annotation-exclude select-none inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded px-1.5 py-px align-[1px] text-[10.5px] font-semibold tracking-[0.03em] bg-primary/15 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              style={recordingOn ? undefined : DECISION_OFF_STYLE}
              data-pinpoint-ignore=""
              data-question-decision-toggle=""
            ><DiamondGlyph />Records a decision</button>{' '}</>
          ) : recordingOn ? (
            <><Tag tone="rec"><DiamondGlyph />Records a decision</Tag>{' '}</>
          ) : (
            <><Tag tone="rec" style={DECISION_OFF_STYLE}><DiamondGlyph />Records a decision</Tag>{' '}</>
          ))}
          {statusTag !== 'none' && (
            <>
              {status === 'answered' && <Tag tone="ok"><CheckGlyph />Answered</Tag>}
              {status === 'settled' && <Tag tone="ok"><CheckGlyph />Settled</Tag>}
              {status === 'skipped' && <Tag tone="skip">Skipped</Tag>}
              {status === 'open' && <Tag tone="open">Open</Tag>}
            </>
          )}
        </span>
      </div>

      <p id={promptId} className="m-0 text-[15px] font-semibold leading-[1.45] text-foreground" data-question-part="prompt">
        {inline(question.prompt)}
      </p>
      {(question.decision || (decisionCapable && recordingOn)) && (
        <div
          className="annotation-exclude mt-2 mb-0.5 flex items-center gap-2 rounded-lg bg-primary/8 px-[9px] py-1.5 text-[12.5px] leading-[18px] text-foreground [&>svg]:text-primary"
          data-pinpoint-ignore=""
          data-question-decision-row=""
        >
          <DiamondGlyph />
          {question.decision ? (
            <span className="min-w-0">
              <span className="select-none text-muted-foreground">Decision: </span>
              <a
                href={question.decision.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                {/* Plain text: inline markdown here could nest an autolink in the link. */}
                {question.decision.statement}
              </a>
            </span>
          ) : (
            <span className="select-none">Answering this records a decision</span>
          )}
        </div>
      )}
      {question.context && (
        <QuestionContext
          id={contextId}
          markdown={question.context}
          imageBaseDir={imageBaseDir}
          onImageClick={onImageClick}
          onOpenLinkedDoc={onOpenLinkedDoc}
          onOpenCodeFile={onOpenCodeFile}
          onNavigateAnchor={onNavigateAnchor}
          githubRepo={githubRepo}
          repoHost={repoHost}
        />
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
              // annotation-exclude: typed text is not document text, so a
              // text-search restore of another annotation never lands in it.
              'annotation-exclude mt-2.5 block min-h-[74px] w-full resize-y rounded-[7px] border border-border bg-background px-2.5 py-2 text-[13.5px] leading-normal text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-1 focus:ring-ring disabled:cursor-default',
              skipped && 'opacity-55',
            )}
            aria-labelledby={promptId}
            placeholder={readOnly ? '' : 'Type your answer…'}
            value={answer?.text ?? ''}
            onChange={(e) => setText(e.target.value)}
            disabled={readOnly}
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
                data-question-option=""
                onPointerDown={onRowPointerDown}
                onClickCapture={(event) => onRowClick(event, choice.label)}
              >
                <input
                  type={inputType}
                  name={groupName}
                  checked={checked}
                  onChange={(e) => pick(choice.label, e.target.checked)}
                  className="mt-[3px] h-[15px] w-[15px] shrink-0 cursor-pointer accent-primary disabled:cursor-default"
                  disabled={readOnly}
                />
                <span className="min-w-0 flex-1 select-text text-[13.5px] leading-[1.45] text-foreground" data-question-part="choice">
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
              disabled={readOnly}
              placeholder={readOnly ? '' : 'Other…'}
              aria-label={number > 0 ? `Other answer to question ${number}` : 'Other answer'}
              className="annotation-exclude min-w-0 flex-1 border-0 border-b border-transparent bg-transparent py-[3px] text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring"
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
            className="annotation-exclude block min-h-[54px] w-full resize-y rounded-[7px] border border-border bg-background px-2.5 py-2 text-[13.5px] leading-normal text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-1 focus:ring-ring"
            aria-labelledby={noteLabelId}
            placeholder="Context for the agent…"
            value={answer?.note ?? ''}
            onChange={(e) => setNote(e.target.value)}
            disabled={readOnly}
          />
        </div>
      )}

      {(!readOnly || hasHostFooter) && (
        <div
          className="annotation-exclude select-none mt-2 flex items-center gap-1 border-t border-border/55 pt-1.5"
          data-pinpoint-ignore=""
        >
          {!readOnly && (
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
          )}
          {/* Skip is a live-mode draft state; an explicit save never writes it. */}
          {!readOnly && !saveMode && (
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
          )}
          {/* Plannotator's own footer (no host actions, no save bar) keeps the
              Accept button as the one right-aligned item. */}
          {!hasHostFooter && !dirty ? (
            !readOnly && !answered && !settled && hasRecommendation && (
              <button
                type="button"
                onClick={acceptRecommended}
                className="ml-auto rounded-md border border-primary/45 bg-primary/10 px-2.5 py-[3px] text-[12.5px] font-medium text-primary hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                Accept recommended
              </button>
            )
          ) : (
            <div className="ml-auto flex items-center gap-1">
              {!readOnly && !answered && !settled && hasRecommendation && (
                <button
                  type="button"
                  onClick={acceptRecommended}
                  className="rounded-md border border-primary/45 bg-primary/10 px-2.5 py-[3px] text-[12.5px] font-medium text-primary hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  Accept recommended
                </button>
              )}
              {hasHostFooter && <span className="inline-flex items-center gap-1" data-question-host-footer="">{hostFooter}</span>}
              {dirty && (
                <>
                  <button
                    type="button"
                    onClick={cancel}
                    disabled={saving}
                    className="rounded-[5px] px-[7px] py-[3px] text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    aria-busy={saving || undefined}
                    className="rounded-md bg-primary px-2.5 py-[3px] text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
                  >
                    {(typeof saveLabel === 'function' ? saveLabel(question) : saveLabel) || 'Save answer'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
};
