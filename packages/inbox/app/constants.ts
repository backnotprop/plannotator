/** The window's cookies, waits and retry schedules (App.tsx). */

export const SIDEBAR_OPEN_COOKIE = 'plannotator-inbox-sidebar-open';
/** The list's ⋯ "Hide offline machines" (linked machines): kept in this browser, like the sidebar's state. */
export const HIDE_AWAY_MACHINES_COOKIE = 'plannotator-inbox-hide-offline-machines';
/** The session the person last sent a new message to: first in the To picker and the palette's "Message <host>" while it is live; never put in To by itself. */
export const COMPOSE_LAST_COOKIE = 'plannotator-inbox-compose-last';
/** How often the Drafts page reads its drafts again, so each chip follows its session. */
export const DRAFTS_REFRESH_MS = 10_000;
/** No cards handled yet (the Board before its first read of a visit). */
export const EMPTY_SET: ReadonlySet<string> = new Set();
/** How long the refresh icon shows after a click on Inbox: one turn (inbox.css `ib-refresh-turn`, 500 ms), then back to the inbox icon. */
export const REFRESH_SPIN_MS = 600;
/** After the live region said "Reconnecting…", it says it again only past this (a network that comes and goes). */
export const RECONNECT_SAY_GAP_MS = 10 * 60_000;
/** How long a page over the tailnet says that a restart has not come back: long enough to read away from the computer. */
export const RESTART_NOT_BACK_MS = 20_000;
/** How long "Not reloaded: something you wrote is not saved yet" stays, with its Reload anyway (the stale page notice). */
export const STALE_NOT_SAVED_MS = 12_000;
/** Settings → Agents re-reads the agents this often while open, so "Open sessions" follows the sessions as they restart. */
export const AGENTS_SESSIONS_REFRESH_MS = 5_000;
/** A look seen on sight that the server did not take is sent again this many times, 1 s, 2 s, 4 s… apart. */
export const SEEN_RETRIES = 5;
export const SEEN_RETRY_MS = 1000;
/** How long a look that landed waits for its record (written before the look answers) to bring the list read. */
export const LOOK_RECORD_WAIT_MS = 250;
/** Records this close together share one read, started this long after the last of them. */
export const RECORD_PAUSE_MS = 80;
/** The What's new page asks again this often while the server fetches the notes (its request gives up after 10 s). */
export const WHATS_NEW_RETRIES = 15;
export const WHATS_NEW_RETRY_MS = 1000;
/** The releases panel asks again this often while the server fetches the release list (once a day at most). */
export const WHATS_NEW_RELEASES_RETRIES = 6;
export const WHATS_NEW_RELEASES_RETRY_MS = 1500;
/**
 * Opening a thread whose read failed (a dropped connection, a 5xx; not a 404): read it again after
 * these waits, then every last one, while it stays open. Before this the pane stayed blank until some
 * agent wrote anywhere in the Inbox (the event stream re-reads the open thread), seconds or forever.
 * A failed re-read of a thread already on screen waits the same (liveThreadRetry).
 */
export const THREAD_READ_RETRY_MS = [250, 1000, 2000, 4000, 5000] as const;
/**
 * A read of the open thread with no answer by then (a connection held behind
 * the browser's six per host, a stalled server) fails and is read again, as
 * a dropped one is; before this it waited for good.
 */
export const THREAD_READ_TIMEOUT_MS = 8000;
/** How long a fresh load's 404 waits for the first merged list before it says the thread is not here. */
export const FIRST_LIST_WAIT_MS = 10_000;
/** How long "Not sent to MacBook: it is no longer linked." stays: long enough to read and go to Settings. */
export const UNSENT_TOAST_MS = 12_000;
/**
 * How long a 404 waits, after a start, for linked machines whose lists this Inbox has not read yet (one asleep may hold
 * the thread). After that it says the thread is not here; a later list that names its machine opens it there.
 */
export const UNLISTED_WAIT_MS = 120_000;
/** Why the open thread is not on screen yet: its read failed (read again soon), or the server has no such thread. */
export interface ThreadLoad {
  threadId: string;
  state: 'failed' | 'missing' | 'refused';
  error: string;
  /** Failed only because linked machines have not sent their lists yet: what it waits for, said in place of the error. */
  waiting?: string | null;
}
