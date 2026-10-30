import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
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
 *
 * The optional contract lines (approval "inbox-decision-mode"): `Stakes:` is
 * a short emphasised line under the prompt, `Shows:` a chip that opens the
 * picture (through `onImageClick`) or the file (an ordinary link), `Why:` a
 * line under the choices ("Why <recommended>: …"), and `Reversible: no` a
 * "Can't be undone" tag in the eyebrow. The card adds no confirm step.
 *
 * Picture choices (`choice.image`) draw as a grid of tiles: the picture and
 * the label pick (a real radio or checkbox in each tile), a separate zoom
 * button opens the picture (`onImageClick`), the label and description sit
 * under it. When no picture can be shown (the host's image resolver says
 * `unavailable`, every picture failed to load, or `pictureChoices={false}`)
 * the choices are the ordinary text rows. The recommended answer that is
 * none of the choices, and Other, stay text rows.
 */

/** Pointer travel (px) above which a press on a choice row is a drag. */
const DRAG_THRESHOLD_MOUSE = 4;
const DRAG_THRESHOLD_TOUCH = 10;
/** A second click on the same choice within this window is a double-click:
 *  it selects a word, so the pick its first click made is taken back. */
const DOUBLE_CLICK_REVERT_MS = 800;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The double-click guard's name for the recommended row (never a label: it
 *  holds a character no choice label can). */
const SUGGESTION_ROW = '\u0000suggestion';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** The box every pill in the eyebrow shares (the status tags, the decision
 *  tags, the toggle and the split tag): one height, one line-height, and a
 *  1px border on all of them (transparent unless the tone draws it), so the
 *  dashed "Open" tag is no taller than the rest. The pill group itself is a
 *  flex row centred on its axis, so no pill rides its own baseline (the split
 *  tag's baseline came from its icon-only switch, which lifted it).
 *  `align-[1px]` does nothing inside that flex row; it stays because it is
 *  the only use of the class, and dropping it would change the stylesheet
 *  the guides.show viewer pins (a deploy for no visible change). */
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

/** Draws a decision tag in its "off" state: the same words with a dotted
 *  outline instead of the tinted fill, faded. The theme's muted-foreground
 *  alone is exactly the "Open" tag's color beside it, so the off tag read as
 *  barely dimmer than an on one. Text, icon and outline (all `currentColor`)
 *  are muted-foreground mixed 55% with transparent: the look of
 *  `opacity: 0.55` on the tag, without `opacity`, which would also fade the
 *  keyboard focus ring (a `ring-primary` box-shadow on the tag's buttons)
 *  that must stay at full strength. Inline so it adds no utility classes to
 *  the shared stylesheet and wins over the tag's `text-primary`. */
const DECISION_OFF_STYLE: React.CSSProperties = {
  background: 'transparent',
  color: 'color-mix(in oklab, var(--muted-foreground) 55%, transparent)',
  outline: '1px dotted currentColor',
  outlineOffset: '-1px',
};

/**
 * The footer in a narrow column. The card is a size container
 * (`@container/qcard`: the card's own width, never the viewport's, because
 * the card sits in columns of every width), and the footer row wraps whole
 * buttons:
 * - No button's words ever wrap inside it (`whitespace-nowrap`): the row
 *   wraps between buttons instead, and only when they do not fit on one
 *   row, so Add note and Skip stay together and Accept recommended moves
 *   down whole, still at the row's end (`ml-auto`).
 * - Under 10rem inside the card (a card under about 190 px), where a button
 *   may be wider than the card, Accept recommended and the save bar take a
 *   row of their own and their words end in an ellipsis rather than leave
 *   the card (`FOOT_FIT`; the name stays whole). The words stay one text
 *   node: a split one moved the glyphs of a wide card by a fraction of a
 *   pixel.
 * - On a touch screen each button's hit area is at least 44 x 44 px: an
 *   invisible `before:` box centred on it, as the header's decision tag
 *   does, so the drawn button does not change. (An ellipsised button clips
 *   that box to itself.) A box reaches up to 11 px past its button, so a
 *   wrapped footer's rows sit 20 px apart on a touch screen
 *   (`pointer-coarse:gap-y-5`, the footer row): with the 4 px of `gap-1`,
 *   Accept recommended's box, later in the page, covered the bottom of Skip
 *   and Add note above it, and a tap on Skip answered the question. One row
 *   has no row gap, so a footer that fits is unchanged.
 * A footer that fits on one row draws exactly as before, on any pointer.
 */
const FOOT_BUTTON = "whitespace-nowrap pointer-coarse:relative pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:h-11 pointer-coarse:before:w-full pointer-coarse:before:min-w-11 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']";
const FOOT_FIT = '@max-[10rem]/qcard:max-w-full @max-[10rem]/qcard:overflow-hidden @max-[10rem]/qcard:text-ellipsis';
const FOOT_OWN_ROW = '@max-[10rem]/qcard:basis-full';

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
  /** The host's own words for the card's status tag, per question (ui seam;
   *  the Plannotator Inbox says "Not sent" for a pick it has saved but not
   *  sent, where the card would say "Answered"). Return undefined for the
   *  card's own tag. Absent: today's tags. Ignored with `statusTag: 'none'`. */
  statusLabel?: (question: IndexedQuestion, status: QuestionStatus) => QuestionStatusLabel | undefined;
  /** Host content drawn right under the prompt (a host note such as "Replaces
   *  <an earlier question>"), given the question. Return null for none.
   *  Absent: nothing is drawn there (today's card). */
  renderBelowPrompt?: (question: IndexedQuestion) => React.ReactNode;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  githubRepo?: string;
  repoHost?: string;
  onNavigateAnchor?: (hash: string) => void;
  /** Draw picture choices (`choice.image`) as picture tiles (default true).
   *  False: every choice is a text row, as on a host that shows no images. */
  pictureChoices?: boolean;
  /** A small label over a picture tile's picture, top left ("Mockup · VS
   *  Code"), from the host; null or absent: none. Display only: never the
   *  answer, never read by the parser. Default absent, so every card draws as
   *  before (the Plannotator Inbox's onboarding tour labels its pictures). */
  pictureBadge?: (choice: { label: string; image: { alt: string; src: string } }) => string | null;
  /** The zoom button on a picture tile, told which question and which choice
   *  (its index in the question's choices) as well as the picture: a host can
   *  open a gallery of that question's choices (the Plannotator Inbox's option
   *  sets). Absent: the zoom calls `onImageClick(url, alt)` as before. */
  onZoomChoice?: (key: string, index: number, url: string, alt: string) => void;
}

/** The picture tile's label (`pictureBadge`): a small dark chip over the picture's top-left corner. */
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
}) => {
  const { question, number } = indexed;
  const resolveImage = useImageResolver();
  // The URL a picture loads from, exactly as an inline markdown image of the
  // same src would (the host's resolver first), or null when the host says
  // it cannot be shown.
  const pictureSrc = (src: string): string | null => {
    const resolved = resolveImage ? resolveImage(src) : null;
    if (resolved?.kind === 'unavailable') return null;
    if (resolved?.kind === 'src') return resolved.src;
    return /^(https?:\/\/|data:|blob:)/i.test(src) ? src : getImageSrc(src, imageBaseDir);
  };
  // The host's reason a picture is not shown (its resolver's `unavailable`
  // title), drawn on the placeholder exactly as an inline image's, so a host
  // that holds remote images counts and loads these too (code review's PR
  // Markdown preview: "N remote images held · Load remote images").
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
  // Pictures that failed to load (by the URL tried): a tile shows its alt
  // text instead, and with none left the choices are text rows.
  const [failedPictures, setFailedPictures] = useState<ReadonlySet<string>>(() => new Set());
  const markPictureFailed = (url: string) => setFailedPictures((prev) => (prev.has(url) ? prev : new Set([...prev, url])));
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
    replacedOtherRef.current = null;
    setDraft(null);
    setNotePinned(null);
  };
  const hostFooter = renderFooter?.(indexed, savedAnswer);
  const hasHostFooter = hostFooter !== null && hostFooter !== undefined && hostFooter !== false;
  const uid = useId().replace(/:/g, '');
  const promptId = `q-prompt-${uid}`;
  const contextId = `q-context-${uid}`;
  const stakesId = `q-stakes-${uid}`;
  const suggestId = `q-suggest-${uid}`;
  const noteLabelId = `q-note-${uid}`;
  // null = follow the answer (open while a note exists); a click pins it.
  const [notePinned, setNotePinned] = useState<boolean | null>(null);
  const noteOpen = notePinned ?? !!answer?.note?.trim();
  const pressRef = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLFieldSetElement>(null);
  // Accept recommended goes away once clicked: focus moves to what
  // the click filled in, never to the page.
  const focusAfterAcceptRef = useRef(false);
  const lastPickRef = useRef<{ label: string; before: QuestionAnswer | undefined; at: number } | null>(null);
  // Who set the "Other…" answer while this card was open: the recommended
  // row (its pick, or Accept recommended) or the Other field. null: neither
  // (an answer the host stored): an Other answer that is exactly the agent's
  // text then reads as the row, unless the Other field has focus. Typing
  // never turns into the row, so "Yes, but slower" stays in the field when
  // the recommendation is "Yes".
  const [otherBy, setOtherBy] = useState<'row' | 'field' | null>(null);
  const [otherFocused, setOtherFocused] = useState(false);
  // Pick any: the reviewer's own Other text the recommended row replaced when
  // ticked, put back when it is unticked (the answer has one Other field).
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

  // A note alone does not change a settled choice: the [x] stays drawn (and
  // the status stays Settled) until the reviewer picks, fills Other or skips.
  const status = questionStatus(question, answer);
  const hostStatus = statusTag === 'none' ? undefined : statusLabel?.(indexed, status);
  const answered = status === 'answered';
  const skipped = status === 'skipped';
  const settled = status === 'settled';
  const settledLabels = question.choices.filter((c) => c.settled).map((c) => c.label);
  const hasRecommendation = question.choices.some((c) => c.recommended) || !!question.suggestedText;
  // "Accept recommended" stays offered on a pick-any question whose
  // recommendation names choices until the answer is exactly those choices:
  // ticking one box must not take away the one click that ticks the rest. A
  // pick-one or text question answered any way, a question with a settled
  // choice, and a pick-any question recommending only its own answer (the
  // recommended row after the choices: Accept would clear the ticks for it,
  // and the row is one click anyway) offer it no more.
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
      // Keep document order, not click order.
      const order = question.choices.map((c) => c.label);
      nextSelected.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      commit({ ...rest, selected: nextSelected });
    } else if (checked) {
      const { other: _o, ...single } = rest;
      commit({ ...single, selected: [label] });
    }
  };

  // The agent's recommended answer that is none of its choices
  // (`suggestedText` on a pick question): one more answer row, after the
  // choices and before "Other…". Picking it stores exactly what Accept
  // recommended stores, the text as the "Other…" answer, so no label,
  // index, key or host check of picked labels changes.
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
  // Runs after the render that drew the accepted answer (and once more at
  // most, should the host not redraw it): the first checked choice, else the
  // field holding the suggestion.
  useEffect(() => {
    if (!focusAfterAcceptRef.current) return;
    focusAfterAcceptRef.current = false;
    const card = cardRef.current;
    if (!card) return;
    // Focus still on something in the card (the button was not removed): leave it.
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
  const storedOther = answer?.other ?? '';
  // The recommended row holds the "Other…" answer when it is the agent's
  // text; the Other field is then empty (typing there replaces it).
  const suggestionRow = question.kind !== 'text' && !!question.suggestedText;
  const suggestionPicked = suggestionRow
    && storedOther.trim() !== ''
    && storedOther.trim() === question.suggestedText!.trim()
    && (otherBy === 'row' || (otherBy === null && !otherFocused));
  const other = suggestionPicked ? '' : storedOther;
  const otherOn = other.trim() !== '';
  // Picture choices: each choice's picture URL (null: none, or not shown).
  const pictures = question.choices.map((c) => (c.image ? pictureSrc(c.image.src) : null));
  const showTiles = pictureChoices
    && question.kind !== 'text'
    && pictures.some((url) => url !== null && !failedPictures.has(url));
  const recommendedLabels = question.choices.filter((c) => c.recommended).map((c) => c.label);
  const showsUrl = question.shows?.kind === 'image' ? pictureSrc(question.shows.src) : null;
  // A `Shows:` picture that failed to load is its label, as a picture tile's is.
  const showsSrc = showsUrl !== null && !failedPictures.has(showsUrl) ? showsUrl : null;

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

  const describedBy = [question.stakes ? stakesId : null, question.context ? contextId : null, question.kind === 'text' && question.suggestedText && !answered ? suggestId : null]
    .filter(Boolean)
    .join(' ') || undefined;

  // A text question's recommended answer: shown above the field with the
  // same Recommended tag a choice carries; the footer's Accept recommended
  // fills it in. (A pick question's is a row of its own, below.)
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
        // A size container: the card's own width lays out its footer (FOOT_BUTTON).
        '@container/qcard',
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
        <span className="ml-auto inline-flex items-center gap-1">
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
            // Focus shows as a ring, not an outline: the dotted outline is
            // what draws the off state.
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
          <div
            className={cx('mt-2.5 grid gap-0.5', skipped && 'opacity-55')}
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
              // The agent's recommended answer that is none of its choices:
              // drawn exactly as a choice (the same control, row and tag), so
              // the card reads as one list of answers.
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
            {/* A read-only card with no Other answer has nothing to show there (it drew a bare "+"). */}
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
                >
                  {otherOn ? <CheckGlyph /> : '+'}
                </span>
                <input
                  type="text"
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  onFocus={() => {
                    // A stored answer that reads as the row stays the row
                    // while the reviewer types here (typing replaces it).
                    if (otherBy === null && suggestionPicked) setOtherBy('row');
                    setOtherFocused(true);
                  }}
                  onBlur={() => setOtherFocused(false)}
                  disabled={readOnly}
                  placeholder={readOnly ? '' : 'Other…'}
                  aria-label={number > 0 ? `Other answer to question ${number}` : 'Other answer'}
                  className="annotation-exclude min-w-0 flex-1 border-0 border-b border-transparent bg-transparent py-[3px] text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring"
                />
              </div>
            )}
          </div>
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
          {/* Plannotator's own footer (no host actions, no save bar) keeps the
              Accept button as the one right-aligned item. */}
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

/** One choice a picture tile draws (a parsed question's choice, or the Inbox wire's). */
export interface QuestionPictureTileChoice {
  label: string;
  description?: string | null;
  recommended?: boolean;
  image?: { alt: string; src: string } | null;
}

export interface QuestionPictureTilesProps {
  choices: readonly QuestionPictureTileChoice[];
  /** The URL each choice's picture loads from, in choice order; null (no picture shown) draws its alt text. */
  urls: readonly (string | null)[];
  selected: readonly string[];
  inputType: 'radio' | 'checkbox';
  /** The radio group's name. */
  name: string;
  readOnly?: boolean;
  /** The tile's radio or checkbox changed (the picture and the label pick through it). */
  onPick: (label: string, checked: boolean) => void;
  /** The separate zoom button (absent: no zoom button). Never picks. `index`: the choice's place in `choices`. */
  onZoom?: (url: string, alt: string, index: number) => void;
  onPictureError?: (url: string) => void;
  /** The host's reason a picture is held (its image resolver's `unavailable` title). */
  heldTitle?: (src: string) => string | null;
  /** How a label or description is drawn (the card's inline markdown). */
  renderText: (text: string) => React.ReactNode;
  /** A host's own props on each tile's label (the card's drag guard). */
  labelProps?: (label: string) => React.LabelHTMLAttributes<HTMLLabelElement>;
  /** A host's own props on each tile's input (decision mode answers on a click, or Enter). */
  inputProps?: (label: string) => React.InputHTMLAttributes<HTMLInputElement>;
  /** What sits under a choice's words (default: its Recommended tag). */
  renderBadges?: (choice: QuestionPictureTileChoice, index: number) => React.ReactNode;
  /** A small label over a tile's picture, top left (the card's `pictureBadge`); null or absent draws none. */
  pictureBadge?: (choice: { label: string; image: { alt: string; src: string } }) => string | null;
}

/**
 * Picture choices as tiles (approval "inbox-decision-mode", agent contract
 * lines): each tile is a native `<label>` holding the picture and a real radio
 * or checkbox, so the picture, the label and the keyboard pick; a separate
 * zoom button, outside the label, opens the picture and never picks. The
 * question card draws these, and so does the Inbox's decision mode (its own
 * size through `[data-question-tile*]` hooks), so the two never drift.
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
}) => (
  <div
    className="mb-1 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2"
    data-question-tiles=""
  >
    {choices.map((choice, index) => {
      const checked = selected.includes(choice.label);
      const shown = urls[index] ?? null;
      // The alt text names the picture; one that only repeats the label is decorative.
      const alt = choice.image ? (choice.image.alt || choice.label) : '';
      const decorative = !!choice.image && alt.trim() === choice.label.trim();
      const host = labelProps?.(choice.label);
      const input = inputProps?.(choice.label);
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
        >
          <label
            {...host}
            className={cx('flex min-w-0 flex-1 flex-col', readOnly ? 'cursor-default' : 'cursor-pointer')}
            data-question-option=""
          >
            {choice.image && (
              <span
                className="annotation-exclude select-none block aspect-[4/3] w-full overflow-hidden border-b border-border/60 bg-muted/35"
                // Inline, not a utility class: the badge's position needs it, and no new class reaches the guides.show viewer's CSS.
                style={{ position: 'relative' }}
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
                    title={heldTitle?.(choice.image.src) ?? undefined}
                    data-image-unavailable=""
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
