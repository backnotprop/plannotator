import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  canonicalQuestionAnswer,
  emptyQuestionAnswer,
  isQuestionAnswerEmpty,
  isRecommendedQuestionAnswer,
  questionStatus,
  recommendedQuestionAnswer,
  type IndexedQuestion,
  type ParsedQuestion,
  type QuestionAnswer,
  type QuestionStatus,
} from '@plannotator/core/question-block';
import { InlineMarkdown } from '../InlineMarkdown';
import { QuestionContext } from './QuestionContext';
import { HostTitle } from '../HostTitle';
import { UNAVAILABLE_IMAGE_CLASS, useImageResolver } from '../ImageResolverContext';
import { getImageSrc } from '../ImageThumbnail';
import {
  questionChoiceWords,
  questionPictureShape,
  questionPicturesShape,
  readQuestionPictureSize,
  type QuestionPictureShape,
  type QuestionPictureSize,
} from './questionPictureLayout';

/**
 * The prompt, context and choice text stay ordinary document prose, so a reviewer can select and
 * annotate any of it; only the chrome (eyebrow, tags, footer) is `annotation-exclude`.
 */

const DRAG_THRESHOLD_MOUSE = 4;
const DRAG_THRESHOLD_TOUCH = 10;
const DOUBLE_CLICK_REVERT_MS = 800;
/**
 * The browser counts a click as the second of a double-click by time and place alone, and a
 * touch tap counts within about 100px: on a phone, a quick tap on the next card's answer arrives
 * with `detail` 2.
 */
let lastRowClick: EventTarget | null = null;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The double-click guard's name for the recommended row (never a label: it holds a character no
 * choice label can).
 */
const SUGGESTION_ROW = '\u0000suggestion';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

const PILL = 'annotation-exclude select-none inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded border px-1.5 align-[1px] text-[10.5px] font-semibold leading-4 tracking-[0.03em]';

const Tag: React.FC<{ tone: 'rec' | 'ok' | 'skip' | 'open' | 'warn'; children: React.ReactNode; className?: string; style?: React.CSSProperties }> = ({ tone, children, className, style }) => (
  <span
    className={cx(
      PILL,
      tone === 'rec' && 'border-transparent bg-primary/15 text-primary',
      tone === 'ok' && 'border-transparent bg-success/15 text-success',
      tone === 'skip' && 'border-transparent bg-muted text-muted-foreground',
      tone === 'open' && 'border-dashed border-border text-muted-foreground',
      tone === 'warn' && 'border-transparent bg-warning/15 text-warning',
      className,
    )}
    style={style}
    data-pinpoint-ignore=""
    data-question-tag={tone}
  >
    {children}
  </span>
);

const CheckGlyph = () => (
  <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ChevronRightGlyph = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="shrink-0 transition-transform duration-150 ease-out group-aria-expanded:rotate-90 motion-reduce:transition-none">
    <path d="m6 3.5 4.5 4.5L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const DiamondGlyph = () => (
  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0">
    <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z" strokeLinejoin="round" />
  </svg>
);

const ZoomGlyph = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5M11 8v6M8 11h6" strokeLinecap="round" />
  </svg>
);

const PictureGlyph = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m3 16 5-5 4 4 3-3 6 6" strokeLinejoin="round" />
  </svg>
);

const DECISION_OFF_STYLE: React.CSSProperties = {
  background: 'transparent',
  color: 'color-mix(in oklab, var(--muted-foreground) 55%, transparent)',
  outline: '1px dotted currentColor',
  outlineOffset: '-1px',
};

/**
 * The words stay one text node: a split one moved the glyphs of a wide card by a fraction of a
 * pixel. - On a touch screen each button's hit area is at least 44 x 44 px: an invisible
 * `before:` box centred on it, as the header's decision tag does, so the drawn button does not
 * change.
 */
const FOOT_BUTTON = "whitespace-nowrap pointer-coarse:relative pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:h-11 pointer-coarse:before:w-full pointer-coarse:before:min-w-11 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']";
const FOOT_FIT = '@max-[10rem]/qcard:max-w-full @max-[10rem]/qcard:overflow-hidden @max-[10rem]/qcard:text-ellipsis';
const FOOT_OWN_ROW = '@max-[10rem]/qcard:basis-full';

const sameAnswer = (a: QuestionAnswer | null | undefined, b: QuestionAnswer | null | undefined): boolean => {
  const norm = (x: QuestionAnswer | null | undefined) =>
    !x || isQuestionAnswerEmpty(x)
      ? ''
      : JSON.stringify([x.selected, x.other ?? '', x.text ?? '', x.note ?? '', !!x.skipped]);
  return norm(a) === norm(b);
};

/**
 * What `onSaveAnswer` may return: nothing (the save is done), or a promise the card waits on
 * (rejecting keeps the draft so the reviewer can retry).
 */
export type QuestionSaveResult = void | Promise<unknown>;

export interface QuestionBlockProps {
  blockId: string;
  indexed: IndexedQuestion;
  total: number;
  answer?: QuestionAnswer;
  onAnswer?: (blockId: string, answer: QuestionAnswer | null, key: string) => void;
  onSaveAnswer?: (key: string, answer: QuestionAnswer | null) => QuestionSaveResult;
  saveLabel?: string | ((question: ParsedQuestion) => string);
  renderFooter?: (question: IndexedQuestion, answer: QuestionAnswer | undefined) => React.ReactNode;
  decisionRecording?: boolean;
  decisionScope?: 'when-answered' | 'any';
  /**
   * Makes the "Records a decision" tag a toggle button (`aria-pressed`): a click calls this with
   * the question's key and the next state.
   */
  onToggleDecisionRecording?: (key: string, next: boolean) => void;
  /**
   * Given, the tag splits into two targets inside one visual tag: the diamond is the switch
   * (`onToggleDecisionRecording`.
   */
  onOpenDecision?: (key: string, anchor: HTMLElement) => void;
  statusTag?: 'card' | 'none';
  statusLabel?: (question: IndexedQuestion, status: QuestionStatus) => QuestionStatusLabel | undefined;
  renderBelowPrompt?: (question: IndexedQuestion) => React.ReactNode;
  renderAfterChoices?: (question: IndexedQuestion) => React.ReactNode;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  githubRepo?: string;
  repoHost?: string;
  onNavigateAnchor?: (hash: string) => void;
  pictureChoices?: boolean;
  pictureBadge?: (choice: { label: string; image: { alt: string; src: string } }) => string | null;
  onZoomChoice?: (key: string, index: number, url: string, alt: string) => void;
  pictureSize?: (url: string) => QuestionPictureSize | null;
}

const PICTURE_BADGE_STYLE: React.CSSProperties = {
  position: 'absolute',
  left: 6,
  top: 6,
  zIndex: 1,
  pointerEvents: 'none',
  borderRadius: 4,
  background: 'rgb(0 0 0 / 0.6)',
  color: 'white',
  padding: '0 6px',
  fontSize: 10.5,
  fontWeight: 600,
  lineHeight: '18px',
  letterSpacing: '0.02em',
};

/** A host's status tag (`statusLabel`): its words, and the tone of one of the card's own tags (default `open`). */
export interface QuestionStatusLabel {
  label: string;
  tone?: 'ok' | 'open' | 'skip';
}

const TrayIf: React.FC<{ on: boolean; after: React.ReactNode; children: React.ReactNode }> = ({ on, after, children }) =>
  on ? (
    <div className="mt-2.5" data-question-tray-host="">
      <div data-question-tray="">{children}</div>
      {after}
    </div>
  ) : (
    <>{children}</>
  );

function fitOtherField(field: HTMLTextAreaElement): number | null {
  field.style.height = '';
  field.style.overflowY = '';
  const one = field.offsetHeight;
  const full = field.scrollHeight + (field.offsetHeight - field.clientHeight);
  if (full <= one + 1) return null;
  field.style.height = `${full}px`;
  if (field.scrollHeight > field.clientHeight + 1) field.style.overflowY = 'auto';
  return one > 15 ? (one - 15) / 2 : null;
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
  statusLabel,
  renderBelowPrompt,
  renderAfterChoices,
  onOpenLinkedDoc,
  onOpenCodeFile,
  imageBaseDir,
  onImageClick,
  githubRepo,
  repoHost,
  onNavigateAnchor,
  pictureChoices = true,
  pictureBadge,
  onZoomChoice,
  pictureSize,
}) => {
  const { question, number } = indexed;
  const resolveImage = useImageResolver();
  const pictureSrc = (src: string): string | null => {
    const resolved = resolveImage ? resolveImage(src) : null;
    if (resolved?.kind === 'unavailable') return null;
    if (resolved?.kind === 'src') return resolved.src;
    return /^(https?:\/\/|data:|blob:)/i.test(src) ? src : getImageSrc(src, imageBaseDir);
  };
  const pictureHeldTitle = (src: string): string | null => {
    const resolved = resolveImage ? resolveImage(src) : null;
    return resolved?.kind === 'unavailable' ? resolved.title : null;
  };
  const heldPlaceholder = (src: string, alt: string) => {
    const title = pictureHeldTitle(src);
    return title === null ? null : (
      <span className={UNAVAILABLE_IMAGE_CLASS} title={title} data-image-unavailable="">{alt || 'Image'}</span>
    );
  };
  const [failedPictures, setFailedPictures] = useState<ReadonlySet<string>>(() => new Set());
  const markPictureFailed = (url: string) => setFailedPictures((prev) => (prev.has(url) ? prev : new Set([...prev, url])));
  const savedAnswer = useMemo(
    () => (storedAnswer ? canonicalQuestionAnswer(question, storedAnswer) : storedAnswer),
    [question, storedAnswer],
  );
  const saveMode = !!onSaveAnswer;
  const [draft, setDraft] = useState<{ answer: QuestionAnswer | null } | null>(null);
  const [tradeoffsOpen, setTradeoffsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const answer: QuestionAnswer | undefined = saveMode && draft ? draft.answer ?? undefined : savedAnswer;
  const dirty = saveMode && !!draft && !sameAnswer(draft.answer, savedAnswer);
  // A draft edited back to the saved answer is dropped, so a later host update to `answer` shows
  // instead of a stale copy.
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
          setDraft((current) => (current === submitted ? null : current));
        },
        () => setSaving(false),
      );
    } else {
      setDraft(null);
    }
  };
  const cancel = () => {
    replacedOtherRef.current = null;
    setDraft(null);
    setNotePinned(null);
  };
  const hostFooter = renderFooter?.(indexed, savedAnswer);
  const afterChoices = question.kind === 'text' ? null : renderAfterChoices?.(indexed);
  const hasAfterChoices = afterChoices !== null && afterChoices !== undefined && afterChoices !== false;
  const hasHostFooter = hostFooter !== null && hostFooter !== undefined && hostFooter !== false;
  const uid = useId().replace(/:/g, '');
  const tradeoffsId = `q-tradeoffs-${uid}`;
  const promptId = `q-prompt-${uid}`;
  const contextId = `q-context-${uid}`;
  const stakesId = `q-stakes-${uid}`;
  const suggestId = `q-suggest-${uid}`;
  const noteLabelId = `q-note-${uid}`;
  const [notePinned, setNotePinned] = useState<boolean | null>(null);
  const noteOpen = notePinned ?? !!answer?.note?.trim();
  const pressRef = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLFieldSetElement>(null);
  // Accept recommended goes away once clicked: focus moves to what
  // the click filled in, never to the page.
  const focusAfterAcceptRef = useRef(false);
  const lastPickRef = useRef<{ label: string; before: QuestionAnswer | undefined; at: number } | null>(null);
  // Typing never turns into the row, so "Yes, but slower" stays in the field when the
  // recommendation is "Yes".
  const [otherBy, setOtherBy] = useState<'row' | 'field' | null>(null);
  const [otherFocused, setOtherFocused] = useState(false);
  const replacedOtherRef = useRef<string | null>(null);

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

  const status = questionStatus(question, answer);
  const hostStatus = statusTag === 'none' ? undefined : statusLabel?.(indexed, status);
  const answered = status === 'answered';
  const skipped = status === 'skipped';
  const settled = status === 'settled';
  const settledLabels = question.choices.filter((c) => c.settled).map((c) => c.label);
  const hasRecommendation = question.choices.some((c) => c.recommended) || !!question.suggestedText;
  // "Accept recommended" stays offered on a pick-any question whose recommendation names choices
  // until the answer is exactly those choices: ticking one box must not take away the one click
  // that ticks the rest.
  const offerAccept = !readOnly && hasRecommendation && !settled && (
    !answered
    || (question.kind === 'multi'
      && question.choices.some((c) => c.recommended)
      && !question.choices.some((c) => c.settled)
      && !isRecommendedQuestionAnswer(
        answer!,
        question.choices.filter((c) => c.recommended).map((c) => c.label),
        question.suggestedText,
      ))
  );
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
      const order = question.choices.map((c) => c.label);
      nextSelected.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      commit({ ...rest, selected: nextSelected });
    } else if (checked) {
      const { other: _o, ...single } = rest;
      commit({ ...single, selected: [label] });
    }
  };

  const pickSuggestion = (checked: boolean) => {
    const text = question.suggestedText;
    if (!text) return;
    lastPickRef.current = { label: SUGGESTION_ROW, before: answer, at: now() };
    const { skipped: _s, other: _o, ...rest } = base;
    if (question.kind === 'multi') {
      if (checked) {
        if (!suggestionPicked) replacedOtherRef.current = storedOther.trim() ? storedOther : null;
        setOtherBy('row');
        commit({ ...rest, selected, other: text });
      } else {
        const back = replacedOtherRef.current;
        replacedOtherRef.current = null;
        setOtherBy(back ? 'field' : null);
        commit({ ...rest, selected, ...(back ? { other: back } : {}) });
      }
    } else if (checked) {
      replacedOtherRef.current = null;
      setOtherBy('row');
      commit({ ...rest, selected: [], other: text });
    }
  };

  const setOther = (value: string) => {
    setOtherBy('field');
    replacedOtherRef.current = null;
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
    replacedOtherRef.current = null;
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
    if (!next) return;
    replacedOtherRef.current = null;
    if (next.other) setOtherBy('row');
    focusAfterAcceptRef.current = true;
    commit(next);
  };
  useEffect(() => {
    if (!focusAfterAcceptRef.current) return;
    focusAfterAcceptRef.current = false;
    const card = cardRef.current;
    if (!card) return;
    const active = document.activeElement;
    if (active && active !== document.body && card.contains(active)) return;
    const target = card.querySelector<HTMLElement>('input:checked:not(:disabled)')
      ?? card.querySelector<HTMLElement>('textarea:not(:disabled), input[type="text"]:not(:disabled)');
    target?.focus({ preventScroll: true });
  });

  const toggleNote = () => {
    const opening = !noteOpen;
    setNotePinned(opening);
    if (opening) requestAnimationFrame(() => noteRef.current?.focus());
  };

  const onRowPointerDown = (event: React.PointerEvent) => {
    pressRef.current = { x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' };
  };
  const onRowClick = (event: React.MouseEvent, label: string) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (event.target instanceof HTMLInputElement) return;
    const row = event.currentTarget;
    const again = lastRowClick === row;
    lastRowClick = row;
    // A double-click selects a word to annotate, never picks: the second click is cancelled, and
    // the pick the first click made (if any, on this choice, just now) is taken back.
    if (event.detail >= 2 && again) {
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
  const storedOther = answer?.other ?? '';
  const suggestionRow = question.kind !== 'text' && !!question.suggestedText;
  const suggestionPicked = suggestionRow
    && storedOther.trim() !== ''
    && storedOther.trim() === question.suggestedText!.trim()
    && (otherBy === 'row' || (otherBy === null && !otherFocused));
  const other = suggestionPicked ? '' : storedOther;
  const otherOn = other.trim() !== '';
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const [otherGlyphTop, setOtherGlyphTop] = useState<number | null>(null);
  const otherWidthRef = useRef(-1);
  const fitOther = () => {
    const field = otherRef.current;
    setOtherGlyphTop(field ? fitOtherField(field) : null);
    otherWidthRef.current = field ? field.clientWidth : -1;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => fitOther(), [other, readOnly, otherOn]);
  useEffect(() => {
    const field = otherRef.current;
    if (!field || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitOther);
    };
    const watch = new ResizeObserver(() => {
      if (field.clientWidth !== otherWidthRef.current) refit();
    });
    watch.observe(field);
    let live = true;
    document.fonts?.ready.then(() => live && refit(), () => {});
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      watch.disconnect();
    };
    // fitOther reads only refs; the field is new when these change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, otherOn]);
  const pictures = question.choices.map((c) => (c.image ? pictureSrc(c.image.src) : null));
  const showTiles = pictureChoices
    && question.kind !== 'text'
    && pictures.some((url) => url !== null && !failedPictures.has(url));
  const recommendedLabels = question.choices.filter((c) => c.recommended).map((c) => c.label);
  const showsUrl = question.shows?.kind === 'image' ? pictureSrc(question.shows.src) : null;
  const showsSrc = showsUrl !== null && !failedPictures.has(showsUrl) ? showsUrl : null;

  // A recorded decision (`question.decision`) is never affected.
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

  const describedBy = [question.stakes ? stakesId : null, question.context ? contextId : null, question.kind === 'text' && question.suggestedText && !answered ? suggestId : null]
    .filter(Boolean)
    .join(' ') || undefined;

  const suggestedLine = question.kind === 'text' && question.suggestedText && !answered && (
    <div id={suggestId} className="mt-2 text-[12.5px] text-muted-foreground" data-question-suggested="">
      <Tag tone="rec">Recommended</Tag> {inline(question.suggestedText)}
    </div>
  );

  return (
    <fieldset
      ref={cardRef}
      className={cx(
        'question-block my-5 min-w-0 rounded-[10px] border px-3.5 pb-2.5 pt-3',
        '@container/qcard',
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
        <span className="ml-auto inline-flex items-center gap-1">
          {question.decision && <><Tag tone="rec"><DiamondGlyph />Decision</Tag>{' '}</>}
          {decisionCapable && (decisionOpenable ? (
            // Two targets in one tag: the diamond switches recording, the words open the host's
            // decision card. Siblings, never nested.
            <><span
              className="annotation-exclude select-none inline-flex h-[18px] items-stretch whitespace-nowrap rounded border border-transparent text-[10.5px] font-semibold leading-4 tracking-[0.03em] bg-primary/15 text-primary"
              style={recordingOn ? undefined : DECISION_OFF_STYLE}
              data-pinpoint-ignore=""
              data-question-decision-tag=""
            >{decisionToggleable ? (
              <HostTitle title="Record as a decision"><button
                type="button"
                aria-pressed={recordingOn}
                aria-label="Record as a decision"
                onClick={() => onToggleDecisionRecording!(question.key, !recordingOn)}
                className="relative inline-flex cursor-pointer items-center rounded pl-1.5 pr-0.5 before:absolute before:-inset-1.5 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                data-question-decision-toggle=""
              ><DiamondGlyph /></button></HostTitle>
            ) : (
              <span className="inline-flex items-center pl-1.5 pr-0.5"><DiamondGlyph /></span>
            )}<button
              type="button"
              aria-haspopup="dialog"
              onClick={(event) => onOpenDecision!(question.key, event.currentTarget)}
              className="relative cursor-pointer rounded pl-0.5 pr-1.5 hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              data-question-decision-open=""
            >Records a decision</button></span>{' '}</>
          ) : decisionToggleable ? (
            <><button
              type="button"
              aria-pressed={recordingOn}
              onClick={() => onToggleDecisionRecording!(question.key, !recordingOn)}
              className={cx(PILL, 'cursor-pointer border-transparent bg-primary/15 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary')}
              style={recordingOn ? undefined : DECISION_OFF_STYLE}
              data-pinpoint-ignore=""
              data-question-decision-toggle=""
            ><DiamondGlyph />Records a decision</button>{' '}</>
          ) : recordingOn ? (
            <><Tag tone="rec"><DiamondGlyph />Records a decision</Tag>{' '}</>
          ) : (
            <><Tag tone="rec" style={DECISION_OFF_STYLE}><DiamondGlyph />Records a decision</Tag>{' '}</>
          ))}
          {question.reversible && (
            <><HostTitle title={question.reversible.why ? `Can't be undone: ${question.reversible.why}` : "Can't be undone"}>
              <span className="inline-flex" data-question-irreversible="">
                <Tag tone="warn">Can&rsquo;t be undone</Tag>
                {question.reversible.why && <span className="sr-only">: {question.reversible.why}</span>}
              </span>
            </HostTitle>{' '}</>
          )}
          {statusTag !== 'none' && hostStatus && <Tag tone={hostStatus.tone ?? 'open'}>{hostStatus.label}</Tag>}
          {statusTag !== 'none' && !hostStatus && (
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
      {question.stakes && (
        <p id={stakesId} className="m-0 mt-1 text-[13px] font-medium leading-[1.45] text-foreground/90" data-question-part="stakes">
          {inline(question.stakes)}
        </p>
      )}
      {question.shows && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px]" data-question-shows="">
          <span className="annotation-exclude select-none text-muted-foreground" data-pinpoint-ignore="">Shows</span>
          {question.shows.kind === 'image' ? (
            showsSrc && onImageClick ? (
              <button
                type="button"
                onClick={() => onImageClick(showsSrc, question.shows!.label || 'Picture')}
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/80 bg-background/60 py-0.5 pl-0.5 pr-2 text-foreground hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                data-question-shows-open=""
              >
                <img
                  src={showsSrc}
                  alt=""
                  draggable={false}
                  className="h-6 w-8 shrink-0 rounded-[4px] object-cover"
                  data-question-picture=""
                  data-zoomable=""
                  data-image-src={question.shows.src}
                  onError={() => markPictureFailed(showsSrc)}
                />
                <span className="truncate">{question.shows.label || 'Picture'}</span>
              </button>
            ) : (
              heldPlaceholder(question.shows.src, question.shows.label)
                ?? <span className="inline-flex items-center gap-1 text-foreground"><PictureGlyph />{question.shows.label || question.shows.src}</span>
            )
          ) : (
            <span className="min-w-0 text-foreground">{inline(`[${question.shows.label}](${question.shows.src})`)}</span>
          )}
        </div>
      )}
      {renderBelowPrompt?.(indexed)}
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
          {suggestedLine}
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
        <>
          <TrayIf on={hasAfterChoices} after={afterChoices}>
          <div
            className={cx(hasAfterChoices ? 'grid gap-0.5' : 'mt-2.5 grid gap-0.5', skipped && 'opacity-55')}
            role={inputType === 'radio' ? 'radiogroup' : 'group'}
            aria-labelledby={promptId}
          >
            {showTiles ? (
              <QuestionPictureTiles
                choices={question.choices}
                urls={question.choices.map((_c, index) => {
                  const url = pictures[index];
                  return url !== null && url !== undefined && !failedPictures.has(url) ? url : null;
                })}
                selected={selected}
                inputType={inputType}
                name={groupName}
                readOnly={readOnly}
                onPick={pick}
                onZoom={
                  onZoomChoice
                    ? (url, alt, index) => onZoomChoice(question.key, index, url, alt)
                    : onImageClick
                }
                onPictureError={markPictureFailed}
                heldTitle={pictureHeldTitle}
                renderText={inline}
                labelProps={(label) => ({ onPointerDown: onRowPointerDown, onClickCapture: (event) => onRowClick(event, label) })}
                pictureBadge={pictureBadge}
                pictureSize={pictureSize ? (index) => (pictures[index] ? pictureSize(pictures[index]!) : null) : undefined}
              />
            ) : (
              question.choices.map((choice) => {
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
                      data-question-control=""
                      disabled={readOnly}
                    />
                    <span className="min-w-0 flex-1 select-text text-[13.5px] leading-[1.45] text-foreground" data-question-part="choice">
                      <span className="font-[550]">{inline(choice.label)}</span>
                      {choice.image && pictureChoices && pictureHeldTitle(choice.image.src) !== null && <> {heldPlaceholder(choice.image.src, choice.image.alt || choice.label)}</>}
                      {choice.description && (
                        <span className="text-muted-foreground"> — {inline(choice.description)}</span>
                      )}
                      {choice.recommended && <> <Tag tone="rec">Recommended</Tag></>}
                    </span>
                  </label>
                );
              })
            )}
            {suggestionRow && (
              <label
                className={cx(
                  'flex items-start gap-2.5 rounded-[7px] px-[9px] py-1.5 transition-colors',
                  readOnly ? 'cursor-default' : 'cursor-pointer hover:bg-muted/45',
                  suggestionPicked && 'bg-primary/12 hover:bg-primary/12',
                )}
                data-question-option=""
                data-question-suggested=""
                onPointerDown={onRowPointerDown}
                onClickCapture={(event) => onRowClick(event, SUGGESTION_ROW)}
              >
                <input
                  type={inputType}
                  name={groupName}
                  checked={suggestionPicked}
                  onChange={(e) => pickSuggestion(e.target.checked)}
                  className="mt-[3px] h-[15px] w-[15px] shrink-0 cursor-pointer accent-primary disabled:cursor-default"
                  data-question-control=""
                  disabled={readOnly}
                />
                <span className="min-w-0 flex-1 select-text text-[13.5px] leading-[1.45] text-foreground" data-question-part="choice">
                  <span className="font-[550]">{inline(question.suggestedText!)}</span>
                  {' '}<Tag tone="rec">Recommended</Tag>
                </span>
              </label>
            )}
            {(!readOnly || otherOn) && (
              <div className="flex items-center gap-2.5 rounded-[7px] px-[9px] py-[5px]">
                <span
                  aria-hidden="true"
                  data-question-control=""
                  className={cx(
                    'annotation-exclude select-none grid h-[15px] w-[15px] shrink-0 place-items-center border-[1.5px] text-[11px] leading-none',
                    question.kind === 'multi' ? 'rounded-[3px]' : 'rounded-full',
                    otherOn ? 'border-solid border-primary bg-primary text-primary-foreground' : 'border-dashed border-border text-muted-foreground',
                  )}
                  style={otherGlyphTop === null ? undefined : { alignSelf: 'flex-start', marginTop: otherGlyphTop }}
                >
                  {otherOn ? <CheckGlyph /> : '+'}
                </span>
                <textarea
                  ref={otherRef}
                  rows={1}
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  onFocus={() => {
                    if (otherBy === null && suggestionPicked) setOtherBy('row');
                    setOtherFocused(true);
                  }}
                  onBlur={() => setOtherFocused(false)}
                  disabled={readOnly}
                  placeholder={readOnly ? '' : 'Other…'}
                  aria-label={number > 0 ? `Other answer to question ${number}` : 'Other answer'}
                  data-question-other=""
                  className={cx(
                    'annotation-exclude min-w-0 flex-1 resize-none overflow-hidden break-words border-0 border-b border-transparent bg-transparent py-[3px] text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring',
                    !readOnly && 'max-h-48',
                  )}
                />
              </div>
            )}
          </div>
          </TrayIf>
        </>
      )}

      {question.why && (
        <p className="m-0 mt-2 text-[12.5px] leading-[1.45] text-muted-foreground" data-question-part="why">
          <span className="font-semibold text-foreground/85">
            {recommendedLabels.length > 0 ? <>Why {recommendedLabels.map((label, i) => <React.Fragment key={label}>{i > 0 ? ', ' : ''}{inline(label)}</React.Fragment>)}:</> : 'Why:'}
          </span>{' '}
          {inline(question.why)}
        </p>
      )}

      {question.kind !== 'text' && question.choices.some((c) => c.pros?.length || c.cons?.length) && (
        <div className="annotation-exclude" data-pinpoint-ignore="" data-question-part="tradeoffs">
          <button
            type="button"
            className="group -ml-1.5 mt-1.5 inline-flex items-center gap-1 rounded-lg border-0 bg-transparent px-1.5 py-[3px] text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            aria-expanded={tradeoffsOpen}
            aria-controls={tradeoffsId}
            onClick={() => setTradeoffsOpen((open) => !open)}
            data-question-tradeoffs-toggle=""
          >
            <ChevronRightGlyph />
            Trade-offs
          </button>
          <div
            id={tradeoffsId}
            hidden={!tradeoffsOpen}
            role="table"
            aria-label="Trade-offs"
            className="mb-0.5 mt-1 grid gap-2.5 text-[12.5px] leading-[1.45] @min-[600px]/qcard:gap-2"
            data-question-tradeoffs=""
          >
            <div role="row" className="hidden text-[12px] font-semibold text-foreground/85 @min-[600px]/qcard:grid @min-[600px]/qcard:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)] @min-[600px]/qcard:gap-x-[18px]">
              <span role="columnheader"><span className="sr-only">Option</span></span>
              <span role="columnheader">Pros</span>
              <span role="columnheader">Cons</span>
            </div>
            {question.choices.map((c, i) => (
              <div
                key={`${i}:${c.label}`}
                role="row"
                className="grid grid-cols-[minmax(0,1fr)] gap-y-0.5 @min-[600px]/qcard:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)] @min-[600px]/qcard:gap-x-[18px]"
                data-question-tradeoffs-row=""
              >
                <span role="rowheader" className="min-w-0 break-words text-[13px] font-[550] text-foreground">{inline(c.label)}</span>
                {(['pros', 'cons'] as const).map((side) => (
                  <span
                    key={side}
                    role="cell"
                    className="grid min-w-0 grid-cols-[38px_minmax(0,1fr)] gap-2 text-muted-foreground @min-[600px]/qcard:block"
                  >
                    <b className="font-semibold text-foreground/85 @min-[600px]/qcard:sr-only">{side === 'pros' ? 'Pros' : 'Cons'}</b>
                    <span className="min-w-0 break-words">
                      {c[side]?.length ? inline(c[side]!.join('; ')) : <span aria-label="none">-</span>}
                    </span>
                  </span>
                ))}
              </div>
            ))}
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
          className="annotation-exclude select-none mt-2 flex flex-wrap items-center gap-1 pointer-coarse:gap-y-5 border-t border-border/55 pt-1.5"
          data-pinpoint-ignore=""
        >
          {!readOnly && (
            <button
              type="button"
              onClick={toggleNote}
              aria-expanded={noteOpen}
              className={cx(
                FOOT_BUTTON,
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
                FOOT_BUTTON,
                'rounded-[5px] px-[7px] py-[3px] text-xs hover:bg-muted hover:text-foreground',
                skipped ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {skipped ? 'Unskip' : 'Skip'}
            </button>
          )}
          {!hasHostFooter && !dirty ? (
            offerAccept && (
              <button
                type="button"
                onClick={acceptRecommended}
                className={cx(FOOT_BUTTON, FOOT_FIT, FOOT_OWN_ROW, 'ml-auto rtl:ml-0 rtl:mr-auto rounded-md border border-primary/45 bg-primary/10 px-2.5 py-[3px] text-[12.5px] font-medium text-primary hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary')}
              >
                Accept recommended
              </button>
            )
          ) : (
            <div className={cx(FOOT_OWN_ROW, 'ml-auto rtl:ml-0 rtl:mr-auto flex min-w-0 flex-wrap items-center justify-end gap-1')}>
              {offerAccept && (
                <button
                  type="button"
                  onClick={acceptRecommended}
                  className={cx(FOOT_BUTTON, FOOT_FIT, 'rounded-md border border-primary/45 bg-primary/10 px-2.5 py-[3px] text-[12.5px] font-medium text-primary hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary')}
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
                    className={cx(FOOT_BUTTON, FOOT_FIT, 'rounded-[5px] px-[7px] py-[3px] text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60')}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    aria-busy={saving || undefined}
                    className={cx(FOOT_BUTTON, FOOT_FIT, 'rounded-md bg-primary px-2.5 py-[3px] text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60')}
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

export interface QuestionPictureTileChoice {
  label: string;
  description?: string | null;
  recommended?: boolean;
  image?: { alt: string; src: string } | null;
}

export interface QuestionPictureTilesProps {
  choices: readonly QuestionPictureTileChoice[];
  urls: readonly (string | null)[];
  selected: readonly string[];
  inputType: 'radio' | 'checkbox';
  name: string;
  readOnly?: boolean;
  onPick: (label: string, checked: boolean) => void;
  onZoom?: (url: string, alt: string, index: number) => void;
  onPictureError?: (url: string) => void;
  heldTitle?: (src: string) => string | null;
  renderText: (text: string) => React.ReactNode;
  labelProps?: (label: string) => React.LabelHTMLAttributes<HTMLLabelElement>;
  inputProps?: (label: string) => React.InputHTMLAttributes<HTMLInputElement>;
  renderBadges?: (choice: QuestionPictureTileChoice, index: number) => React.ReactNode;
  pictureBadge?: (choice: { label: string; image: { alt: string; src: string } }) => string | null;
  pictureSize?: (index: number) => QuestionPictureSize | null;
}

/**
 * The question card draws these, and so does the Inbox's decision mode (its own size through
 * `[data-question-tile*]` hooks), so the two never drift.
 */
export const QuestionPictureTiles: React.FC<QuestionPictureTilesProps> = ({
  choices,
  urls,
  selected,
  inputType,
  name,
  readOnly = false,
  onPick,
  onZoom,
  onPictureError,
  heldTitle,
  renderText,
  labelProps,
  inputProps,
  renderBadges,
  pictureBadge,
  pictureSize,
}) => {
  // Known before any picture loads, so a host's layout (inbox.css) never moves once they do.
  const sizes = choices.map((choice, index) => (choice.image ? readQuestionPictureSize(pictureSize?.(index)) : null));
  const shapes: (QuestionPictureShape | null)[] = sizes.map((size) => (size ? questionPictureShape(size) : null));
  const pictured = choices.flatMap((choice, index) => (choice.image ? [shapes[index] ?? null] : []));
  return (
    <div
      className="mb-1 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2"
      data-question-tiles=""
      data-question-tiles-count={choices.length}
      data-question-tiles-shape={questionPicturesShape(pictured)}
      data-question-tiles-words={questionChoiceWords(choices)}
      data-question-tiles-bare={choices.some((choice) => !choice.image) ? '' : undefined}
    >
      {choices.map((choice, index) => {
        const checked = selected.includes(choice.label);
        const shown = urls[index] ?? null;
        const size = sizes[index];
        const alt = choice.image ? (choice.image.alt || choice.label) : '';
        const decorative = !!choice.image && alt.trim() === choice.label.trim();
        const host = labelProps?.(choice.label);
        const input = inputProps?.(choice.label);
        const held = choice.image && !shown ? (heldTitle?.(choice.image.src) ?? null) : null;
        return (
          <div
            key={choice.label}
            className={cx(
              'relative flex min-w-0 flex-col overflow-hidden rounded-[9px] border transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary',
              checked ? 'border-primary/70 bg-primary/10' : 'border-border/80 bg-background/40',
              !readOnly && !checked && 'hover:border-foreground/30',
            )}
            data-question-tile=""
            data-question-tile-checked={checked ? '' : undefined}
            data-question-tile-recommended={choice.recommended ? '' : undefined}
            data-question-tile-shape={shapes[index] ?? undefined}
            data-question-tile-no-picture={choice.image ? undefined : ''}
          >
            <label
              {...host}
              className={cx('flex min-w-0 flex-1 flex-col', readOnly ? 'cursor-default' : 'cursor-pointer')}
              data-question-option=""
            >
              {choice.image && (
                <span
                  className="annotation-exclude select-none block aspect-[4/3] w-full overflow-hidden border-b border-border/60 bg-muted/35"
                  style={
                    size
                      ? ({ position: 'relative', '--question-picture-ratio': `${size.width} / ${size.height}`, '--question-picture-width': `${size.width}px` } as React.CSSProperties)
                      : { position: 'relative' }
                  }
                  data-pinpoint-ignore=""
                  data-question-tile-picture=""
                >
                  {(() => {
                    const badge = pictureBadge?.({ label: choice.label, image: choice.image });
                    return badge ? (
                      <span style={PICTURE_BADGE_STYLE} data-question-picture-badge="">
                        {badge}
                      </span>
                    ) : null;
                  })()}
                  {shown ? (
                    <img
                      src={shown}
                      alt={decorative ? '' : alt}
                      draggable={false}
                      loading="lazy"
                      className="h-full w-full object-contain"
                      data-question-picture=""
                      data-zoomable=""
                      data-image-src={choice.image.src}
                      onError={() => onPictureError?.(shown)}
                    />
                  ) : (
                    <span
                      className="grid h-full place-items-center px-2 text-center text-xs text-muted-foreground"
                      title={held ?? undefined}
                      data-image-unavailable=""
                      data-question-picture-failed={held ? undefined : ''}
                    >
                      {alt}
                    </span>
                  )}
                </span>
              )}
              <span className="flex w-full min-w-0 items-start gap-2 px-2.5 py-2" data-question-tile-caption="">
                <input
                  {...input}
                  type={inputType}
                  name={name}
                  checked={checked}
                  onChange={(e) => onPick(choice.label, e.target.checked)}
                  className="mt-[3px] h-[15px] w-[15px] shrink-0 cursor-pointer accent-primary disabled:cursor-default"
                  data-question-control=""
                  disabled={readOnly}
                />
                <span className="min-w-0 flex-1 select-text text-[13px] leading-[1.4] text-foreground" data-question-part="choice">
                  <span className="font-[550]" data-question-tile-label="">{renderText(choice.label)}</span>
                  {choice.description && (
                    <span className="block text-muted-foreground" data-question-tile-description="">{renderText(choice.description)}</span>
                  )}
                  {renderBadges
                    ? renderBadges(choice, index)
                    : choice.recommended && <span className="mt-1 block"><Tag tone="rec">Recommended</Tag></span>}
                </span>
              </span>
            </label>
            {shown && onZoom && (
              <button
                type="button"
                onClick={() => onZoom(shown, alt, index)}
                aria-label={`Zoom: ${alt}`}
                className="annotation-exclude absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-md bg-background/85 text-foreground shadow-sm ring-1 ring-border/70 before:absolute before:-inset-2 before:content-[''] hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                data-pinpoint-ignore=""
                data-question-zoom=""
              >
                <ZoomGlyph />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
