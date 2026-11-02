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
 *   (`visibilitychange`), and on every (re)connect of the event stream (`hello`): `GET /api/inbox/health`'s `version`,
 *   read within `STALE_HEALTH_MS`.
 *
 * Only a stable release strictly newer than the page's counts (`newerInbox`). A development Inbox (`dev`, a
 * `0.0.0-dev` build), a page with no build (a test), and an older Inbox (the version matrix runs today's page on an
 * Inbox built as 0.28.10) never show it. Nor does the person's own Restart, which reloads the page by itself.
 *
 * The notice ("Inbox updated to X · Reload") never reloads by itself. Its × hides it for that release: it comes back
 * only for a newer one, or on the next page load (no nagging on every return to the tab). Reload first saves what the
 * person wrote (`reloadOntoInbox`, `flushBeforeReload`); anything that cannot be saved stops the reload and says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { actionSavesSettled } from './actionSaves';
import { adoptPageSession, inboxApi, pageServerSession } from './api';
import { selfMachineId } from './inboxUrl';
import { unsentReply } from './unsent';

declare const __APP_VERSION__: string;

/** The release this page was built from, or null where nothing defines it (a test, a tool that bundles it bare). */
export function pageBuild(): string | null {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;
}

/** How long a read of the Inbox's health may take (a check, and Reload's): a stalled phone connection never holds either. */
export const STALE_HEALTH_MS = 3_000;

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
   * A version the page read anyway (the first list's): a newer release shows the notice; a version that is not newer
   * hides it; no version (an older Inbox) changes nothing. A release the person dismissed stays hidden.
   */
  saw(inbox: unknown): void;
  /** Ask the Inbox which release it runs now (`read`), then as `saw`. One read at a time; a failed one changes nothing. */
  recheck(): Promise<void>;
  /** The ×: hidden for this release, until a newer one or the next page load. */
  dismiss(): void;
}

/**
 * The notice's state, without React: `onChange` gets the Inbox's newer release to show, or null to hide it. A page
 * with no build (`page` null) never asks. While `paused` (the person's own Restart, which reloads the page by itself)
 * nothing is read or shown.
 */
export function createStalePageChecker(
  page: string | null,
  read: () => Promise<unknown>,
  onChange: (inbox: string | null) => void,
  paused: () => boolean = () => false,
): StalePageChecker {
  let checking: Promise<void> | null = null;
  /** The release on screen now (null: none). */
  let shown: string | null = null;
  /** The release the × hid: only a newer one shows again. */
  let dismissed: string | null = null;
  const show = (next: string | null) => {
    shown = next;
    onChange(next);
  };
  const saw = (inbox: unknown) => {
    if (typeof inbox !== 'string' || paused()) return;
    const newer = newerInbox(page, inbox);
    show(newer && dismissed && !newerInbox(dismissed, newer) ? null : newer);
  };
  return {
    saw,
    recheck() {
      if (!page || paused()) return Promise.resolve();
      checking ??= read()
        .then(saw, () => {
          // Not reachable now (restarting, offline, past STALE_HEALTH_MS): the next check asks again.
        })
        .finally(() => {
          checking = null;
        });
      return checking;
    },
    dismiss() {
      if (shown) dismissed = shown;
      show(null);
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
 * `paused` is read at each check (the person's own Restart).
 */
export function useStalePage(page: string | null = pageBuild(), paused: () => boolean = () => false) {
  const [inbox, setInbox] = useState<string | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const checker = useMemo(
    () => createStalePageChecker(page, () => inboxApi.healthWithin(STALE_HEALTH_MS).then((health) => health.version), setInbox, () => pausedRef.current()),
    [page],
  );
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

/**
 * Every part's save at once, and the action notes': true when all of it is saved and no reply words are left unsaved
 * anywhere on the page (a conflict, too long or refused in a thread not open: `unsentReply`, which a phone's Safari
 * would otherwise lose without its "Leave page?"). False past `timeoutMs`.
 */
export async function flushBeforeReload(timeoutMs = RELOAD_FLUSH_MS): Promise<boolean> {
  const all = Promise.all([
    ...[...reloadFlushes].map((flush) => flush().catch(() => false)),
    actionSavesSettled().then(
      () => true,
      () => false,
    ),
  ]).then((saved) => saved.every(Boolean) && unsentReply() === null);
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

export interface ReloadOntoInbox {
  /** The Inbox's health, read within STALE_HEALTH_MS. */
  readHealth: () => Promise<{ serverSession: string; inbox_id?: string }>;
  /** This page's own Inbox id (the merged list's `self`), null before it is known. */
  selfId: () => string | null;
  /** The page's serverSession, which every write carries (api.ts). */
  session: { get: () => string | null; set: (value: string) => void };
  flush: () => Promise<boolean>;
  reload: () => void;
}

const pageReload: ReloadOntoInbox = {
  readHealth: () => inboxApi.healthWithin(STALE_HEALTH_MS),
  selfId: selfMachineId,
  session: { get: pageServerSession, set: adoptPageSession },
  flush: () => flushBeforeReload(),
  reload: () => window.location.reload(),
};

/**
 * The notice's Reload: save, then reload. True when the page reloads; false when something is not saved.
 *
 * When the Inbox restarted under the page, its saves would be refused (409 session_mismatch) and the words lost. So,
 * only for this page's own Inbox (the health's `inbox_id` is the page's own id; another Inbox on the same port gets
 * nothing), the saves go with the running Inbox's session. When they did not all land the page keeps its first
 * session again, so the old page's writes are refused as before.
 */
export async function reloadOntoInbox(deps: ReloadOntoInbox = pageReload): Promise<boolean> {
  const prior = deps.session.get();
  let adopted = false;
  try {
    const health = await deps.readHealth();
    const self = deps.selfId();
    if (self !== null && health.inbox_id === self && health.serverSession !== prior) {
      deps.session.set(health.serverSession);
      adopted = true;
    }
  } catch {
    // Not reachable within STALE_HEALTH_MS: the saves below go as they are, and say what did not land.
  }
  if (await deps.flush()) {
    deps.reload();
    return true;
  }
  if (adopted && prior !== null) deps.session.set(prior);
  return false;
}
