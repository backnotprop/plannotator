/**
 * When the launch dialog shows (the launch switch, packages/shared/launch-switch.ts; the dialog, LaunchDialog.tsx).
 * Plannotator's plan review, code review, annotate and the Inbox call `useLaunchAnnouncement`; a host that does not
 * (the Workspaces app) never shows it.
 *
 *  - Claim: once the page has loaded and the host's gates hold (`ready`, `eligible`), the server answers from its kept
 *    copy only: `{ show: false }` or `{ show: true, campaign, url }`. Nothing is used up. The page never waits on it: a
 *    claim with no answer in LAUNCH_CLAIM_WAIT_MS counts as no for this load.
 *  - Open: with `firstRunWindow` (plan review, code review, annotate) only as the page opens, before the reader starts
 *    working (useFirstRunAnnouncementWindow); without it (the Inbox) as soon as the host allows.
 *  - Shown: right before it draws, `shown` stamps it on this computer (a compare-and-set across every surface); it draws
 *    only on `{ show: true }`.
 *  - Answer: `opened` ("See the launch") or `dismissed` (Not now, Escape, the backdrop). Either way it
 *    never shows again for that campaign.
 *
 * `holds`: the other one-time dialogs of this load yield while it is true, so only one dialog appears: while the claim
 * is out, while it says this load is the launch's, and for the rest of a load that showed it.
 * The dialog's code is loaded only when a claim says it shows.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useFirstRunAnnouncementWindow } from '../hooks/useFirstRunAnnouncementWindow';
import { isVSCodeWebview } from '../utils/inboxAnnouncement';
import { launchArtUrl } from '../utils/launchDialogWords';
import type { LaunchDialogAnswer } from './LaunchDialog';

export type LaunchClaim = { show: false } | { show: true; campaign: string; url: string };

export interface LaunchClient {
  claim(): Promise<LaunchClaim>;
  shown(campaign: string): Promise<{ show: boolean }>;
  answer(answer: LaunchDialogAnswer, campaign: string): Promise<unknown>;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** The plan, review and annotate servers' routes (both runtimes). */
export const launchHttpClient: LaunchClient = {
  claim: () => post('/api/launch-switch/claim'),
  shown: (campaign) => post('/api/launch-switch/shown', { campaign }),
  answer: (answer, campaign) => post('/api/launch-switch/answer', { answer, campaign }).catch(() => undefined),
};

/** The longest a load waits for the claim before it counts as no (the others then go on as before). */
export const LAUNCH_CLAIM_WAIT_MS = 1500;

const loadDialog = () => import('./LaunchDialog');
const LazyLaunchDialog = lazy(loadDialog);

/** A claim the page can act on: a campaign and an https launch link (the server's parser already checked both). */
function usable(claim: unknown): claim is Extract<LaunchClaim, { show: true }> {
  if (!claim || typeof claim !== 'object') return false;
  const c = claim as Record<string, unknown>;
  return c.show === true && typeof c.campaign === 'string' && launchArtUrl(c.campaign) !== null && typeof c.url === 'string' && c.url.startsWith('https://');
}

export interface LaunchAnnouncementInput {
  /** The page has loaded (the claim, and the first-run window's clock, wait for it). */
  ready: boolean;
  /** The host's gates hold now (a live session, not shared, archive or read-only, …). The VS Code webview is the hook's own. */
  eligible: boolean;
  /** Open only before the reader starts working (plan review, code review, annotate). The Inbox: false. */
  firstRunWindow: boolean;
  /** The Inbox: something else is over the page now; the dialog waits (never counted against it). */
  blocked?: boolean;
  /** Runs when the dialog draws (the Inbox: its reveals hold back). */
  onDrawn?: () => void;
  /** Tests and other hosts: the routes. */
  client?: LaunchClient;
  claimWaitMs?: number;
}

export interface LaunchAnnouncement {
  /** The other one-time dialogs of this load wait (see the header). */
  holds: boolean;
  /** It drew on this load. */
  shownThisLoad: boolean;
  /** On screen now. */
  open: boolean;
  /** The dialog, or null. */
  dialog: ReactNode | null;
}

type ClaimState = 'idle' | 'asking' | 'no' | 'late' | Extract<LaunchClaim, { show: true }>;

export function useLaunchAnnouncement({ ready, eligible: hostEligible, firstRunWindow, blocked = false, onDrawn, client = launchHttpClient, claimWaitMs = LAUNCH_CLAIM_WAIT_MS }: LaunchAnnouncementInput): LaunchAnnouncement {
  // Never in the VS Code webview (as the star ask): no claim, nothing held.
  const eligible = hostEligible && !isVSCodeWebview();
  const [claim, setClaim] = useState<ClaimState>('idle');
  const [stamp, setStamp] = useState<'none' | 'asking' | 'shown' | 'refused'>('none');
  const [closed, setClosed] = useState(false);
  const api = useRef(client);
  api.current = client;
  const drawnRef = useRef(onDrawn);
  drawnRef.current = onDrawn;

  // The claim: once, when the page is ready and the gates hold. A claim answered after the wait is ignored.
  useEffect(() => {
    if (!ready || !eligible || claim !== 'idle') return;
    setClaim('asking');
    let settled = false;
    const late = setTimeout(() => {
      if (settled) return;
      settled = true;
      setClaim('late');
    }, claimWaitMs);
    api.current
      .claim()
      .then((answer) => (usable(answer) ? answer : 'no' as const), () => 'no' as const)
      .then((answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(late);
        if (typeof answer === 'object') {
          // The dialog's code and its art start loading now, so both are in by the time it opens.
          void loadDialog().catch(() => undefined);
          const art = launchArtUrl(answer.campaign);
          if (art && typeof Image !== 'undefined') {
            const img = new Image();
            img.referrerPolicy = 'no-referrer';
            img.src = art;
          }
        }
        setClaim(answer);
      });
    // No cleanup: the claim is the page's, once; a re-render never asks again.
  }, [ready, eligible, claim, claimWaitMs]);

  // A page that stays open for days (the Inbox): a claim that said no asks again the next time the gates hold.
  useEffect(() => {
    if (!firstRunWindow && !eligible && (claim === 'no' || claim === 'late')) setClaim('idle');
  }, [firstRunWindow, eligible, claim]);

  const due = typeof claim === 'object' ? claim : null;
  const mayOpen = due !== null && eligible && !blocked && stamp === 'none';
  const windowOpen = useFirstRunAnnouncementWindow({
    // Pending from the start, so the reader's first move before the claim answers still closes the window.
    pending: firstRunWindow && claim !== 'no' && claim !== 'late',
    armed: ready,
    eligible: firstRunWindow && mayOpen,
  });
  const opensNow = mayOpen && (firstRunWindow ? windowOpen : true);

  // Stamp it, then draw it on `{ show: true }` (another surface or tab may have shown it first).
  useEffect(() => {
    if (!opensNow || !due) return;
    setStamp('asking');
    api.current
      .shown(due.campaign)
      .then((answer) => setStamp(answer?.show === true ? 'shown' : 'refused'), () => setStamp('refused'));
  }, [opensNow, due]);

  const drawn = stamp === 'shown';
  useEffect(() => {
    if (drawn) drawnRef.current?.();
  }, [drawn]);

  const waiting = eligible && (claim === 'idle' || claim === 'asking');
  const takes = due !== null && eligible && stamp !== 'refused';
  const holds = waiting || takes || drawn;
  const open = drawn && !closed;

  const dialog =
    open && due ? (
      <Suspense fallback={null}>
        <LazyLaunchDialog
          campaign={due.campaign}
          url={due.url}
          onAnswer={(answer) => {
            setClosed(true);
            void api.current.answer(answer, due.campaign);
          }}
        />
      </Suspense>
    ) : null;

  return { holds, shownThisLoad: drawn, open, dialog };
}
