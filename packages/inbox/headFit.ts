/**
 * Fitting a phone's thread header on one line (the owner, 2026-10-29: "Mobile
 * thread header needs to be better responsive"; his iPhone showed "‹ I…" and a
 * sliver of the scrolled-away subject).
 *
 * The header's icons keep their 44 px. When the row is short it gives way in
 * this order, trying each way in turn and keeping the first that fits:
 *   tight  Mark read's side padding and margins, and the way back's end padding, get smaller
 *   count  the Artifacts count leaves the button ("Artifacts, 11" stays its name)
 *   mark   Mark read shows its icon alone (its words stay as visually hidden text);
 *          the count comes back when that leaves room for it
 *   back   the way back shows its chevron alone ("Back to Inbox" stays its name)
 * The way back's label is never cut short of its floor: "Inbox" shows whole or
 * not at all; a long project name may end in "…" once it shows `BACK_LABEL_FLOOR`.
 * The subject that moves into the header once it scrolls away is drawn only
 * with room for `SUBJECT_FLOOR`: it never takes a step's room, and a sliver of
 * it reads as a stray glyph.
 *
 * The rules are pure; `fitPhoneHead` tries them against the page's own layout
 * (before paint: the caller runs in a layout effect), as footFit.ts does for the foot.
 */

/** One way the header gives way. */
export type PhoneHeadStep = 'tight' | 'count' | 'mark' | 'back';

/**
 * The ways to try, best first, as the header's `data-fit` tokens. Mark read's
 * words outrank the Artifacts count (the count goes first), the count comes
 * back once Mark read's words have gone if it fits, and the way back's label goes last.
 */
export const PHONE_HEAD_FITS: readonly (readonly PhoneHeadStep[])[] = [
  [],
  ['tight'],
  ['tight', 'count'],
  ['tight', 'mark'],
  ['tight', 'count', 'mark'],
  ['tight', 'count', 'mark', 'back'],
];

/** The least of a long way-back label (a project's name) shown before it goes: about six letters at 16 px. */
export const BACK_LABEL_FLOOR = 56;

/** The least room (the subject's box, its 4 px sides included) the scrolled-away subject is drawn in. */
export const SUBJECT_FLOOR = 88;

/** What one try measured: how far the last control ends past the row's edge, and the way back's label (null: none drawn). */
export interface PhoneHeadMeasure {
  overflow: number;
  label: { shown: number; whole: number } | null;
}

/** Fits: nothing past the edge, and the label shown whole, or at least its floor when it is longer than that. */
export function phoneHeadFits({ overflow, label }: PhoneHeadMeasure): boolean {
  if (overflow > 0.5) return false;
  if (label === null) return true;
  return label.shown >= Math.min(label.whole, BACK_LABEL_FLOOR) - 0.5;
}

/** Whether the scrolled-away subject has room to be read. */
export function subjectHasRoom(width: number): boolean {
  return width >= SUBJECT_FLOOR;
}

// ── DOM ──

function measure(head: HTMLElement): PhoneHeadMeasure {
  const box = head.getBoundingClientRect();
  const end = box.right - (parseFloat(getComputedStyle(head).paddingRight) || 0);
  let right = box.left;
  for (const child of head.children) {
    const r = child.getBoundingClientRect();
    if (r.width > 0) right = Math.max(right, r.right);
  }
  const label = head.querySelector<HTMLElement>('.ib-pback-l');
  const drawn = label !== null && label.getBoundingClientRect().width > 1;
  return { overflow: right - end, label: drawn ? { shown: label.clientWidth, whole: label.scrollWidth } : null };
}

function draw(head: HTMLElement, fit: readonly PhoneHeadStep[]): void {
  if (fit.length > 0) head.setAttribute('data-fit', fit.join(' '));
  else head.removeAttribute('data-fit');
}

/**
 * Tries each way on the header itself and leaves it drawn the first way that
 * fits (none does: the last), then hides the subject when it has no room to be
 * read. Returns the way drawn; null where there is no layout (a test DOM, a hidden pane).
 */
export function fitPhoneHead(head: HTMLElement): readonly PhoneHeadStep[] | null {
  if (head.getBoundingClientRect().width <= 0) return null;
  const fit = PHONE_HEAD_FITS.find((candidate) => {
    draw(head, candidate);
    return phoneHeadFits(measure(head));
  }) ?? PHONE_HEAD_FITS[PHONE_HEAD_FITS.length - 1]!;
  draw(head, fit);
  const subject = head.querySelector<HTMLElement>('.ib-phsubj');
  head.toggleAttribute('data-subject-off', subject !== null && !subjectHasRoom(subject.getBoundingClientRect().width));
  return fit;
}

/** Back to the header's own drawing (a desktop, a stacked window): no step taken, the subject drawn. */
export function clearPhoneHead(head: HTMLElement): void {
  head.removeAttribute('data-fit');
  head.removeAttribute('data-subject-off');
}
