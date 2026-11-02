/**
 * The window's page is older than the Inbox it talks to (the owner, 2026-11-02: an iPhone restored a cached 0.28.44
 * page against a 0.28.45 Inbox, nothing noticed, and a bug fixed in 0.28.45 came back with the old page). The page is
 * served `private, no-cache` (packages/server/inbox.ts), which does not stop a phone restoring a tab from its cache;
 * and an Inbox restarted onto a new release leaves every page already open as it was.
 *
 * So the page compares the release it was built from (`__APP_VERSION__`, apps/inbox/vite.config.ts) with the one the
 * Inbox runs, which the Inbox already says:
 * - on load: the first list read's `version` (`ListModel.version`);
 * - when the tab comes back from the back/forward cache (`pageshow`, persisted), when it is shown again
 *   (`visibilitychange`), and on every (re)connect of the event stream (`hello`): `GET /api/inbox/health`'s `version`.
 *
 * Only a stable release strictly newer than the page's counts (`newerInbox`). A development Inbox (`dev`, a
 * `0.0.0-dev` build), a page with no build (a test), and an older Inbox (the version matrix runs today's page on an
 * Inbox built as 0.28.10) never show it.
 *
 * The notice ("Inbox updated to X · Reload") never reloads by itself. Its × hides it until the next check that still
 * finds the page behind. Reload first saves what the person wrote (`flushBeforeReload`): the reply box, a compose
 * dialog, the answers on question cards, the action notes. Anything that cannot be saved stops the reload and says so.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { actionSavesSettled } from './actionSaves';
import { inboxApi } from './api';

declare const __APP_VERSION__: string;

/** The release this page was built from, or null where nothing defines it (a test, a tool that bundles it bare). */
export function pageBuild(): string | null {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;
}

/** A stable `X.Y.Z` (a leading `v` allowed); null for anything else (`dev`, `0.0.0-dev`, a pre-release). */
function stableParts(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** The Inbox's release (`X.Y.Z`) when it is a stable release newer than the page's stable release, else null. */
export function newerInbox(page: string | null, inbox: unknown): string | null {
  const ours = stableParts(page);
  const theirs = stableParts(inbox);
  // A `0.0.0` either side is a development build.
  if (!ours || !theirs || ours.every((n) => n === 0) || theirs.every((n) => n === 0)) return null;
  for (let i = 0; i < 3; i++) {
    if (theirs[i] !== ours[i]) return theirs[i]! > ours[i]! ? theirs.join('.') : null;
  }
  return null;
}

export interface StalePageChecker {
  /**
   * A version the page read anyway (the first list's): a newer release shows the notice (again, after a dismiss); a
   * version that is not newer hides it; no version (an older Inbox) changes nothing.
   */
  saw(inbox: unknown): void;
  /** Ask the Inbox which release it runs now (`read`), then as `saw`. One read at a time; a failed one changes nothing. */
  recheck(): Promise<void>;
  /** The ×: hidden until the next check that still finds the page behind. */
  dismiss(): void;
}

/**
 * The notice's state, without React: `onChange` gets the Inbox's newer release to show, or null to hide it. A page
 * with no build (`page` null) never asks.
 */
export function createStalePageChecker(page: string | null, read: () => Promise<unknown>, onChange: (inbox: string | null) => void): StalePageChecker {
  let checking: Promise<void> | null = null;
  const saw = (inbox: unknown) => {
    if (typeof inbox === 'string') onChange(newerInbox(page, inbox));
  };
  return {
    saw,
    recheck() {
      if (!page) return Promise.resolve();
      checking ??= read()
        .then(saw, () => {
          // Not reachable now (restarting, offline): the next check asks again.
        })
        .finally(() => {
          checking = null;
        });
      return checking;
    },
    dismiss() {
      onChange(null);
    },
  };
}

/**
 * Calls `recheck` when the tab comes back: from the back/forward cache (`pageshow`, persisted; a page loaded afresh
 * reads the list instead) or shown again (`visibilitychange` to visible). Returns the removal.
 */
export function onPageReturn(win: EventTarget, doc: EventTarget & { visibilityState: string }, recheck: () => void): () => void {
  const onShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) recheck();
  };
  const onVisible = () => {
    if (doc.visibilityState === 'visible') recheck();
  };
  win.addEventListener('pageshow', onShow);
  doc.addEventListener('visibilitychange', onVisible);
  return () => {
    win.removeEventListener('pageshow', onShow);
    doc.removeEventListener('visibilitychange', onVisible);
  };
}

/**
 * The window's stale page notice: `inbox` is the newer release to name (null: no notice). `saw` takes the first
 * list's version; `recheck` asks the Inbox (the event stream's `hello`); the tab coming back rechecks by itself.
 */
export function useStalePage(page: string | null = pageBuild()) {
  const [inbox, setInbox] = useState<string | null>(null);
  const checker = useMemo(() => createStalePageChecker(page, () => inboxApi.health().then((health) => health.version), setInbox), [page]);
  useEffect(() => (page ? onPageReturn(window, document, () => void checker.recheck()) : undefined), [page, checker]);
  const recheck = useCallback(() => void checker.recheck(), [checker]);
  return { inbox, saw: checker.saw, recheck, dismiss: checker.dismiss };
}

/** How long Reload waits for the saves before it gives up and says what is not saved. */
export const RELOAD_FLUSH_MS = 8_000;

/**
 * Saves what one part of the page holds now, before a reload: true once it is saved (or there was nothing), false
 * when it could not be (a conflict to resolve, a file still uploading, files a draft does not keep, a refusal).
 */
export type ReloadFlush = () => Promise<boolean>;

const reloadFlushes = new Set<ReloadFlush>();

/** A part of the page that holds something the person wrote (the open thread, a compose dialog); returns its removal. */
export function registerReloadFlush(flush: ReloadFlush): () => void {
  reloadFlushes.add(flush);
  return () => {
    reloadFlushes.delete(flush);
  };
}

/** Every part's save at once, and the action notes': true when all of it is saved, false past `timeoutMs`. */
export async function flushBeforeReload(timeoutMs = RELOAD_FLUSH_MS): Promise<boolean> {
  const all = Promise.all([
    ...[...reloadFlushes].map((flush) => flush().catch(() => false)),
    actionSavesSettled().then(
      () => true,
      () => false,
    ),
  ]).then((saved) => saved.every(Boolean));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([all, late]);
  } finally {
    clearTimeout(timer);
  }
}
