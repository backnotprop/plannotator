/**
 * The gates of the Inbox-wide keys added by approval "inbox-keyboard-keys-2026-11-07" and Shift+R's (approval
 * "inbox-refresh-key"; App.tsx runs them in its app scope), and what Shift+E archives. Kept apart from App so a test can drive them through the shortcut runtime.
 */
import { bareKeyAllowed } from '../shortcuts/guards';

/** What the gates read, at the moment of the key. */
export interface AppKeyPages {
  /** The route's page: on the tour every key but `?` stands down (its screens are a replay). */
  page: string;
  /** The sidebar shows Pull requests (Reviews): G P has somewhere to go. */
  pulls: boolean;
  /** The sidebar shows Drafts: G D has somewhere to go. */
  drafts: boolean;
  /** New message is open already: C does not open it again. */
  composing: boolean;
}

/** A bare Inbox-wide key: single keys live, not typing, no modal or menu, not on the tour. */
export function appKeyAllowed(event: KeyboardEvent, page: string, onTouchPhone = false): boolean {
  return bareKeyAllowed(event, undefined, { onTouchPhone }) && page !== 'tour';
}

type Handler = { when: (event: KeyboardEvent) => boolean; handle: () => void };

/** G P, G D and C: each only where its page or box exists, and C not while New message is open. */
export function newPageKeys(pages: () => AppKeyPages, act: { goPulls: () => void; goDrafts: () => void; compose: () => void }): Record<'goPulls' | 'goDrafts' | 'compose', Handler> {
  return {
    goPulls: { when: (event) => appKeyAllowed(event, pages().page) && pages().pulls, handle: act.goPulls },
    goDrafts: { when: (event) => appKeyAllowed(event, pages().page) && pages().drafts, handle: act.goDrafts },
    compose: { when: (event) => appKeyAllowed(event, pages().page) && !pages().composing, handle: act.compose },
  };
}

/**
 * Shift+R (approval "inbox-refresh-key"): the refresh of the page on screen, the same as its own control. The Inbox
 * or a project (the list header's ↻, also with a thread open), the Board (its ⋮ Refresh) or Reviews (its ↻). `run` is
 * null where the page has no refresh (Drafts, Settings, a pull request's review, a list still loading): the key does
 * nothing there and is left to the browser, which gives Shift+R no meaning of its own.
 */
export function refreshKey(on: () => { page: string; run: (() => void) | null }): Record<'refresh', Handler> {
  return {
    refresh: {
      when: (event) => {
        const now = on();
        return appKeyAllowed(event, now.page) && now.run !== null;
      },
      handle: () => on().run?.(),
    },
  };
}

/**
 * Which refresh is on screen. `board+thread`: a thread opened from a Board card ("‹ Board"): the Board's refresh and the
 * thread read again. `reviews+thread`: a thread beside the Reviews list it was opened from: that list's ↻ and the thread.
 */
export type RefreshKind = 'inbox' | 'board' | 'board+thread' | 'reviews' | 'reviews+thread';

/** What `refreshKind` reads, at render (App.tsx): the route and what the window draws for it. */
export interface RefreshView {
  page: string;
  thread: string | null;
  /** The thread was opened from Reviews (`route.reviews`). */
  fromReviews: boolean;
  /** The thread was opened from a Board card (`route.card`). */
  fromCard: boolean;
  /** A pull request's full review (`route.stack` and `route.layer`): no refresh there. */
  pullReview: boolean;
  /** A file has the page in place of the list (`route.file`). */
  fileOpen: boolean;
  tourOn: boolean;
  /** The Board is on (`boardEnabled === true`). */
  boardOn: boolean;
  /** Reviews shows (Code review on, not a tailnet guest's page). */
  pullsShown: boolean;
  /** The Inbox's list or thread is drawn: read, and neither the first-run nor the tour's entry screen. */
  listReady: boolean;
}

/**
 * What Shift+R refreshes (approval "inbox-refresh-key"): the refresh of the page on screen, as its own control does; null
 * where the page has none (Drafts, Settings, What's new, Shapes, a pull request's review, a page off or still loading).
 */
export function refreshKind(view: RefreshView): RefreshKind | null {
  if (view.tourOn) return null;
  if (view.page === 'board') return view.boardOn ? 'board' : null;
  if (view.page === 'reviews') return view.pullsShown && !view.pullReview ? 'reviews' : null;
  if (view.page !== 'inbox' || !view.listReady) return null;
  if (view.thread && view.fromCard && view.boardOn) return 'board+thread';
  if (view.fromReviews && view.pullsShown && !view.fileOpen && !view.fromCard) return 'reviews+thread';
  return 'inbox';
}

/** The refresh a kind runs, from the window's own refreshes; null for none. */
export function refreshAction(
  kind: RefreshKind | null,
  act: { inbox: () => void; board: () => void; reviews: () => void; thread: () => void },
): (() => void) | null {
  switch (kind) {
    case 'inbox':
      return act.inbox;
    case 'board':
      return act.board;
    case 'reviews':
      return act.reviews;
    case 'board+thread':
      return () => {
        act.board();
        act.thread();
      };
    case 'reviews+thread':
      return () => {
        act.reviews();
        act.thread();
      };
    default:
      return null;
  }
}

/** The open thread as Shift+E needs it. */
export interface ArchiveOpenThread {
  thread_id: string;
  resolved_at: string | null;
  messages: readonly { id: string }[];
}

/**
 * What Shift+E archives: the row the keyboard is on (by its own id), else the open thread (by its first message's id,
 * as the header's Archive thread does); nothing when that one is archived already. `keyRow` is the row only when the
 * keyboard put focus there (a clicked row does not win over the open thread).
 */
export function archiveTarget(input: {
  keyRow: string | null;
  open: ArchiveOpenThread | null;
  routeThread: string | null;
  resolvedOf: (threadId: string) => string | null | undefined;
}): { threadId: string; messageId: string } | null {
  const { keyRow, open, routeThread, resolvedOf } = input;
  if (keyRow) return resolvedOf(keyRow) === null ? { threadId: keyRow, messageId: keyRow } : null;
  if (!open || open.thread_id !== routeThread || open.resolved_at !== null) return null;
  const root = open.messages[0]?.id;
  return root ? { threadId: open.thread_id, messageId: root } : null;
}
