/**
 * The one-time "Choose how your list looks" dialog (approval "inbox-rows-dialog", round 7b; it replaced the switches
 * of "inbox-list-options-intro"): when a load may ask the Inbox for it, and the short demo it plays as it opens.
 *
 * The Inbox decides who gets it (packages/server/inbox-list-intro.ts): everyone once per version and machine, fresh
 * installs too. The page decides when: never on the same load as another one-time dialog or the tour, only once the
 * Inbox page (the list, or a thread open on it: `listIntroPageClear`) has been settled for a moment, only with a list
 * of five threads or more (q-2c590791: a decent, growing list), and never over a file, document, guided review or
 * Artifacts view, a search, a new message, a reply being typed or another dialog. A page that may show it claims it
 * (POST /api/inbox/list-intro); only the first claim ever gets `show: true`.
 */
/** A list shorter than this is not yet the decent, growing list the dialog is for: it waits for a later load. */
export const LIST_INTRO_MIN_ROWS = 5;

/**
 * How long the Inbox page stays settled (`listIntroPageClear` without a break) before the dialog may open, ms. About
 * the wait a first load has anyway (this load's other one-time dialogs settle after the agents' second read), so it
 * never opens the moment the page shows, and a person who comes back from Settings or the Board sees it after the
 * same short delay.
 */
export const LIST_INTRO_SETTLED_MS = 2500;

/** What of the route the gate reads: the page, and the views that open on a thread. */
export interface ListIntroRoute {
  page: string;
  /** An attachment (a file or a document) open beside the thread or full screen. */
  file?: unknown;
  /** A guided review open over the window. */
  guide?: string | null;
  /** The thread's Artifacts view. */
  artifacts?: boolean;
}

/**
 * Whether the person is on the Inbox page with nothing over it: the list, with or without a thread open (a thread
 * from a notification, an agent's link or a reload counts, on a phone and a desktop alike: the owner's note, "it
 * should show if I have a thread open"), and no search or new message over it. A file, document, guided review or
 * Artifacts view open on the thread (side by side or full screen) keeps it away: the person is reading that, and the
 * claim waits, unspent, until it closes. Settings, the Board, What's new, Drafts and the tour are other pages: never
 * there.
 */
export function listIntroPageClear(route: ListIntroRoute, over: { search: boolean; compose: boolean }): boolean {
  return route.page === 'inbox' && !route.file && !route.guide && !route.artifacts && !over.search && !over.compose;
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

/** What the demo's picture shows at one moment (example projects, letter marks, logos, the stacked notes card). */
export interface RowsIntroScene {
  /** Which marks the rows and the sidebar show: none yet, the thread's with the project's on its corner, or the project's. */
  marks: 'off' | 'both' | 'projects';
  /** The projects' logos have landed on the marks. */
  logos: boolean;
  /** The stacked notes card is in. */
  card: boolean;
  /** The demo has ended and holds on this picture. */
  held: boolean;
}

/**
 * The demo's moments, ms after the dialog opens (approval "inbox-rows-dialog", NOTES.md, take C): letters pop in at
 * 0.3 s, logos land at 0.9 s, the row marks turn over to the projects at 1.5 s, back to the stacked look at 2.2 s as
 * the notes card rises in, and it holds from 2.6 s. Never under reduced motion: the dialog opens on the held picture.
 */
export const ROWS_INTRO_STEPS_MS = [300, 900, 1500, 2200, 2600] as const;
export const ROWS_INTRO_END_MS = ROWS_INTRO_STEPS_MS[ROWS_INTRO_STEPS_MS.length - 1];

/** The picture at `t` ms after the dialog opened. */
export function rowsIntroScene(t: number): RowsIntroScene {
  const [letters, logos, turn, back, end] = ROWS_INTRO_STEPS_MS;
  return {
    marks: t < letters ? 'off' : t >= turn && t < back ? 'projects' : 'both',
    logos: t >= logos,
    card: t >= back,
    held: t >= end,
  };
}

/** The rows' crossfade on each change of look in the List view's dialog (ListViewIntro), ms (none under reduced motion). */
export const LIST_INTRO_SWAP_MS = 150;
