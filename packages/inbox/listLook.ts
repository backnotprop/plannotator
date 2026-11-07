/**
 * The thread list's look options (approval "inbox-list-options", 2026-10-30): four checkboxes in the list's ⋮
 * menu, under Tidy and Refresh. Smaller thread names is on by default (the owner, 2026-11-05: "I feel like we should
 * make it the default"); every other option is off until someone turns it on.
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
 * and every window open takes a save at once (`event: rows`). A change shows here first, then is saved, one save on
 * its way at a time; the server counts its saves (`rows_rev`), so a page always ends on its newest look. A cookie
 * (`ROWS_COOKIE`) keeps the last look this browser showed, so a reload paints it before the settings read answers.
 * The four per-option cookies of "inbox-list-options" are read, never written: the first window to find no
 * `inboxRows` saves them once (`adoptSavedRows`), and from then on the server's look wins.
 *
 * Until 2026-11-05 every option was off by default. A look kept from then that is exactly those old defaults (every
 * option off: the server's `inboxRows` saved before `inboxRowsDefaults`, this cookie's "none", or no old per-option
 * cookie on) was never a choice, so it is read as today's defaults; any other old look is the person's and stays as
 * it is, smaller names off included. Every option off chosen today is saved as such, and this cookie says "off".
 */
import { useSyncExternalStore } from 'react';
import { INBOX_ROWS_DEFAULT, INBOX_ROWS_OPTIONS, inboxRowsRead, type InboxRowsOption } from '@plannotator/core/inbox-types';
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
  /** Settings → Rows only: Show → Letter marks "Threads" or "Both", a thread's mark from its name (letterMarks.tsx). */
  marksThreads: boolean;
  /** Settings → Rows only: Show → Letter marks "Projects" or "Both", a project's mark (its picture, else its letters). */
  marksProjects: boolean;
  /** Settings → Rows only: Look → Mark style "Inline" (neither this nor `markDot`: "Avatar"). Only while marks show. */
  markInline: boolean;
  /** Settings → Rows only: Look → Mark style "Dot". Only while marks show. */
  markDot: boolean;
  /** Settings → Rows only: Show → Logo from the repo, a favicon or logo found in the project's folder. Only with project marks. */
  repoLogo: boolean;
  /** Settings → Rows only: Show → GitHub pictures, the owner's picture for a project on GitHub. Only with project marks. */
  githubPictures: boolean;
  /**
   * Settings → Rows only: Look → Time position "Under the preview": on three-line and phone rows the time leaves line 1
   * for a line of its own under the preview, at the left, with the row's end (pin, badge, words, counts) at its right.
   * A wide row keeps its columns.
   */
  timeBelow: boolean;
  /** Settings → Rows only: Show → Dividers, a hairline (the theme's border) between rows. Never an outline on a row. */
  dividers: boolean;
  /**
   * Settings → Rows only: Show → Status mark, one mark at the row's end (`StatusMark`, RowStatus.tsx): waiting on you
   * (an open question or action item) or done (Quiet), in place of the action pill and `?N`, whose words are its name
   * and tooltip. Stopped and Holds up keep their triangles.
   */
  statusMark: boolean;
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
  marksThreads: false,
  marksProjects: false,
  markInline: false,
  markDot: false,
  repoLogo: false,
  githubPictures: false,
  timeBelow: false,
  dividers: false,
  statusMark: false,
};

/** The look for someone who chose none (core `INBOX_ROWS_DEFAULT`): smaller thread names on, every other option off. */
export const LIST_LOOK_DEFAULT: ListLook = { ...LIST_LOOK_OFF, ...Object.fromEntries(INBOX_ROWS_DEFAULT.map((key) => [key, true])) };

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

/**
 * The last look this browser showed: the names that are on, with commas, or "off" when none is. Paints a reload;
 * never the truth. "none" is what a build before the new defaults wrote for every option off: today's defaults.
 */
export const ROWS_COOKIE = 'plannotator-inbox-rows';
const ROWS_COOKIE_NONE = 'off';
const ROWS_COOKIE_OLD_DEFAULTS = 'none';

/** The ⋮ menu's checkboxes, in order (no icons, the owner 2026-11-02: "those could all just be check boxes"). */
export const LIST_LOOK_OPTIONS: ReadonlyArray<{ key: MenuLookKey; label: string }> = [
  { key: 'highlight', label: 'Highlight thread subject' },
  { key: 'compact', label: 'Compact rows' },
  { key: 'hideAgents', label: 'Hide agent icons' },
  { key: 'smallNames', label: 'Smaller thread names' },
];

/** The look a list of option names makes: names no build knows are dropped, and a rival pair never both on (core `inboxRowsCanonical`). */
export function lookFromRows(rows: readonly string[]): ListLook {
  const on = inboxRowsRead(rows) ?? [];
  const look = { ...LIST_LOOK_OFF };
  for (const key of on) look[key] = true;
  return look;
}

/**
 * A change on top of a look, with its rivals made to agree: the option just turned on wins (Compact turns Roomy
 * off and Roomy turns Compact off; "2 lines" turns "Hide subject preview" off and back; the Dot needs the smaller
 * names, so it turns them on, and turning them off turns the Dot off).
 */
export function lookWithChange(look: ListLook, change: Partial<ListLook>): ListLook {
  const next = { ...look, ...change };
  if (change.compact) next.roomy = false;
  if (change.roomy) next.compact = false;
  if (change.hidePreview) next.previewTwo = false;
  if (change.previewTwo) next.hidePreview = false;
  if (change.unreadDot) next.smallNames = true;
  if (change.smallNames === false) next.unreadDot = false;
  if (change.markInline) next.markDot = false;
  if (change.markDot) next.markInline = false;
  // A picture switch turned on while no project marks show turns them on (Off becomes Projects, Threads becomes
  // Both), so the switch never does nothing.
  if (change.repoLogo || change.githubPictures) next.marksProjects = true;
  return lookFromRows(rowsFromLook(next));
}

/** Show → Letter marks: which marks draw. */
export type MarksWhat = 'off' | 'threads' | 'projects' | 'both';
/** Look → Mark style: where the mark lives. */
export type MarkStyle = 'inline' | 'avatar' | 'dot';
export interface MarksChoice {
  what: MarksWhat;
  style: MarkStyle;
  /** Logo from the repo (only with project marks). */
  logo: boolean;
  /** GitHub pictures (only with project marks). */
  github: boolean;
}

/** The letter marks a look draws (all off by default; with marks off the style reads Avatar, the first one shown). */
export function lookMarks(look: Pick<ListLook, 'marksThreads' | 'marksProjects' | 'markInline' | 'markDot' | 'repoLogo' | 'githubPictures'>): MarksChoice {
  const what: MarksWhat = look.marksThreads ? (look.marksProjects ? 'both' : 'threads') : look.marksProjects ? 'projects' : 'off';
  const on = what !== 'off';
  const projects = what === 'projects' || what === 'both';
  return {
    what,
    style: on && look.markInline ? 'inline' : on && look.markDot ? 'dot' : 'avatar',
    logo: projects && look.repoLogo,
    github: projects && look.githubPictures,
  };
}

/** Show → Letter marks as the look's options. */
export function marksWhatLook(what: MarksWhat): Pick<ListLook, 'marksThreads' | 'marksProjects'> {
  return { marksThreads: what === 'threads' || what === 'both', marksProjects: what === 'projects' || what === 'both' };
}

/** Look → Mark style as the look's options. Picked while marks are off, it turns thread marks on, so a click never does nothing. */
export function markStyleLook(style: MarkStyle, look: ListLook): Partial<ListLook> {
  const change: Partial<ListLook> = { markInline: style === 'inline', markDot: style === 'dot' };
  if (lookMarks(look).what === 'off') change.marksThreads = true;
  return change;
}

export function rowsFromLook(look: ListLook): InboxRowsOption[] {
  return LIST_LOOK_KEYS.filter((key) => look[key]);
}

/**
 * This browser's look: the last one shown, else the old per-option cookies ("1" is on), else the defaults. The old
 * defaults (the cookie's "none", or no old cookie on) were never a choice: they read as today's defaults.
 */
function readBrowserLook(): ListLook {
  try {
    const shown = storage.getItem(ROWS_COOKIE);
    if (shown === ROWS_COOKIE_OLD_DEFAULTS) return LIST_LOOK_DEFAULT;
    if (shown !== null) return lookFromRows(shown.split(','));
    const look = { ...LIST_LOOK_OFF };
    for (const key of Object.keys(LIST_LOOK_COOKIES) as MenuLookKey[]) look[key] = storage.getItem(LIST_LOOK_COOKIES[key]) === '1';
    return LIST_LOOK_KEYS.some((key) => look[key]) ? look : LIST_LOOK_DEFAULT;
  } catch {
    return LIST_LOOK_DEFAULT;
  }
}

/** Every option at its default (smaller names on, the others off): Settings → Rows' "Balanced". */
export function isDefaultListLook(look: ListLook): boolean {
  return LIST_LOOK_KEYS.every((key) => look[key] === LIST_LOOK_DEFAULT[key]);
}

const sameLook = (a: ListLook, b: ListLook) => LIST_LOOK_KEYS.every((key) => a[key] === b[key]);

let current: ListLook | null = null;
/**
 * The newest look the server has told this page of, and its save count (`rows_rev`). A settings read, a save's
 * answer and `event: rows` each carry the count, so one older than this (an answer that arrives late) is dropped,
 * whatever order they arrive in.
 */
let serverRev = -1;
let serverLook: ListLook | null = null;
/** The last count `event: rows` brought: one stream sends every save once, in order, so the next is above it. */
let eventRev = -1;
/** One save on its way at a time; a change meanwhile waits as `queued` (only the latest one), sent when it answers. */
let inFlight = false;
let queued: ListLook | null = null;
let drained: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

const shown = (): ListLook => (current ??= readBrowserLook());

function show(look: ListLook): void {
  try {
    storage.setItem(ROWS_COOKIE, rowsFromLook(look).join(',') || ROWS_COOKIE_NONE);
  } catch {
    // A page with no cookies still shows the look; a reload only paints the defaults until the settings read.
  }
  if (current && sameLook(current, look)) return;
  current = look;
  for (const listener of listeners) listener();
}

/** The server's look, if newer than the last this page heard: shown at once unless this page has a save to make. */
function hear(rows: readonly InboxRowsOption[], rev: unknown): void {
  const count = typeof rev === 'number' && Number.isFinite(rev) ? rev : Math.max(serverRev, 0);
  if (count < serverRev) return;
  serverRev = count;
  serverLook = lookFromRows(rows);
  if (!inFlight && !queued) show(serverLook);
}

async function sendQueued(): Promise<void> {
  inFlight = true;
  let heard = false;
  while (queued) {
    const look = queued;
    queued = null;
    const before = serverRev;
    try {
      const answer = await inboxApi.saveRows(rowsFromLook(look));
      const rows = inboxRowsRead(answer.rows);
      // A save sent after this page heard count `before` is counted above it, unless the count went back (config.json
      // reset, restored or hand-edited): then this answer is the server's look, and counting starts again from it.
      if (typeof answer.rows_rev === 'number' && answer.rows_rev <= before) serverRev = -1;
      if (rows) hear(rows, answer.rows_rev);
      heard = true;
    } catch {
      // Not saved (offline, an older Inbox): the look stays on this page and in its cookie until the next read,
      // unless another window's save arrived meanwhile.
      heard = serverRev > before;
    }
  }
  inFlight = false;
  // Every save answered: the page shows the server's newest look, whichever window made it.
  if (heard && serverLook) show(serverLook);
}

function save(look: ListLook): Promise<void> {
  queued = look;
  if (!inFlight) drained = sendQueued();
  return drained;
}

/** The look on screen now. */
export function readListLook(): ListLook {
  return shown();
}

/** The person changed some options (a ⋮ checkbox, a Settings → Rows choice or preset): shown at once, then saved. */
export function writeListLookOptions(change: Partial<ListLook>): Promise<void> {
  const next = lookWithChange(shown(), change);
  show(next);
  return save(next);
}

export function writeListLookOption(key: ListLookKey, on: boolean): Promise<void> {
  return writeListLookOptions({ [key]: on });
}

/**
 * The one-time list options dialog's Done (approval "inbox-list-options-intro"): only the options the person changed
 * in it (`look` against `opened`), on top of the look now, so every other keeps whatever it is now, even when another
 * window changed it while the dialog was open (a stale "smaller names off" would turn its Dot off). Nothing changed:
 * nothing saved.
 */
export function writeMenuLook(look: Pick<ListLook, MenuLookKey>, opened: Pick<ListLook, MenuLookKey>): Promise<void> {
  const changed = LIST_LOOK_OPTIONS.filter(({ key }) => look[key] !== opened[key]).map(({ key }) => [key, look[key]]);
  return changed.length ? writeListLookOptions(Object.fromEntries(changed)) : Promise.resolve();
}

/** Taken when a settings read is sent, and given back with its answer (`adoptSavedRows`'s `sentAt`). */
export function listLookReadMark(): number {
  return serverRev;
}

/**
 * The server's look and its save count, from a settings read (`rows`, `rows_rev`) or a save in any window
 * (`event: rows`). Absent (an older Inbox): this browser's stays. Null (never saved): this browser's look (its
 * old cookies) is saved, if it is not the defaults, and the server's wins from then on. That happens once: not
 * while a save from this page is on its way (it is the adoption, or a change that saves the look anyway), and
 * never once the server told this page of a look (a null read sent before it is old). Only a save that failed is
 * offered again by the next read. One older than the newest this page heard is dropped; while this page has a
 * save to make, it is kept and shown once every save answered. A name no build knows is dropped.
 *
 * The count only goes up, unless config.json is reset, restored or hand-edited. A read answers a count at least the
 * one this page had heard when it was sent (`sentAt`, from `listLookReadMark`); one below it means the count went
 * back, so the page takes it and counts again from there. An event cannot tell (`hearRowsEvent`): it asks for a read.
 */
export function adoptSavedRows(rows: unknown, rev?: unknown, sentAt?: number): void {
  if (rows === undefined) return;
  if (typeof rev === 'number' && sentAt !== undefined && rev < sentAt) serverRev = -1;
  adopt(rows, rev);
}

/**
 * Another save, here or in another window (`event: rows`): see `adoptSavedRows`. One at or below the last event's
 * count is never taken: it is the count gone back, or a late copy of an old one (during a leader steal two tabs
 * relay frames, and a rows frame has no seq to tell copies apart, sharedEvents.ts). Only a settings read can tell
 * which, so `onDoubt` asks for one.
 */
export function hearRowsEvent(rows: unknown, rev?: unknown, onDoubt?: () => void): void {
  if (rows === undefined) return;
  if (typeof rev === 'number') {
    if (rev <= eventRev) {
      onDoubt?.();
      return;
    }
    eventRev = rev;
  }
  adopt(rows, rev);
}

function adopt(rows: unknown, rev: unknown): void {
  if (rows === null) {
    if (serverRev >= 0 || inFlight || queued) return;
    const mine = shown();
    if (!isDefaultListLook(mine)) void save(mine);
    return;
  }
  const list = inboxRowsRead(rows);
  if (list) hear(list, rev);
}

/** The list column's classes for the look: none when every option is off. */
export function listLookClasses(look: ListLook): string {
  return `${look.highlight ? ' ib-lk-pill' : ''}${look.compact ? ' ib-lk-compact' : ''}${look.hideAgents ? ' ib-lk-noagents' : ''}${look.smallNames ? ' ib-lk-small' : ''}${look.roomy ? ' ib-lk-roomy' : ''}${look.unreadDot ? ' ib-lk-dot' : ''}${look.previewTwo ? ' ib-lk-pv2' : ''}${look.titleFirst ? ' ib-lk-tfirst' : ''}${look.timeBelow ? ' ib-lk-tbelow' : ''}${look.dividers ? ' ib-lk-div' : ''}${look.statusMark ? ' ib-lk-stm' : ''}`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const defaults = () => LIST_LOOK_DEFAULT;
const ignore = () => () => {};
const noChange = () => {};
const change = (changes: Partial<ListLook>) => void writeListLookOptions(changes);

/**
 * The list's look and a setter for one change or several (a Settings → Rows preset), which every list on screen
 * takes together. `remember` false (the onboarding tour, as its sidebar ignores the person's closed sections):
 * the defaults, nothing read or written.
 */
export function useListLook(remember = true): [ListLook, (changes: Partial<ListLook>) => void] {
  const look = useSyncExternalStore(remember ? subscribe : ignore, remember ? shown : defaults, defaults);
  return [look, remember ? change : noChange];
}

/** Tests only: a fresh page that has read nothing and saves nothing. */
export function resetListLookForTests(): void {
  current = null;
  serverRev = -1;
  serverLook = null;
  eventRev = -1;
  inFlight = false;
  queued = null;
  drained = Promise.resolve();
  for (const listener of listeners) listener();
}
