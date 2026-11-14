/**
 * The sidebar's layout on this page (approval "inbox-sidebar-customize", 2026-11-08; the model is core
 * `inbox-sidebar.ts`): which items show, their order, top or bottom. One layout per person, kept by the server
 * (config.json `inboxSidebar` through POST /api/inbox/settings `{ sidebar }`), so every browser and the phone match,
 * and every window open takes a save at once (`event: sidebar`).
 *
 * As the rows' look does (listLook.ts): a change shows at once, then is saved, one save on its way at a time (a change
 * meanwhile waits, only the latest). Every answer, settings read and event carries the server's save count
 * (`sidebar_rev`): one older than the newest this page heard is dropped, unless the count went back (config.json
 * reset or hand-edited), and once every save answered the page shows the newest layout, whichever window made it.
 * The cookie `plannotator-inbox-sidebar-layout` keeps the last layout this browser showed, so a reload paints it
 * before the settings read answers; it is never the truth.
 *
 * Also here: whether the Customize panel is open, and what opened it (focus goes back there when it closes).
 */
import { useSyncExternalStore } from 'react';
import { INBOX_SIDEBAR_DEFAULT, inboxSidebarRead, inboxSidebarSame, type InboxSidebarLayout } from '@plannotator/core/inbox-sidebar';
import { storage } from '@plannotator/ui/utils/storage';
import { inboxApi } from './api';

export const SIDEBAR_LAYOUT_COOKIE = 'plannotator-inbox-sidebar-layout';

/** The cookie's form: `top;bottom;hidden`, each a comma list of item names. Short, and a cookie's characters only. */
export function sidebarLayoutCookie(layout: InboxSidebarLayout): string {
  return [layout.top, layout.bottom, layout.hidden].map((list) => list.join(',')).join(';');
}
export function parseSidebarLayoutCookie(raw: string | null): InboxSidebarLayout | null {
  if (!raw) return null;
  const [top = '', bottom = '', hidden = ''] = raw.split(';');
  const list = (part: string) => part.split(',').filter(Boolean);
  return inboxSidebarRead({ top: list(top), bottom: list(bottom), hidden: list(hidden) });
}

let current: InboxSidebarLayout | null = null;
let serverRev = -1;
let serverLayout: InboxSidebarLayout | null = null;
let eventRev = -1;
let inFlight = false;
let queued: InboxSidebarLayout | null = null;
let drained: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function readBrowserLayout(): InboxSidebarLayout {
  try {
    return parseSidebarLayoutCookie(storage.getItem(SIDEBAR_LAYOUT_COOKIE)) ?? INBOX_SIDEBAR_DEFAULT;
  } catch {
    return INBOX_SIDEBAR_DEFAULT;
  }
}
const shown = (): InboxSidebarLayout => (current ??= readBrowserLayout());

function show(layout: InboxSidebarLayout): void {
  try {
    if (inboxSidebarSame(layout, INBOX_SIDEBAR_DEFAULT)) storage.removeItem(SIDEBAR_LAYOUT_COOKIE);
    else storage.setItem(SIDEBAR_LAYOUT_COOKIE, sidebarLayoutCookie(layout));
  } catch {
    // A page with no cookies still shows the layout; a reload only paints the default until the settings read.
  }
  if (current && inboxSidebarSame(current, layout)) return;
  current = layout;
  for (const listener of [...listeners]) listener();
}

function hear(layout: InboxSidebarLayout, rev: unknown): void {
  const count = typeof rev === 'number' && Number.isFinite(rev) ? rev : Math.max(serverRev, 0);
  if (count < serverRev) return;
  serverRev = count;
  serverLayout = layout;
  if (!inFlight && !queued) show(layout);
}

async function sendQueued(): Promise<void> {
  inFlight = true;
  let heard = false;
  while (queued) {
    const layout = queued;
    queued = null;
    const before = serverRev;
    try {
      const answer = await inboxApi.saveSidebar(layout);
      // The count went back (config.json reset, restored or hand-edited): this answer is the server's layout.
      if (typeof answer.sidebar_rev === 'number' && answer.sidebar_rev <= before) serverRev = -1;
      const saved = inboxSidebarRead(answer.sidebar);
      if (saved) hear(saved, answer.sidebar_rev);
      heard = true;
    } catch {
      // Not saved (offline, an older Inbox): the layout stays on this page and in its cookie until the next read.
      heard = serverRev > before;
    }
  }
  inFlight = false;
  if (heard && serverLayout) show(serverLayout);
}

/** The person changed the layout (a menu checkbox, the panel): shown at once, then saved. */
export function writeSidebarLayout(next: InboxSidebarLayout): Promise<void> {
  show(next);
  queued = next;
  if (!inFlight) drained = sendQueued();
  return drained;
}

export function readSidebarLayout(): InboxSidebarLayout {
  return shown();
}

/** Taken when a settings read is sent, and given back with its answer (`adoptSavedSidebar`'s `sentAt`). */
export function sidebarLayoutReadMark(): number {
  return serverRev;
}

/**
 * The server's layout and its save count, from a settings read (`sidebar`, `sidebar_rev`). Absent (an older Inbox):
 * this browser's stays. Null (never saved): the default. A read below the count this page had heard when it was sent
 * means the count went back, so the page takes it and counts again from there.
 */
export function adoptSavedSidebar(sidebar: unknown, rev?: unknown, sentAt?: number): void {
  if (sidebar === undefined) return;
  if (typeof rev === 'number' && sentAt !== undefined && rev < sentAt) serverRev = -1;
  hear(inboxSidebarRead(sidebar) ?? INBOX_SIDEBAR_DEFAULT, rev);
}

/**
 * Another save, here or in another window (`event: sidebar`). One at or below the last event's count is never
 * taken (the count gone back, or a late copy relayed by a second leader tab): `onDoubt` asks for a settings read.
 */
export function hearSidebarEvent(sidebar: unknown, rev?: unknown, onDoubt?: () => void): void {
  if (sidebar === undefined) return;
  if (typeof rev === 'number') {
    if (rev <= eventRev) {
      onDoubt?.();
      return;
    }
    eventRev = rev;
  }
  const layout = inboxSidebarRead(sidebar);
  if (layout) hear(layout, rev);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const ignore = () => () => {};
const defaults = () => INBOX_SIDEBAR_DEFAULT;

/** The layout to draw. `remember: false` (the onboarding tour's sidebar): always today's default. */
export function useSidebarLayout(remember = true): InboxSidebarLayout {
  return useSyncExternalStore(remember ? subscribe : ignore, remember ? shown : defaults, defaults);
}

/** Tests: forget everything this page heard. */
export function resetSidebarLayoutForTests(): void {
  current = null;
  serverRev = -1;
  serverLayout = null;
  eventRev = -1;
  inFlight = false;
  queued = null;
  drained = Promise.resolve();
  customizer = null;
  for (const listener of [...listeners]) listener();
}

/* The Customize panel: open or not, and the control that opened it. */

let customizer: { opener: HTMLElement | null; item: string | null } | null = null;

export function openSidebarCustomizer(opener: HTMLElement | null): void {
  customizer = { opener, item: opener?.closest('[data-sidebar-item]')?.getAttribute('data-sidebar-item') ?? null };
  for (const listener of [...listeners]) listener();
}

/**
 * Closes the panel and says where focus goes: what opened it, or, when a move drew that sidebar row again (a row
 * that changed stacks is a new element), the same row's control now, else Inbox, which never hides.
 */
export function closeSidebarCustomizer(): HTMLElement | null {
  const was = customizer;
  customizer = null;
  for (const listener of [...listeners]) listener();
  if (was?.opener?.isConnected) return was.opener;
  if (!was?.item) return null;
  const again = document.querySelector<HTMLElement>(`.ib-side [data-sidebar-item="${CSS.escape(was.item)}"] :is(button, a, [tabindex])`);
  return again ?? document.querySelector<HTMLElement>('.ib-side [data-inbox-nav]');
}

const customizerOpen = () => customizer !== null;
export function useSidebarCustomizerOpen(): boolean {
  return useSyncExternalStore(subscribe, customizerOpen, () => false);
}
