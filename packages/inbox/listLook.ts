/**
 * The thread list's look options (approval "inbox-list-options", 2026-10-30): four checkboxes in the list's ⋮
 * menu, under Tidy and Refresh. All are off by default, so the list is today's until someone turns one on.
 *
 * - Highlight thread subject: the row's title sits in the thread chip's grey pill (`.ib-key`), cut to one line.
 * - Compact rows: two lines instead of three (agents, project, title and time; then the preview).
 * - Hide agent icons: no agents' marks on any row (a screen reader still hears who).
 * - Smaller thread names (the owner, 2026-10-31): an unread row's name at the read size (13.5 px beside a thread,
 *   14 px on a phone), still bold, instead of the bigger unread size of "inbox-row-unread-bigger".
 *
 * Settings → Rows (approval "inbox-customize-rows", 2026-11-02) adds seven more, with presets and live previews.
 *
 * The look is the person's, wherever they use the Inbox (the owner, 2026-11-02: "Whatever they set goes wherever
 * they're using the app. That's the point."): config.json `inboxRows` through POST /api/inbox/settings `{ rows }`,
 * and every window open takes a save at once (`event: rows`). A change shows here first, then is saved. A cookie
 * (`ROWS_COOKIE`) keeps the last look this browser showed, so a reload paints it before the settings read answers.
 * The four per-option cookies of "inbox-list-options" are read, never written: the first window to find no
 * `inboxRows` saves them once (`adoptSavedRows`), and from then on the server's look wins.
 */
import { useSyncExternalStore } from 'react';
import { INBOX_ROWS_OPTIONS, inboxRowsList, type InboxRowsOption } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { inboxApi } from './api';

export interface ListLook {
  highlight: boolean;
  compact: boolean;
  hideAgents: boolean;
  smallNames: boolean;
  /** Settings → Rows only (no ⋮ item): no project (nor its machine) on any row; a wide row takes one project's columns. */
  hideProject: boolean;
  /** Settings → Rows only (no ⋮ item): no grey subject line under a named thread. */
  hidePreview: boolean;
  /** Settings → Rows only: Density "Roomy", more room around every row (never with `compact`). */
  roomy: boolean;
  /** Settings → Rows only: Unread "Dot", an accent dot before an unread row (with `smallNames`: the name at the read size, bold). */
  unreadDot: boolean;
  /** Settings → Rows only: Subject preview "2 lines", beside a thread and on a phone (a wide row is one line). Never with `hidePreview`. */
  previewTwo: boolean;
  /** Settings → Rows only: Time "Relative", "4m", "3h", "2d", then the date (relativeTime.ts). */
  relativeTime: boolean;
  /** Settings → Rows only: First line "Thread name": the name and the time on line 1, the agents and project under it (three-line and phone rows). */
  titleFirst: boolean;
}

export type ListLookKey = keyof ListLook;
// The server's option names (core `INBOX_ROWS_OPTIONS`) are exactly these keys: a new option is added to both.
const SAME_KEYS: [ListLookKey] extends [InboxRowsOption] ? ([InboxRowsOption] extends [ListLookKey] ? true : never) : never = true;
void SAME_KEYS;

export const LIST_LOOK_OFF: ListLook = {
  highlight: false,
  compact: false,
  hideAgents: false,
  smallNames: false,
  hideProject: false,
  hidePreview: false,
  roomy: false,
  unreadDot: false,
  previewTwo: false,
  relativeTime: false,
  titleFirst: false,
};

/** Every option: the ⋮ menu's four, then Settings → Rows' others. */
export const LIST_LOOK_KEYS: readonly ListLookKey[] = INBOX_ROWS_OPTIONS;

/** The ⋮ menu's four. */
export type MenuLookKey = 'highlight' | 'compact' | 'hideAgents' | 'smallNames';

/** The menu's options' cookies before the look was synced ("inbox-list-options"): read for the one adoption, never written. */
export const LIST_LOOK_COOKIES: Readonly<Record<MenuLookKey, string>> = {
  highlight: 'plannotator-inbox-list-highlight',
  compact: 'plannotator-inbox-list-compact',
  hideAgents: 'plannotator-inbox-list-hide-agents',
  smallNames: 'plannotator-inbox-list-small-names',
};

/** The last look this browser showed: the names that are on, with commas, or "none". Paints a reload; never the truth. */
export const ROWS_COOKIE = 'plannotator-inbox-rows';

/** The ⋮ menu's checkboxes, in order (no icons, the owner 2026-11-02: "those could all just be check boxes"). */
export const LIST_LOOK_OPTIONS: ReadonlyArray<{ key: MenuLookKey; label: string }> = [
  { key: 'highlight', label: 'Highlight thread subject' },
  { key: 'compact', label: 'Compact rows' },
  { key: 'hideAgents', label: 'Hide agent icons' },
  { key: 'smallNames', label: 'Smaller thread names' },
];

export function lookFromRows(rows: readonly string[]): ListLook {
  const look = { ...LIST_LOOK_OFF };
  for (const key of LIST_LOOK_KEYS) look[key] = rows.includes(key);
  return look;
}

export function rowsFromLook(look: ListLook): InboxRowsOption[] {
  return LIST_LOOK_KEYS.filter((key) => look[key]);
}

/** This browser's look: the last one shown, else the old per-option cookies ("1" is on), else every option off. */
function readBrowserLook(): ListLook {
  try {
    const shown = storage.getItem(ROWS_COOKIE);
    if (shown !== null) return lookFromRows(shown.split(','));
    const look = { ...LIST_LOOK_OFF };
    for (const key of Object.keys(LIST_LOOK_COOKIES) as MenuLookKey[]) look[key] = storage.getItem(LIST_LOOK_COOKIES[key]) === '1';
    return look;
  } catch {
    return LIST_LOOK_OFF;
  }
}

/** Every option at its default (all off): Settings → Rows' "Balanced". */
export function isDefaultListLook(look: ListLook): boolean {
  return LIST_LOOK_KEYS.every((key) => !look[key]);
}

const sameLook = (a: ListLook, b: ListLook) => LIST_LOOK_KEYS.every((key) => a[key] === b[key]);

let current: ListLook | null = null;
/** Saves on their way: a settings read or `event: rows` meanwhile may predate them, so it is not taken. */
let saving = 0;
/** This page already offered the server its browser's look (the one adoption). */
let offered = false;
const listeners = new Set<() => void>();

const shown = (): ListLook => (current ??= readBrowserLook());

function show(look: ListLook): void {
  try {
    storage.setItem(ROWS_COOKIE, rowsFromLook(look).join(',') || 'none');
  } catch {
    // A page with no cookies still shows the look; a reload only paints the defaults until the settings read.
  }
  if (current && sameLook(current, look)) return;
  current = look;
  for (const listener of listeners) listener();
}

function save(look: ListLook): Promise<void> {
  saving += 1;
  return inboxApi.saveRows(rowsFromLook(look)).then(
    (answer) => {
      saving -= 1;
      // The last save's answer is the server's look: a window that changed it meanwhile wins, as its event would.
      const rows = inboxRowsList(answer.rows);
      if (saving === 0 && rows) show(lookFromRows(rows));
    },
    () => {
      // Not saved (offline, an older Inbox): the look stays on this page and in its cookie until the next read.
      saving -= 1;
    },
  );
}

/** The look on screen now. */
export function readListLook(): ListLook {
  return shown();
}

/** The person changed some options (a ⋮ checkbox, a Settings → Rows choice or preset): shown at once, then saved. */
export function writeListLookOptions(changes: Partial<ListLook>): Promise<void> {
  const next = { ...shown(), ...changes };
  show(next);
  return save(next);
}

export function writeListLookOption(key: ListLookKey, on: boolean): Promise<void> {
  return writeListLookOptions({ [key]: on });
}

/** The whole look at once (the one-time list options dialog's Done, approval "inbox-list-options-intro"). */
export function writeListLook(look: ListLook): Promise<void> {
  return writeListLookOptions(look);
}

/**
 * The server's look, from a settings read (`rows`) or another window's save (`event: rows`). Absent (an older
 * Inbox): this browser's stays. Null (never saved): this browser's old look is saved once, if it is not the
 * defaults, and the server's wins from then on. Ignored while a save from this page is on its way.
 */
export function adoptSavedRows(rows: unknown): void {
  if (rows === undefined || saving > 0) return;
  if (rows === null) {
    if (offered) return;
    offered = true;
    const mine = shown();
    if (!isDefaultListLook(mine)) void save(mine);
    return;
  }
  const list = inboxRowsList(rows);
  if (list) show(lookFromRows(list));
}

/** The list column's classes for the look: none when every option is off. */
export function listLookClasses(look: ListLook): string {
  return `${look.highlight ? ' ib-lk-pill' : ''}${look.compact ? ' ib-lk-compact' : ''}${look.hideAgents ? ' ib-lk-noagents' : ''}${look.smallNames ? ' ib-lk-small' : ''}${look.roomy ? ' ib-lk-roomy' : ''}${look.unreadDot ? ' ib-lk-dot' : ''}${look.previewTwo ? ' ib-lk-pv2' : ''}${look.titleFirst ? ' ib-lk-tfirst' : ''}`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const off = () => LIST_LOOK_OFF;
const ignore = () => () => {};
const noChange = () => {};
const change = (changes: Partial<ListLook>) => void writeListLookOptions(changes);

/**
 * The list's look and a setter for one change or several (a Settings → Rows preset), which every list on screen
 * takes together. `remember` false (the onboarding tour, as its sidebar ignores the person's closed sections):
 * every option off, nothing read or written.
 */
export function useListLook(remember = true): [ListLook, (changes: Partial<ListLook>) => void] {
  const look = useSyncExternalStore(remember ? subscribe : ignore, remember ? shown : off, off);
  return [look, remember ? change : noChange];
}

/** Tests only: a fresh page that has read nothing and saves nothing. */
export function resetListLookForTests(): void {
  current = null;
  saving = 0;
  offered = false;
  for (const listener of listeners) listener();
}
