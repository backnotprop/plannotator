/**
 * What this window tells the server for "Recent activity" (approval "inbox-recent-activity-filter"; the filter is
 * listFilterRecent.ts, the record shared's inbox/acted.ts). Only what no other write already says:
 *
 * - The person opened a thread: the opening look (`POST /seen`) says `opened` when the person chose the thread, so
 *   opening adds no request. Chosen: the route moved to that thread within `CHOSEN_MS` of the person's own click, tap
 *   or key in this window (a row, search, a star, a link in a message, the keyboard), or of their click on a
 *   notification about it (notify.ts calls `gestured`). Not chosen: a thread shown on load, or because an agent or a
 *   launch link opened it (no gesture here). The browser's user activation is not read: it lasts about 5 s, long
 *   enough for an agent's open after an unrelated click to pass as the person's.
 * - The person played a film or a recording in the open thread (a `play` with a gesture just before it): one
 *   `POST /threads/:id/acted`, at most once per thread per `PLAY_EVERY_MS`, and the window's own note
 *   (`noteActedHere`) until the list reads it back.
 *
 * Sends, picks, comments and drafts are already the server's records: nothing here for them.
 */
import { useEffect } from 'react';
import { apiPost } from './api';
import { inboxUrl } from './inboxUrl';
import { readRoute } from './app/route';
import { noteActedHere } from './listFilterRecent';

/** How soon after the person's gesture a route change is theirs. */
export const CHOSEN_MS = 1000;
/** How long a chosen open waits for its opening look (a slow read over the tailnet). */
const CHOSEN_KEPT_MS = 60_000;
/** A film played again in the same thread within this is not written again. */
const PLAY_EVERY_MS = 30_000;

let gestureAt = Number.NEGATIVE_INFINITY;
let shownThread: string | null = null;
const chosen = new Map<string, number>();
const playedAt = new Map<string, number>();

const routeThread = (): string | null => (readRoute() as { thread?: string | null }).thread ?? null;

/** The person's own gesture in this window just now. */
function byPerson(now: number): boolean {
  return now - gestureAt <= CHOSEN_MS;
}

/** Each route change: a thread the person moved to is chosen. */
export function routeChanged(now = Date.now(), thread = routeThread()): void {
  if (thread && thread !== shownThread && byPerson(now)) chosen.set(thread, now);
  shownThread = thread;
}

/** The person clicked, tapped or pressed a key in this window, or clicked one of its notifications. */
export function gestured(now = Date.now()): void {
  gestureAt = now;
}

/** The opening look's `opened`: the person chose this thread (once per choice). */
export function personOpened(threadId: string, now = Date.now()): boolean {
  const at = chosen.get(threadId);
  chosen.delete(threadId);
  return at !== undefined && now - at <= CHOSEN_KEPT_MS;
}

/** A film or recording started playing in the open thread. */
export function mediaPlayed(now = Date.now(), post: (threadId: string) => Promise<unknown> = postActed, thread = routeThread()): void {
  if (!thread || !byPerson(now) || now - (playedAt.get(thread) ?? Number.NEGATIVE_INFINITY) < PLAY_EVERY_MS) return;
  playedAt.set(thread, now);
  noteActedHere(thread, new Date(now).toISOString());
  void post(thread).catch(() => {});
}

// This Inbox's own route, also for a linked machine's thread: the merged list reads the note for its row.
const postActed = (threadId: string) => apiPost(inboxUrl(`/threads/${encodeURIComponent(threadId)}/acted`), {});

/** The window's listeners for the above, while the Inbox is on screen. */
export function useRecentActs(): void {
  useEffect(() => {
    shownThread = routeThread();
    const onGesture = () => gestured();
    const onRoute = () => routeChanged();
    const onPlay = (event: Event) => {
      if (event.target instanceof HTMLMediaElement) mediaPlayed();
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    window.addEventListener('hashchange', onRoute);
    // `play` does not bubble: caught on the way down.
    document.addEventListener('play', onPlay, true);
    return () => {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      window.removeEventListener('hashchange', onRoute);
      document.removeEventListener('play', onPlay, true);
    };
  }, []);
}

/** Tests only: a fresh window. */
export function resetRecentActsForTests(): void {
  gestureAt = Number.NEGATIVE_INFINITY;
  shownThread = null;
  chosen.clear();
  playedAt.clear();
}
