/**
 * Fitting the thread foot's button row on one line (review of PR #2091).
 *
 * The "N open questions" button takes the longest label that keeps every
 * button of the row on one line: "6 open questions", then "6 open", then
 * "6" (the question icon and the count). A phone never takes the long form.
 * Before a form gives way to a shorter one, the row tries it tightened: the
 * buttons' side padding and the gaps get smaller and the button drops its
 * chevron (`data-fit-tight`, inbox.css), as a phone with Send and Edit draft
 * needs.
 * And on a phone the "↓ N new" pill, laid over the middle of the row, moves
 * above the foot when a button sits under that middle.
 *
 * The rules are pure; `fitFootRow` tries them against the page's own layout.
 */

/** The button's label, longest first. */
export type OpenQuestionsLabelForm = 'full' | 'short' | 'count';

export const OPEN_QUESTIONS_LABEL_FORMS: readonly OpenQuestionsLabelForm[] = ['full', 'short', 'count'];

/** The visible words of each form: "6 open questions" / "6 open" / "6". */
export function openQuestionsFormText(n: number, form: OpenQuestionsLabelForm, noun: 'question' | 'action item' = 'question'): string {
  if (form === 'count') return String(n);
  if (form === 'short') return `${n} open`;
  return `${n} open ${noun}${n === 1 ? '' : 's'}`;
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
 * Tries each way in turn on the page itself (before paint: the caller runs in
 * a layout effect) and leaves the button drawn the first way that keeps the
 * row on one line; none does: the last. `apply` draws one way on the button.
 * Null where there is no layout (a test DOM, a hidden pane).
 */
export function fitFootRow(buttons: HTMLElement, candidates: readonly FootFit[], apply: (fit: FootFit) => void): FootFit | null {
  if (buttons.getBoundingClientRect().width <= 0 || candidates.length === 0) return null;
  for (const fit of candidates) {
    apply(fit);
    if (onOneLine(laidOutChildren(buttons).map((el) => el.getBoundingClientRect().top))) return fit;
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
//   1. skip   the skip chip: "1 question stays open · Skip it" → "1 open · Skip"
//   2. edit   "Edit draft" → "Edit"
//   3. oq     "2 open questions ⌄" → the icon, "2" and the chevron
//   4. draft  the pick words after the Draft pill go; the comment count stays,
//             as a comment glyph and the number inside the pill ("Draft 💬3";
//             with no comments, "Draft" alone)
//   5. tight  the buttons' side padding and the gaps (the status's too) get smaller
//   6. icon   a phone only: "Edit draft" becomes its pencil, the gaps 4 px
// Each step keeps the ones before it. The long words stay in the page as
// visually hidden text (inbox.css), so names and descriptions are whole.

/** One step of shortening; a level is the first N of them. */
export type FootRowStep = 'keys' | 'skip' | 'edit' | 'oq' | 'draft' | 'tight' | 'icon';

/** The steps every window takes. */
export const FOOT_ROW_STEPS: readonly FootRowStep[] = ['keys', 'skip', 'edit', 'oq', 'draft', 'tight'];

/** A phone's steps: the same, then Edit draft as its pencil. */
export const PHONE_FOOT_ROW_STEPS: readonly FootRowStep[] = [...FOOT_ROW_STEPS, 'icon'];

export function footRowSteps(phone = false): readonly FootRowStep[] {
  return phone ? PHONE_FOOT_ROW_STEPS : FOOT_ROW_STEPS;
}

/** The row's `data-fit` at a level: the steps taken, space-separated ("" at level 0). */
export function footRowTokens(level: number, phone = false): string {
  return footRowSteps(phone).slice(0, Math.max(0, level)).join(' ');
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
  const parts = [...row.querySelectorAll<HTMLElement>('[data-foot-buttons], [data-foot-status]')].flatMap((group) => laidOutChildren(group));
  return parts
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0)
    .map((r) => r.top + r.height / 2);
}

/** Draws one form on the open questions button, from the counts it carries (`data-oq-n`, `data-oq-noun`, `data-oq-label`). */
export function drawOpenQuestionsForm(button: HTMLElement, fit: FootFit): void {
  const words = button.querySelector<HTMLElement>('[data-oq-words]');
  const n = Number(button.getAttribute('data-oq-n') ?? '0');
  const noun = button.getAttribute('data-oq-noun') === 'action item' ? 'action item' : 'question';
  if (words) words.textContent = openQuestionsFormText(n, fit.form, noun);
  button.setAttribute('data-label-form', fit.form);
  button.toggleAttribute('data-fit-tight', fit.tight);
  const label = button.getAttribute('data-oq-label');
  if (fit.form === 'full' || !label) button.removeAttribute('aria-label');
  else button.setAttribute('aria-label', label);
}

/**
 * Tries each level on the page itself (before paint: a layout effect) and
 * leaves the row drawn at the first that keeps it on one line. None does:
 * null, with the row and the button drawn as they were (the status wraps
 * above, and the button fits itself among the buttons). Null too where there
 * is no layout (a test DOM, a hidden pane).
 */
export function fitWholeFootRow(row: HTMLElement, max: OpenQuestionsLabelForm, phone = false): number | null {
  if (row.getBoundingClientRect().width <= 0) return null;
  const button = row.querySelector<HTMLElement>('[data-foot-buttons] [data-open-questions]');
  const was = {
    fit: row.getAttribute('data-fit'),
    button: button
      ? { form: (button.getAttribute('data-label-form') ?? max) as OpenQuestionsLabelForm, tight: button.hasAttribute('data-fit-tight') }
      : null,
  };
  const steps = footRowSteps(phone);
  for (let level = 0; level <= steps.length; level++) {
    const tokens = footRowTokens(level, phone);
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
