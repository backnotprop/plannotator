import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { actionSavesSettled } from './actionSaves';
import { adoptPageSession, inboxApi, pageServerSession } from './api';
import { selfMachineId } from './inboxUrl';
import { unsentReply } from './unsent';

declare const __APP_VERSION__: string;

export function pageBuild(): string | null {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;
}

export const STALE_HEALTH_MS = 3_000;

function stableParts(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function newerInbox(page: string | null, inbox: unknown): string | null {
  const ours = stableParts(page);
  const theirs = stableParts(inbox);
  if (!ours || !theirs || ours.every((n) => n === 0) || theirs.every((n) => n === 0)) return null;
  for (let i = 0; i < 3; i++) {
    if (theirs[i] !== ours[i]) return theirs[i]! > ours[i]! ? theirs.join('.') : null;
  }
  return null;
}

export interface StalePageChecker {
  saw(inbox: unknown): void;
  recheck(): Promise<void>;
  dismiss(): void;
}

export function createStalePageChecker(
  page: string | null,
  read: () => Promise<unknown>,
  onChange: (inbox: string | null) => void,
  paused: () => boolean = () => false,
): StalePageChecker {
  let checking: Promise<void> | null = null;
  let shown: string | null = null;
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

export const RELOAD_FLUSH_MS = 8_000;

export type ReloadFlush = () => Promise<boolean>;

const reloadFlushes = new Set<ReloadFlush>();

export function registerReloadFlush(flush: ReloadFlush): () => void {
  reloadFlushes.add(flush);
  return () => {
    reloadFlushes.delete(flush);
  };
}

/** Includes reply words left unsaved in a thread not open, which a phone's Safari would otherwise lose without its "Leave page?". */
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
  readHealth: () => Promise<{ serverSession: string; inbox_id?: string }>;
  selfId: () => string | null;
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

/** After an Inbox restart the saves would be refused (409 session_mismatch) and the words lost, so for this page's own Inbox they go with the running session; if they did not all land the page keeps its first session again. */
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
  }
  if (await deps.flush()) {
    deps.reload();
    return true;
  }
  if (adopted && prior !== null) deps.session.set(prior);
  return false;
}
