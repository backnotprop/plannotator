import { bareKeyAllowed } from '../shortcuts/guards';

export interface AppKeyPages {
  page: string;
  pulls: boolean;
  drafts: boolean;
  composing: boolean;
}

export function appKeyAllowed(event: KeyboardEvent, page: string, onTouchPhone = false): boolean {
  return bareKeyAllowed(event, undefined, { onTouchPhone }) && page !== 'tour';
}

type Handler = { when: (event: KeyboardEvent) => boolean; handle: () => void };

export function newPageKeys(pages: () => AppKeyPages, act: { goPulls: () => void; goDrafts: () => void; compose: () => void }): Record<'goPulls' | 'goDrafts' | 'compose', Handler> {
  return {
    goPulls: { when: (event) => appKeyAllowed(event, pages().page) && pages().pulls, handle: act.goPulls },
    goDrafts: { when: (event) => appKeyAllowed(event, pages().page) && pages().drafts, handle: act.goDrafts },
    compose: { when: (event) => appKeyAllowed(event, pages().page) && !pages().composing, handle: act.compose },
  };
}

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

export type RefreshKind = 'inbox' | 'board' | 'board+thread' | 'reviews' | 'reviews+thread';

export interface RefreshView {
  page: string;
  thread: string | null;
  fromReviews: boolean;
  fromCard: boolean;
  pullReview: boolean;
  fileOpen: boolean;
  tourOn: boolean;
  boardOn: boolean;
  pullsShown: boolean;
  listReady: boolean;
}

export function refreshKind(view: RefreshView): RefreshKind | null {
  if (view.tourOn) return null;
  if (view.page === 'board') return view.boardOn ? 'board' : null;
  if (view.page === 'reviews') return view.pullsShown && !view.pullReview ? 'reviews' : null;
  if (view.page !== 'inbox' || !view.listReady) return null;
  if (view.thread && view.fromCard && view.boardOn) return 'board+thread';
  if (view.fromReviews && view.pullsShown && !view.fileOpen && !view.fromCard) return 'reviews+thread';
  return 'inbox';
}

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

export interface ArchiveOpenThread {
  thread_id: string;
  resolved_at: string | null;
  messages: readonly { id: string }[];
}

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
