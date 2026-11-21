/**
 * Fitting a phone's thread header on one line (the owner, 2026-10-29: "Mobile
 * thread header needs to be better responsive"; his iPhone showed "‹ I…" and a
 * sliver of the scrolled-away subject), with room for the subject (approval
 * "inbox-thread-header", 2026-11-02: the bar is ‹ Inbox, the subject,
 * Artifacts, Expand, ⋯; the read button and Snooze moved into ⋯, and their
 * room is the subject's).
 *
 * The header's icons keep their 44 px. When the row is short it gives way in
 * this order, trying each way in turn and keeping the first that fits:
 *   tight  the way back's end padding gets smaller
 *   count  the Artifacts count leaves the button ("Artifacts, 11" stays its name)
 *   back   the way back shows its chevron alone ("Back to Inbox" stays its name)
 * A way fits when nothing is past the edge, the way back's label shows whole
 * or at least its floor, and the subject has room to be read (`SUBJECT_FLOOR`).
 * The way back's label is never cut short of its floor: "Inbox" shows whole or
 * not at all; a long project name may end in "…" once it shows `BACK_LABEL_FLOOR`.
 * When even the last way leaves the subject less than its floor, the subject is
 * not drawn (a sliver of it reads as a stray glyph), and the first way that fits
 * without it is drawn, so "Inbox" does not go for nothing.
 *
 * The rules are pure; `fitPhoneHead` tries them against the page's own layout
 * (before paint: the caller runs in a layout effect), as footFit.ts does for the foot.
 *
 * A PR's pane on a phone (pulls/PullLaunchpad.tsx, PullsPage's stack page) leads its bar with the same way back
 * (`‹ Reviews`) and gives way by the same rules (`usePhoneHeadFit`): its subject is the PR's number and repository
 * (`[data-fit-subject]`, which names its own least room: the number and a readable piece of the repository).
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** One way the header gives way. */
export type PhoneHeadStep = 'tight' | 'count' | 'back';

/**
 * The ways to try, best first, as the header's `data-fit` tokens: the count
 * goes before the way back's label, which goes last.
 */
export const PHONE_HEAD_FITS: readonly (readonly PhoneHeadStep[])[] = [[], ['tight'], ['tight', 'count'], ['tight', 'count', 'back']];

/** The least of a long way-back label (a project's name) shown before it goes: about six letters at 16 px. */
export const BACK_LABEL_FLOOR = 56;

/** The least room (the subject's box, its 4 px sides included) the subject is drawn in. */
export const SUBJECT_FLOOR = 88;

/**
 * What one try measured: how far the last control ends past the row's edge, the way back's label (null: none
 * drawn), and the subject's width (null: the bar has no subject, as over a phone's Artifacts screen).
 */
export interface PhoneHeadMeasure {
  overflow: number;
  label: { shown: number; whole: number } | null;
  subject?: number | null;
  /** The subject's own least room (`data-fit-subject="160"`); else `SUBJECT_FLOOR`. */
  subjectFloor?: number;
}

/** Fits: nothing past the edge, the label shown whole or at least its floor, and the subject with room to be read. */
export function phoneHeadFits({ overflow, label, subject = null, subjectFloor }: PhoneHeadMeasure): boolean {
  if (overflow > 0.5) return false;
  if (subject !== null && !subjectHasRoom(subject, subjectFloor)) return false;
  if (label === null) return true;
  return label.shown >= Math.min(label.whole, BACK_LABEL_FLOOR) - 0.5;
}

/** Whether the subject has room to be read. */
export function subjectHasRoom(width: number, floor: number = SUBJECT_FLOOR): boolean {
  return width >= floor - 0.5;
}

/** A subject's own least room (`data-fit-subject="160"`), else `SUBJECT_FLOOR`. */
function floorOf(subject: HTMLElement | null): number {
  const own = Number(subject?.getAttribute('data-fit-subject'));
  return own > 0 ? own : SUBJECT_FLOOR;
}

// ── DOM ──

/** The header's subject: a thread's (`.ib-phsubj`), or another bar's that gives way the same (`[data-fit-subject]`). */
const SUBJECT = '.ib-phsubj, [data-fit-subject]';

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
  const subject = head.querySelector<HTMLElement>(SUBJECT);
  return {
    overflow: right - end,
    label: drawn ? { shown: label.clientWidth, whole: label.scrollWidth } : null,
    subject: subject ? subject.getBoundingClientRect().width : null,
    subjectFloor: floorOf(subject),
  };
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
  head.removeAttribute('data-subject-off');
  const tryEach = (withSubject: boolean) =>
    PHONE_HEAD_FITS.find((candidate) => {
      draw(head, candidate);
      const measured = measure(head);
      return phoneHeadFits(withSubject ? measured : { ...measured, subject: null });
    });
  // No way leaves the subject room: it is not drawn, and the controls keep the most they can ("Inbox" whole).
  const fit = tryEach(true) ?? tryEach(false) ?? PHONE_HEAD_FITS[PHONE_HEAD_FITS.length - 1]!;
  draw(head, fit);
  const subject = head.querySelector<HTMLElement>(SUBJECT);
  head.toggleAttribute('data-subject-off', subject !== null && !subjectHasRoom(subject.getBoundingClientRect().width, floorOf(subject)));
  return fit;
}

/** Back to the header's own drawing (a desktop, a stacked window): no step taken, the subject drawn. */
export function clearPhoneHead(head: HTMLElement): void {
  head.removeAttribute('data-fit');
  head.removeAttribute('data-subject-off');
}

/**
 * A bar fitted as a phone's thread header is (components/Thread.tsx): on a phone it gives way by `fitPhoneHead`
 * whenever its width or `sig` (what it draws) changes, and once the real font has loaded; off a phone it is drawn
 * as it is. For bars outside a thread (a PR's pane), which draw the same `‹` way back.
 */
export function usePhoneHeadFit(ref: RefObject<HTMLElement | null>, phone: boolean, sig: string): void {
  const fittedFor = useRef('');
  const fit = useRef<(force?: boolean) => void>(() => {});
  fit.current = (force = false) => {
    const head = ref.current;
    if (!head) return;
    const key = `${head.getBoundingClientRect().width}|${phone}|${sig}`;
    if (!force && key === fittedFor.current) return;
    fittedFor.current = key;
    if (phone) fitPhoneHead(head);
    else clearPhoneHead(head);
  };
  useLayoutEffect(() => fit.current());
  useEffect(() => {
    const head = ref.current;
    if (!head || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fit.current());
    observer.observe(head);
    // Words measured in a fallback font fit differently once the real one loads.
    void document.fonts?.ready.then(() => fit.current(true));
    return () => observer.disconnect();
  }, [ref]);
}
