/**
 * The Launch tip (approval "launch-tip", 2026-11-08, `.product/approved/launch-tip/`, variant Beside): a one-time card
 * beside compose's To, level with it and pointing at it, that says agents can be started from there. The rules the
 * window keeps; the Inbox keeps who and "seen" (packages/shared/inbox/launch-tip.ts, settings `reveal.launch_tip`, the
 * claim `POST /api/inbox/reveal` `id: "launch_tip"`).
 *
 *  - Only the first plain open of New message (the sidebar's pencil, the list header's, the Drafts page's, the
 *    palette's New message). Never + on a project row, a reopened draft, Message <host>, a Board card's Create thread,
 *    a pull request's Launch an agent, the review box or the tour; none of those uses it up.
 *  - It comes `delayMs` after the box opens, once To has read that it can start an agent (`canStart`), and only while
 *    nothing is in To yet and To was never opened. It shows in the same render the claim is sent (a stamp always means
 *    it was on screen); a refused claim takes it away at once.
 *  - It leaves on Got it, Escape (the first Escape closes only the tip), opening To, Send, or closing the box; on a
 *    phone also when the person taps into Thread or the message, which it covers there. No timer.
 *  - Focus never moves to it; To is described by its line (`aria-describedby`), and compose's polite region says it once.
 */
import type { SettingsModel } from '../api';

export const LAUNCH_TIP_WORDS = {
  eyebrow: 'New',
  title: 'You can now start agents',
  line: 'Choose an agent in To and the folder it works in. A pasted path or git URL works too.',
  ok: 'Got it',
} as const;

/** What a screen reader hears once, through compose's polite region. */
export const LAUNCH_TIP_SAID = `${LAUNCH_TIP_WORDS.eyebrow}: ${LAUNCH_TIP_WORDS.title}. ${LAUNCH_TIP_WORDS.line}`;

/** The card's timings, ms. A test shrinks them (and puts them back). */
export const LAUNCH_TIP_TIMES = {
  /** After the box opens: its 150 ms entrance has settled. */
  delayMs: 450,
  /** The way out (a 120 ms fade), then it is gone from the DOM. */
  leaveMs: 130,
};

/** The card's width (inbox.css `.ib-lt`), and its gaps: 16 px from the box, 12 px from the window's edge. */
export const LAUNCH_TIP_WIDTH = 284;
const BESIDE_GAP = 16;
const EDGE = 12;
/** The arrow's centre, from the card's top, where it stands level with To's centre. */
const ARROW_Y = 26;

/**
 * A plain New message: nothing in the request (no draft, session, card, pull requests, start, review, clone or words).
 * Any field a later opener adds makes it not plain, so a new way in never uses the tip up by accident.
 */
export function launchTipPlainOpen(request: object): boolean {
  return Object.values(request).every((value) => value === undefined || value === null || value === '');
}

/** The Inbox has the tip for this page: the owner's page (never a guest's) on an Inbox that reports it due. */
export function launchTipDue(settings: Pick<SettingsModel, 'guest' | 'reveal'> | null | undefined): boolean {
  return !!settings && settings.guest !== true && settings.reveal?.launch_tip === true;
}

export interface LaunchTipPlace {
  /**
   * `right`: beside the box, arrow pointing left at To. `below`: under To, arrow pointing up at the chip. `above` (a
   * phone, where To is in the foot's row): over that row, arrow pointing down at To.
   */
  side: 'right' | 'below' | 'above';
  /** From the row's top-left (the card is drawn inside the row, `position: absolute`). `above`: its bottom, from the row's bottom. */
  top: number;
  left: number;
  /** The arrow's left, from the card's left (`below` and `above`). */
  arrow: number;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

/**
 * Where the card stands (the tour's rule for compose's To, Tour.tsx `SIDES['compose-to']`: right first, then below;
 * beside the dialog, never over the message being written). Right needs the card's width and its gaps between the box
 * and the window's edge (about 1320 px of window for the 680 px box); else it falls back under To. A phone always
 * stands it over the foot's row, where its To is, edge to edge with 12 px margins.
 */
export function launchTipPlace(input: { phone: boolean; viewportWidth: number; dialog: Box; row: Box; to: Box | null }): LaunchTipPlace {
  const { phone, viewportWidth, dialog, row } = input;
  const to = input.to ?? row;
  if (!phone && viewportWidth - dialog.right >= LAUNCH_TIP_WIDTH + BESIDE_GAP + EDGE) {
    return { side: 'right', left: dialog.right - row.left + BESIDE_GAP, top: Math.round(row.height / 2 - ARROW_Y), arrow: 0 };
  }
  // A phone: To is in the foot's row (`row`), so the card stands over the row and its arrow points down at To.
  if (phone) return { side: 'above', left: EDGE, top: row.height + 8, arrow: Math.max(14, Math.round(to.left - row.left - EDGE + 22)) };
  return { side: 'below', left: Math.round(to.left - row.left - 6), top: row.height + 2, arrow: 24 };
}
