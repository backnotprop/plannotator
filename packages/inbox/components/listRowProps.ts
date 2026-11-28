/**
 * A list row's props (InboxList.tsx `ListRow`) and when two of them draw the same row: every list read brings new row
 * objects, so a row is compared by its content, and every other prop by identity (the callbacks keep one for the
 * list's life). A prop the comparison leaves out never redraws the row: each one a row draws from is listed here.
 */
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import { sameTint, type RowTintFields } from '../parts/RowTint';

export interface ListRowProps extends RowTintFields {
  row: InboxListRow;
  /** The row's project as the window names it (`windowProjectNames`; another machine's carries that machine's name). */
  project: string;
  /** Its machine is away (asleep, or needing an update): the row is greyed, its thread opens when the machine is back. */
  away: boolean;
  /** The group the row sits in on screen. */
  drawn: InboxListGroupId;
  /** `line`, `phone-line`: the Agents view's one-line row (agentsView/LineRow.tsx), on a wider window or a phone. */
  shape: 'wide' | 'narrow' | 'phone' | 'line' | 'phone-line';
  /** A wide row in a list at least FULL_WORDS_MIN_LIST_WIDTH wide: the full words and the badge's words. */
  full: boolean;
  filtered: boolean;
  selected: boolean;
  lit: boolean;
  onOpen: (row: InboxListRow) => void;
  onMarkRead?: (row: InboxListRow) => void;
  onMarkUnread?: (row: InboxListRow) => void;
  onSendNow?: (row: InboxListRow) => void;
  onUnstar?: (row: InboxListRow) => void;
  /** A row of the Archived group: its hover action is Unarchive, and no other. */
  onUnarchive?: (row: InboxListRow) => void;
  /** Today's date: the row's time is written against it (shortTime). */
  day: string;
  /** Its right-click menu is open (RowMenu.tsx): the muted background. */
  menu: boolean;
  /** Pinned to the sidebar: a small pin on the row's right (`PinMark`). */
  pinned: boolean;
  /** A wide row in a list that has a pinned row: every row draws the pin's column, so the columns line up. */
  pinColumn: boolean;
  /** `aria-keyshortcuts` for the row's menu (Shift+F10), when the list has one. */
  keys?: string;
  /** "Highlight thread subject" (listLook.ts): the title in its pill. */
  pill: boolean;
  /** "Compact rows" (listLook.ts): a three-line or phone row's title on line 1. */
  compact: boolean;
  /** Settings → Rows' "Grey line under the name" None (listLook.ts `hidePreview`): no grey preview on the row. */
  noPreview?: boolean;
  /** Settings → Rows' Time "Relative" (listLook.ts `relativeTime`). */
  relative?: boolean;
  /** Settings → Rows' First line "Thread name" (listLook.ts `titleFirst`): three-line and phone rows. */
  titleFirst?: boolean;
  /** Settings → Rows' Time position "Under the preview" (listLook.ts `timeBelow`): three-line and phone rows. */
  timeBelow?: boolean;
  /** Settings → Rows' Show → Status mark (listLook.ts `statusMark`): every shape. */
  statusMark?: boolean;
  /** Settings → Rows' Show → Agent icons off (listLook.ts `hideAgents`); the list column's class hides the tiles. */
  noAgents?: boolean;
  /** Settings → Rows' Pull requests off (listLook.ts `hidePulls`): no PR mark at the row's end. */
  noPulls?: boolean;
  /** The list is picking rows (rowPicks.ts): a box on every row, and a click picks. */
  picking?: boolean;
  /** Picked: filled, `aria-pressed`. */
  picked?: boolean;
  /** A press on the row's box (Shift picks a range). */
  onPick?: (row: InboxListRow, event: ReactMouseEvent) => void;
}

/** `memo`'s comparison for ListRow: true when the row would draw the same. */
export function sameListRow(a: ListRowProps, b: ListRowProps): boolean {
  return (
    a.shape === b.shape &&
    a.project === b.project &&
    a.away === b.away &&
    a.full === b.full &&
    a.drawn === b.drawn &&
    a.filtered === b.filtered &&
    a.selected === b.selected &&
    a.lit === b.lit &&
    a.day === b.day &&
    a.menu === b.menu &&
    a.pinned === b.pinned &&
    a.pinColumn === b.pinColumn &&
    a.keys === b.keys &&
    a.pill === b.pill &&
    a.compact === b.compact &&
    a.noPreview === b.noPreview &&
    a.relative === b.relative &&
    a.titleFirst === b.titleFirst &&
    a.timeBelow === b.timeBelow &&
    a.statusMark === b.statusMark &&
    a.noAgents === b.noAgents &&
    a.noPulls === b.noPulls &&
    sameTint(a, b) &&
    a.picking === b.picking &&
    a.picked === b.picked &&
    a.onPick === b.onPick &&
    a.onOpen === b.onOpen &&
    a.onMarkRead === b.onMarkRead &&
    a.onMarkUnread === b.onMarkUnread &&
    a.onSendNow === b.onSendNow &&
    a.onUnstar === b.onUnstar &&
    a.onUnarchive === b.onUnarchive &&
    sameValue(a.row, b.row)
  );
}

/** Deep equality over JSON-shaped values (a list row). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}
