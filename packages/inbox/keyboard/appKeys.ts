/**
 * The gates of the Inbox-wide keys added by approval "inbox-keyboard-keys-2026-11-07" (App.tsx runs them in its app
 * scope), and what Shift+E archives. Kept apart from App so a test can drive them through the shortcut runtime.
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
