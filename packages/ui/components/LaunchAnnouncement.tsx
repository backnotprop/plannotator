/**
 * When the launch dialog shows (the launch switch, packages/shared/launch-switch.ts; the dialog, LaunchDialog.tsx).
 * Plannotator's plan review, code review, annotate and the Inbox call `useLaunchAnnouncement`; a host that does not
 * (the Workspaces app) never shows it.
 *
 *  - Claim: once the page has loaded and the host's gates hold (`ready`, `eligible`), the server answers from its kept
 *    copy only: `{ show: false }` or `{ show: true, campaign, url }`. Nothing is used up. The page never waits on it: a
 *    claim with no answer in LAUNCH_CLAIM_WAIT_MS counts as no for this load where the first-run window applies (the
 *    Inbox, which has none, still takes a late yes).
 *  - Ready: on a yes, the dialog's code and its art load (never before: nothing here delays the page). The art may take
 *    up to LAUNCH_ART_WAIT_MS; the dialog then opens with the art, or with its words alone, decided before it opens,
 *    so its layout never changes while it is read. Code that cannot load: nothing shows, nothing is stamped, and the
 *    page is untouched (the dialog sits in its own LazyBlockBoundary, so no failure of it reaches the page's boundary).
 *  - Open: with `firstRunWindow` (plan review, code review, annotate) only as the page opens, before the reader starts
 *    working (useFirstRunAnnouncementWindow); without it (the Inbox) as soon as the host allows. A claim older than
 *    LAUNCH_RECLAIM_AFTER_MS is asked again first (another surface may have shown it meanwhile).
 *  - Shown: once the dialog has painted, `shown` stamps it on this computer (a compare-and-set across every surface).
 *    `{ show: false }` (another surface stamped it at the same moment) closes it and lets the others go on; an error
 *    leaves it open.
 *  - Answer: `opened` ("See the launch") or `dismissed` (Not now, Escape, the backdrop). Either way it
 *    never shows again for that campaign.
 *
 * `holds`: the other one-time dialogs of this load yield while it is true, so only one dialog appears: while the claim
 * is out, while it says this load is the launch's, and for the rest of a load that showed it.
 */
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useFirstRunAnnouncementWindow } from '../hooks/useFirstRunAnnouncementWindow';
import { LAUNCH_ART_WAIT_MS, launchArtUrl } from '../utils/launchDialogWords';
import { LazyBlockBoundary } from './LazyBlockBoundary';
import type { LaunchDialogAnswer, LaunchDialogProps } from './LaunchDialog';

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
/** A yes older than this is asked again right before the dialog opens. */
export const LAUNCH_RECLAIM_AFTER_MS = 10_000;

type DialogComponent = ComponentType<LaunchDialogProps>;

/** The dialog's own file, loaded once a claim says yes; a failure is forgotten, so the next load asks again. */
let loadedDialog: DialogComponent | null = null;
let loadingDialog: Promise<DialogComponent> | null = null;
export function loadLaunchDialog(): Promise<DialogComponent> {
  if (loadedDialog) return Promise.resolve(loadedDialog);
  return (loadingDialog ??= import('./LaunchDialog').then(
    (mod) => (loadedDialog = mod.LaunchDialog),
    (cause: unknown) => {
      loadingDialog = null;
      throw cause;
    },
  ));
}

/** The art, preloaded: true once it has loaded (and decoded) within `waitMs`, false when it fails or is slower. */
export function preloadLaunchArt(src: string, waitMs: number = LAUNCH_ART_WAIT_MS): Promise<boolean> {
  if (typeof Image === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const end = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => end(false), waitMs);
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      // Decoded before it is used, so the band paints with its picture in the first frame.
      if (typeof img.decode === 'function') img.decode().then(() => end(true), () => end(true));
      else end(true);
    };
    img.onerror = () => end(false);
    img.src = src;
  });
}

/** A claim the page can act on: a campaign and an https launch link (the server's parser already checked both). */
function usable(claim: unknown): claim is Extract<LaunchClaim, { show: true }> {
  if (!claim || typeof claim !== 'object') return false;
  const c = claim as Record<string, unknown>;
  return c.show === true && typeof c.campaign === 'string' && launchArtUrl(c.campaign) !== null && typeof c.url === 'string' && c.url.startsWith('https://');
}

export interface LaunchAnnouncementInput {
  /** The page has loaded (the claim, and the first-run window's clock, wait for it). */
  ready: boolean;
  /** The host's gates hold now (a live session, not shared, archive or read-only, …). The VS Code panel shows it too. */
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
  /** Tests: the dialog's file and the art. */
  loadDialog?: () => Promise<DialogComponent>;
  loadArt?: (src: string) => Promise<boolean>;
  reclaimAfterMs?: number;
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

type Yes = Extract<LaunchClaim, { show: true }> & { at: number };
type ClaimState = 'idle' | 'asking' | 'no' | 'late' | Yes;
type Prep = 'none' | 'loading' | 'failed' | { Dialog: DialogComponent; art: boolean };
type Stage = 'none' | 'reclaiming' | 'drawn' | 'refused' | 'failed';

/** Runs `run` once, after the browser painted what was committed with it. */
function AfterPaint({ run }: { run: () => void }) {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(run, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(run, 0));
  }, [run]);
  return null;
}

export function useLaunchAnnouncement({
  ready,
  eligible,
  firstRunWindow,
  blocked = false,
  onDrawn,
  client = launchHttpClient,
  claimWaitMs = LAUNCH_CLAIM_WAIT_MS,
  loadDialog = loadLaunchDialog,
  loadArt = preloadLaunchArt,
  reclaimAfterMs = LAUNCH_RECLAIM_AFTER_MS,
}: LaunchAnnouncementInput): LaunchAnnouncement {
  // The VS Code panel shows it too (the owner, 2026-11-25): its art loads from the site as anywhere, and the
  // panel's link bridge (apps/vscode-extension cookie-proxy.ts) opens "See the launch" in the browser.
  const [claim, setClaim] = useState<ClaimState>('idle');
  const [prep, setPrep] = useState<Prep>('none');
  const [stage, setStage] = useState<Stage>('none');
  const [closed, setClosed] = useState(false);
  const api = useRef(client);
  api.current = client;
  const drawnRef = useRef(onDrawn);
  drawnRef.current = onDrawn;
  const loaders = useRef({ loadDialog, loadArt });
  loaders.current = { loadDialog, loadArt };
  const stamped = useRef(false);

  // The claim: once, when the page is ready and the gates hold. Past the wait, a yes is ignored where the first-run
  // window applies; the Inbox takes it whenever it comes.
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
        const wasLate = settled;
        settled = true;
        clearTimeout(late);
        if (wasLate && (firstRunWindow || answer === 'no')) return;
        setClaim(answer === 'no' ? 'no' : { show: true, campaign: answer.campaign, url: answer.url, at: Date.now() });
      });
    // No cleanup: the claim is the page's, once; a re-render never asks again.
  }, [ready, eligible, claim, claimWaitMs, firstRunWindow]);

  // A page that stays open for days (the Inbox): a claim that said no asks again the next time the gates hold.
  useEffect(() => {
    if (!firstRunWindow && !eligible && (claim === 'no' || claim === 'late')) setClaim('idle');
  }, [firstRunWindow, eligible, claim]);

  const due = typeof claim === 'object' ? claim : null;

  // On a yes: the dialog's code and its art, both settled before it may open.
  const campaign = due?.campaign ?? null;
  useEffect(() => {
    if (campaign === null || prep !== 'none') return;
    setPrep('loading');
    const art = launchArtUrl(campaign);
    void Promise.all([
      loaders.current.loadDialog(),
      art ? loaders.current.loadArt(art).catch(() => false) : Promise.resolve(false),
    ]).then(
      ([Dialog, artIn]) => setPrep({ Dialog, art: artIn }),
      () => setPrep('failed'),
    );
  }, [campaign, prep]);

  const prepared = typeof prep === 'object' ? prep : null;
  // Only while the page is still ready: a gate that closed after the claim (another dialog drew meanwhile) holds it.
  const mayOpen = ready && due !== null && prepared !== null && eligible && !blocked && stage === 'none';
  const windowOpen = useFirstRunAnnouncementWindow({
    // Pending from the start, so the reader's first move before the claim answers still closes the window.
    pending: firstRunWindow && claim !== 'no' && claim !== 'late' && prep !== 'failed',
    armed: ready,
    eligible: firstRunWindow && mayOpen,
  });
  const opensNow = mayOpen && (firstRunWindow ? windowOpen : true);

  // Open it; a yes that has waited long is asked again first.
  useEffect(() => {
    if (!opensNow || !due) return;
    if (Date.now() - due.at < reclaimAfterMs) {
      setStage('drawn');
      return;
    }
    setStage('reclaiming');
    api.current.claim().then(
      (answer) => setStage(usable(answer) && answer.campaign === due.campaign ? 'drawn' : 'refused'),
      () => setStage('refused'),
    );
  }, [opensNow, due, reclaimAfterMs]);

  const drawn = stage === 'drawn';
  useEffect(() => {
    if (drawn) drawnRef.current?.();
  }, [drawn]);

  // Painted: stamp it. Another surface that stamped it at the same moment keeps it, and this one closes.
  const stampNow = useRef(() => {});
  stampNow.current = () => {
    if (stamped.current || !due) return;
    stamped.current = true;
    api.current.shown(due.campaign).then(
      (answer) => {
        if (answer?.show === false) setStage('refused');
      },
      () => undefined,
    );
  };
  const afterPaint = useRef(() => stampNow.current());

  const waiting = eligible && (claim === 'idle' || claim === 'asking');
  const takes = due !== null && eligible && prep !== 'failed' && stage !== 'refused' && stage !== 'failed';
  const holds = waiting || takes || drawn;
  const open = drawn && !closed;

  const Dialog = prepared?.Dialog;
  const dialog =
    open && due && Dialog ? (
      <LazyBlockBoundary fallback={() => <AfterPaint run={() => setStage('failed')} />}>
        <Dialog
          campaign={due.campaign}
          url={due.url}
          art={prepared.art}
          onAnswer={(answer) => {
            setClosed(true);
            void api.current.answer(answer, due.campaign);
          }}
        />
        <AfterPaint run={afterPaint.current} />
      </LazyBlockBoundary>
    ) : null;

  return { holds, shownThisLoad: drawn, open, dialog };
}
