/**
 * The one-time list options dialog (approval "inbox-list-options-intro", 2026-10-31): when a load may ask the Inbox
 * for it, and the short preview it plays as it opens.
 *
 * The Inbox decides who gets it (packages/server/inbox.ts `inboxListIntro`): someone who used an Inbox before, once
 * per machine. The page decides when: never on the same load as another one-time dialog or the tour, only once the
 * Inbox page (the list, or a thread open on it: `listIntroPageClear`) has been settled for a moment, only with a list
 * of three rows or more, and never over a search, a new message, a reply being typed or another dialog. A page that
 * may show it claims it (POST /api/inbox/list-intro); only the first claim ever gets `show: true`.
 */
import type { ListLookKey } from './listLook';

/** A list shorter than this has too little to show the options on: the dialog waits for a later load. */
export const LIST_INTRO_MIN_ROWS = 3;

/**
 * How long the Inbox page stays settled (`listIntroPageClear` without a break) before the dialog may open, ms. About
 * the wait a first load has anyway (this load's other one-time dialogs settle after the agents' second read), so it
 * never opens the moment the page shows, and a person who comes back from Settings or the Board sees it after the
 * same short delay.
 */
export const LIST_INTRO_SETTLED_MS = 2500;

/**
 * Whether the person is on the Inbox page with nothing over it: the list, with or without a thread open (a thread
 * from a notification, an agent's link or a reload counts, on a phone and a desktop alike: the owner's note, "it
 * should show if I have a thread open"), and no search or new message over it. Settings, the Board, What's new,
 * Drafts and the tour are other pages: never there.
 */
export function listIntroPageClear(route: { page: string }, over: { search: boolean; compose: boolean }): boolean {
  return route.page === 'inbox' && !over.search && !over.compose;
}

/** What one load knows when it decides. */
export interface ListIntroLoad {
  /** The Inbox has it due (settings `list_intro.due`). */
  due: boolean;
  /** The page is on this computer (a page through the tailnet never claims it). */
  local: boolean;
  /** The list has loaded. */
  listLoaded: boolean;
  /** First run: no projects yet. */
  firstRun: boolean;
  /** Threads in the list (every group). */
  rows: number;
  /** The Inbox page has been clear (`listIntroPageClear`) for `LIST_INTRO_SETTLED_MS` without a break. */
  settled: boolean;
  /** The tour was on screen at some point in this load. */
  tourThisLoad: boolean;
  /** The sound or the agent-note dialog showed in this load. */
  otherDialogThisLoad: boolean;
  /** The sound claim and the agent-note decision of this load are both settled. */
  othersSettled: boolean;
  /** An update dialog or a restart is on screen. */
  updating: boolean;
}

/**
 * Whether this load wants the dialog at all: false settles it for the load (the notification lines need not wait for
 * it). True: it is asked for as soon as `listIntroMayAsk` says so.
 */
export function listIntroWanted(load: ListIntroLoad): boolean {
  return load.due && load.local && load.listLoaded && !load.firstRun && load.rows >= LIST_INTRO_MIN_ROWS && !load.tourThisLoad && !load.otherDialogThisLoad;
}

/**
 * Whether the page may ask for it now: wanted, with the Inbox page settled for a moment (a thread open or not), after
 * this load's other one-time dialogs are decided, with no update dialog, no other dialog open (`modal`) and no reply
 * being typed (`replying`). Anywhere else the claim waits, unspent, for the Inbox page.
 */
export function listIntroMayAsk(load: ListIntroLoad, now: { modal: boolean; replying: boolean }): boolean {
  return listIntroWanted(load) && load.settled && load.othersSettled && !load.updating && !now.modal && !now.replying;
}

/**
 * The preview as the dialog opens (the owner's r4): the switches turn on one at a time, 500 ms apart, then after a
 * 700 ms hold all off together, back to the defaults. `at` is ms after the dialog opens; `key` null is "all off". Not
 * under reduced motion. Smaller thread names (the fourth option) joined it last, so the end moved from 2000 ms.
 */
export const LIST_INTRO_PREVIEW: readonly { at: number; key: ListLookKey | null }[] = [
  { at: 300, key: 'highlight' },
  { at: 800, key: 'compact' },
  { at: 1300, key: 'hideAgents' },
  { at: 1800, key: 'smallNames' },
  { at: 2500, key: null },
];

/** The rows' crossfade on each change of look, ms (none under reduced motion). */
export const LIST_INTRO_SWAP_MS = 150;
