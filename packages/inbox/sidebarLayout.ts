import { useSyncExternalStore } from 'react';
import { INBOX_SIDEBAR_DEFAULT, inboxSidebarRead, inboxSidebarSame, type InboxSidebarLayout } from '@plannotator/core/inbox-sidebar';
import { storage } from '@plannotator/ui/utils/storage';
import { inboxApi } from './api';

export const SIDEBAR_LAYOUT_COOKIE = 'plannotator-inbox-sidebar-layout';

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
      if (typeof answer.sidebar_rev === 'number' && answer.sidebar_rev <= before) serverRev = -1;
      const saved = inboxSidebarRead(answer.sidebar);
      if (saved) hear(saved, answer.sidebar_rev);
      heard = true;
    } catch {
      heard = serverRev > before;
    }
  }
  inFlight = false;
  if (heard && serverLayout) show(serverLayout);
}

export function writeSidebarLayout(next: InboxSidebarLayout): Promise<void> {
  show(next);
  queued = next;
  if (!inFlight) drained = sendQueued();
  return drained;
}

export function readSidebarLayout(): InboxSidebarLayout {
  return shown();
}

export function sidebarLayoutReadMark(): number {
  return serverRev;
}

export function adoptSavedSidebar(sidebar: unknown, rev?: unknown, sentAt?: number): void {
  if (sidebar === undefined) return;
  if (typeof rev === 'number' && sentAt !== undefined && rev < sentAt) serverRev = -1;
  hear(inboxSidebarRead(sidebar) ?? INBOX_SIDEBAR_DEFAULT, rev);
}

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

export function useSidebarLayout(remember = true): InboxSidebarLayout {
  return useSyncExternalStore(remember ? subscribe : ignore, remember ? shown : defaults, defaults);
}

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

let customizer: { opener: HTMLElement | null; item: string | null } | null = null;

export function openSidebarCustomizer(opener: HTMLElement | null): void {
  customizer = { opener, item: opener?.closest('[data-sidebar-item]')?.getAttribute('data-sidebar-item') ?? null };
  for (const listener of [...listeners]) listener();
}

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
