/**
 * Fitting the thread foot's button row on one line (review of PR #2091).
 *
 * The "N open questions" button takes the longest label that keeps every
 * button of the row on one line: "6 open questions" (or "6 questions, 2
 * action items" when both wait), then "6 open", then "6" (the question icon
 * and the count; with both kinds, their sum). A phone tries the long form
 * first too (owner, 2026-10-30: "it should say both"), then "6 open", then "6".
 * Before a form gives way to a shorter one, the row tries it tightened: the
 * buttons' side padding and the gaps get smaller and the button drops its
 * chevron (`data-fit-tight`, inbox.css), as a phone with Send and Edit draft
 * needs.
 * And on a phone the "↓ N new" pill, laid over the middle of the row, moves
 * above the foot when a button sits under that middle.
 *
 * The rules are pure; `fitFootRow` tries them against the page's own layout.
 */

import { openItemsLabel } from './openQuestions';

/** The button's label, longest first. */
export type OpenQuestionsLabelForm = 'full' | 'short' | 'count';

export const OPEN_QUESTIONS_LABEL_FORMS: readonly OpenQuestionsLabelForm[] = ['full', 'short', 'count'];

/**
 * The visible words of each form: "6 open questions" / "6 open" / "6". With
 * action items: "2 open action items" alone, "6 questions, 2 action items"
 * with questions (`openItemsLabel`); the short forms count both ("8 open", "8").
 * `permission` (only a launched agent's permission prompts wait): "1 permission
 * waiting" / "1 waiting" / "1". `skip` (this Send skips that many questions,
 * the ones the list's "Skip them" counted): "6 to skip" / "6 to skip" / "6".
 * Nothing to count: "Questions", or with `answered` (every listed question is
 * answered in the draft) no words at all: the button is its icon.
 */
export function openQuestionsFormText(questions: number, form: OpenQuestionsLabelForm, actions = 0, permission = false, skip: number | null = null, answered = false): string {
  // This Send skips the questions the list's "Skip them" counted (approval "reply-bar-pairs"): "6 to skip", or "6" at
  // the count, with the skip glyph. Action items are never skipped, so they are not in it.
  if (skip !== null && skip > 0) return form === 'count' ? String(skip) : `${skip} to skip`;
  const n = questions + actions;
  // Nothing left to count: every listed question answered in the draft draws the icon alone ("? ⌄", never a bare "0");
  // only Re-ask or "Decide these" keep the list: its name.
  if (n === 0) return answered ? '' : 'Questions';
  if (form === 'count') return String(n);
  if (permission) return form === 'short' ? `${n} waiting` : `${n} permission${n === 1 ? '' : 's'} waiting`;
  if (form === 'short') return `${n} open`;
  return openItemsLabel(questions, actions);
}

/** One way to draw the button: a label form, on the row's usual spacing or the tight one. */
export interface FootFit {
  form: OpenQuestionsLabelForm;
  tight: boolean;
}

/**
 * The ways to try, best first: each form no longer than `max`, longest
 * first, on the usual spacing and then on the tight one. Words come before
 * spacing: "5 open" on a slightly tighter row says more than "5" on the usual.
 */
export function footFitCandidates(max: OpenQuestionsLabelForm): FootFit[] {
  const forms = OPEN_QUESTIONS_LABEL_FORMS.slice(OPEN_QUESTIONS_LABEL_FORMS.indexOf(max));
  return forms.flatMap((form) => [
    { form, tight: false },
    { form, tight: true },
  ]);
}

/**
 * A way to draw the foot of full screen's card on a phone. `fit` is the foot's `data-fit` (inbox.css), its tokens:
 * `chips`: "2 comments" becomes its icon and the number; `link`: "Open in thread" becomes "Thread"; `stack`: the chips
 * take a row of their own over the paperclip, the mic and the link; `wrap`: the chips may wrap in that row.
 */
export interface CardFootFit extends FootFit {
  fit: string;
}

/**
 * What yields on the card's foot, in order, until the row holds: the open questions' words (as in the thread's foot),
 * then the comments' word, then the link's first words; the icons, numbers and targets never shrink. Only then, with
 * text sizes a phone's row cannot hold, do the chips take their own row, with their words back as far as they fit.
 */
export function cardFootFitCandidates(): CardFootFit[] {
  const count: FootFit = { form: 'count', tight: false };
  const rows = (forms: readonly FootFit[], fit: string) => forms.map((form) => ({ ...form, fit }));
  const words = footFitCandidates('full').filter((c) => !c.tight);
  return [...rows(words, ''), ...rows([count], 'chips'), ...rows([count], 'chips link'), ...rows(words, 'stack'), ...rows([count], 'stack chips'), ...rows([count], 'stack chips link wrap')];
}

/** All on one line: every box starts within a pixel of the first. */
export function onOneLine(tops: readonly number[]): boolean {
  return tops.every((top) => Math.abs(top - tops[0]!) <= 1);
}

export interface Span {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlaps = (a: Span, b: Span) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Whether the pill, centred on the row with `margin` around it, would lie
 * over one of the row's buttons. Direction-agnostic: it compares boxes.
 */
export function pillHitsButtons(row: Span, pill: { width: number; height: number }, buttons: readonly Span[], margin = 8): boolean {
  const cx = (row.left + row.right) / 2;
  const cy = (row.top + row.bottom) / 2;
  const box: Span = {
    left: cx - pill.width / 2 - margin,
    right: cx + pill.width / 2 + margin,
    top: cy - pill.height / 2,
    bottom: cy + pill.height / 2,
  };
  return buttons.some((b) => b.right > b.left && overlaps(box, b));
}

// ── DOM ──

/** The children of a flex row that take part in its layout (not hidden, not taken out of flow). */
export function laidOutChildren(row: Element): HTMLElement[] {
  return [...row.children].filter((el): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.position !== 'absolute' && style.position !== 'fixed';
  });
}

/**
 * The children that must share a line: not one that always takes its own (`flex-basis: 100%`, a phone's Send to
 * another session and Archive), so those two never cost the open questions their words.
 */
function sameLineChildren(row: Element): HTMLElement[] {
  return laidOutChildren(row).filter((el) => getComputedStyle(el).flexBasis !== '100%');
}

/**
 * Tries each way in turn on the page itself (before paint: the caller runs in
 * a layout effect) and leaves the button drawn the first way that keeps the
 * row on one line; none does: the last. `apply` draws one way on the button.
 * Null where there is no layout (a test DOM, a hidden pane). `fits` is an
 * extra test of the page drawn that way (the full-screen composer's chips,
 * which cannot wrap a lone pill, ask that nothing runs past the row's end).
 */
export function fitFootRow<T>(buttons: HTMLElement, candidates: readonly T[], apply: (fit: T) => void, fits: () => boolean = () => true): T | null {
  if (buttons.getBoundingClientRect().width <= 0 || candidates.length === 0) return null;
  for (const fit of candidates) {
    apply(fit);
    if (onOneLine(sameLineChildren(buttons).map((el) => el.getBoundingClientRect().top)) && fits()) return fit;
  }
  return candidates[candidates.length - 1]!;
}

// ── The whole row: buttons and the draft status on one line ──
//
// The owner, on the foot beside a file (2026-10-25): "We can make the text
// shorter before we start multi-lining buttons and stuff on top of each
// other." With the draft status at the row's end (approval
// "thread-foot-status-right"), the row shortens one step at a time before the
// status takes its own line above the buttons:
//   0. keys   the buttons' keycaps (R): drawn for the eye only, so they go before any words
//             (approval "inbox-keyboard-shortcuts"; the key stays in aria-keyshortcuts and the map)
//   1. edit   "Edit draft" → "Edit"
//   2. oq     "2 open questions ⌄" → the icon, "2" and the chevron
//   3. draft  the pick words after the Draft pill go; the comment count stays,
//             as a comment glyph and the number inside the pill ("Draft 💬3";
//             with no comments, "Draft" alone)
//   4. tight  the buttons' side padding and the gaps (the status's too) get smaller
// (The checklist's own step went with its foot button: the checklist is a line at the top of the thread now,
// approval "inbox-checklist-spinners-2026-11-07".)
// Each step keeps the ones before it. The long words stay in the page as
// visually hidden text (inbox.css), so names and descriptions are whole.
// A phone has no status at the row's end (approval "reply-bar-pairs": Edit draft carries the draft's count and the
// skip lives in the open questions list), so this runs on a computer only; a phone's open questions button fits
// itself among the buttons.

/** One step of shortening; a level is the first N of them. */
export type FootRowStep = 'keys' | 'edit' | 'oq' | 'draft' | 'tight';

/** The steps, in order. */
export const FOOT_ROW_STEPS: readonly FootRowStep[] = ['keys', 'edit', 'oq', 'draft', 'tight'];

/** The row's `data-fit` at a level: the steps taken, space-separated ("" at level 0). */
export function footRowTokens(level: number): string {
  return FOOT_ROW_STEPS.slice(0, Math.max(0, level)).join(' ');
}

/** The open questions button's form at a level: `max` until the `oq` step, then the count. */
export function footRowOpenQuestionsForm(level: number, max: OpenQuestionsLabelForm): OpenQuestionsLabelForm {
  return level >= FOOT_ROW_STEPS.indexOf('oq') + 1 ? 'count' : max;
}

/** Every box of the row (the buttons, and the status's parts) on one line: their middles within a few pixels. */
export function onOneRow(mids: readonly number[]): boolean {
  return mids.every((mid) => Math.abs(mid - mids[0]!) < 4);
}

function rowMids(row: Element): number[] {
  const parts = [...row.querySelectorAll<HTMLElement>('[data-foot-buttons], [data-foot-status]')].flatMap((group) => sameLineChildren(group));
  return parts
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0)
    .map((r) => r.top + r.height / 2);
}

/** Draws one form on the open questions button, from the counts it carries (`data-oq-n`, `data-oq-actions`, `data-oq-permission`, `data-oq-label`). */
export function drawOpenQuestionsForm(button: HTMLElement, fit: FootFit): void {
  const words = button.querySelector<HTMLElement>('[data-oq-words]');
  const n = Number(button.getAttribute('data-oq-n') ?? '0');
  const actions = Number(button.getAttribute('data-oq-actions') ?? '0');
  const permission = button.hasAttribute('data-oq-permission');
  const skip = button.hasAttribute('data-oq-skipping') ? Number(button.getAttribute('data-oq-skipping') || '0') : null;
  const skipping = skip !== null && skip > 0;
  const answered = button.hasAttribute('data-oq-answered');
  if (words) words.textContent = openQuestionsFormText(n, fit.form, actions, permission, skip, answered);
  button.setAttribute('data-label-form', fit.form);
  button.toggleAttribute('data-fit-tight', fit.tight);
  const label = button.getAttribute('data-oq-label');
  if ((fit.form === 'full' && !skipping && !answered) || !label) button.removeAttribute('aria-label');
  else button.setAttribute('aria-label', label);
}

/**
 * The whole row's fit, from the long form (only a computer's foot has the
 * draft status the row is fitted for: a phone draws none, approval
 * "reply-bar-pairs"). The page is left drawn as the result says. Null as
 * `fitWholeFootRow`.
 */
export function fitWholeFootRowForms(row: HTMLElement): { level: number; max: OpenQuestionsLabelForm } | null {
  const level = fitWholeFootRow(row, 'full');
  return level === null ? null : { level, max: 'full' };
}

/**
 * Tries each level on the page itself (before paint: a layout effect) and
 * leaves the row drawn at the first that keeps it on one line. None does:
 * null, with the row and the button drawn as they were (the status wraps
 * above, and the button fits itself among the buttons). Null too where there
 * is no layout (a test DOM, a hidden pane).
 */
export function fitWholeFootRow(row: HTMLElement, max: OpenQuestionsLabelForm): number | null {
  if (row.getBoundingClientRect().width <= 0) return null;
  const button = row.querySelector<HTMLElement>('[data-foot-buttons] [data-open-questions]');
  const was = {
    fit: row.getAttribute('data-fit'),
    button: button
      ? { form: (button.getAttribute('data-label-form') ?? max) as OpenQuestionsLabelForm, tight: button.hasAttribute('data-fit-tight') }
      : null,
  };
  for (let level = 0; level <= FOOT_ROW_STEPS.length; level++) {
    const tokens = footRowTokens(level);
    if (tokens) row.setAttribute('data-fit', tokens);
    else row.removeAttribute('data-fit');
    if (button) drawOpenQuestionsForm(button, { form: footRowOpenQuestionsForm(level, max), tight: false });
    if (onOneRow(rowMids(row))) return level;
  }
  if (was.fit === null) row.removeAttribute('data-fit');
  else row.setAttribute('data-fit', was.fit);
  if (button && was.button) drawOpenQuestionsForm(button, was.button);
  return null;
}
