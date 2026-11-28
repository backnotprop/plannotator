/**
 * The list's two signs of news, in one rule (the owner, 2026-11-17):
 *
 *  - The bar, "N new in <project> · Show" (`HeldNoticeLine`), shows while threads wait behind it. It sticks to the
 *    top of the list's scroll box (inbox.css `.ib-notice-stick`), so it is always in reach and never scrolls out of
 *    sight: held news needs no other sign.
 *  - The floating "New" button (`ListNewPill`) shows only after Show, and only for the rows Show brought in that
 *    landed where the reader is not looking (above or below the view). Held news never shows it: before Show there
 *    is nothing on the list to go to.
 *
 * The button counts one side at a time, the side with more rows (a tie is below), and goes once those rows are seen.
 * Nothing here scrolls: the list never moves the reader; only a press of the button does.
 */
import type { ListEdge, UnseenRow } from './showLight';

export interface ListNewInput {
  /** How many threads wait behind the bar (held.ts `heldNotice`'s count); 0 when none. */
  held: number;
  /** The rows the last Show brought in that are not in view yet, each with the side of the view it is on (showLight.ts). */
  unseen: readonly UnseenRow[];
  /** Ids of those rows the reader has already had a sign of (a button that ran its time, when it fades). */
  dismissed?: ReadonlySet<string>;
  /** The list is on screen: no thread covers it and the tab is in front. The button waits while it is not. */
  watching: boolean;
}

export interface ListNewState {
  /** The "N new · Show" bar is drawn (stuck at the list's top). */
  bar: boolean;
  /** The "New" button: how many rows and which way, or null when it is off. */
  button: { count: number; edge: ListEdge } | null;
}

const NONE: ReadonlySet<string> = new Set();

/** The bar shows while any thread is held behind it, wherever the reader is (it sticks). */
export function listBarShows(held: number): boolean {
  return held > 0;
}

export function listNewState({ held, unseen, dismissed = NONE, watching }: ListNewInput): ListNewState {
  const bar = listBarShows(held);
  const rest = watching ? unseen.filter((row) => !dismissed.has(row.id)) : [];
  if (rest.length === 0) return { bar, button: null };
  const below = rest.filter((row) => row.edge === 'bottom').length;
  const edge: ListEdge = below > 0 && below >= rest.length - below ? 'bottom' : 'top';
  return { bar, button: { count: edge === 'bottom' ? below : rest.length - below, edge } };
}
