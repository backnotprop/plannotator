/**
 * The Sidebar tip (the owner, 2026-11-09: "the same thing we did for … launch new agents … you can customize the
 * sidebar … a little popover thing, arrow point into it"): a one-time card beside the sidebar, its arrow pointing
 * into it, that says the sidebar can be customized. The Launch tip's sibling (compose/launchTip.ts): the same card,
 * the same words' shape, the same "seen once" kept by the Inbox (packages/shared/inbox/sidebar-tip.ts, settings
 * `reveal.sidebar_tip`, the claim `POST /api/inbox/reveal` `id: "sidebar_tip"`). The rules the window keeps:
 *
 *  - A desktop only, while the sidebar is docked open on the Inbox page. A phone's sidebar is a sheet the calm moment
 *    never finds open, and a phone has no right-click, so a phone neither shows nor claims it.
 *  - At the reveals' calm moment (reveal.ts `useRevealMoment`, the star ask's): a thread read and left, or the page
 *    idle; 60 s into the page; the list loaded and not the first-run screen; nothing typed or open, no toast.
 *  - Never with another one-time dialog or tip, nor within the Inbox's 40-minute gap of one (settings report it due
 *    only outside the gap, and its claim starts the gap: packages/server/inbox.ts `tipFree`); never on a load with
 *    the tour or an update. It lets every other reveal go first: it waits `yieldMs` at its moment and stands down,
 *    unclaimed, when one of them took it. Once it is up the others hold back for the gap (`noteOneTimeDialogShown`,
 *    `REVEAL_TIMES.otherDialogMs`), not for the rest of the load: a tab left open still gets the next dialog after it.
 *  - It leaves on Got it, Escape (only the tip closes), a right-click on the sidebar (its menu is what the tip is
 *    about), the Customize panel opening, or the sidebar going away (closed, another page, something over it). No timer.
 *  - Focus never moves to it; the window's polite region says it once. No new keyboard shortcuts, no ring on the sidebar.
 */
import { useEffect, useRef } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { SettingsModel } from './api';
import { REVEAL_TIMES, claimRevealOnce, noteOneTimeDialogShown, oneTimeDialogShownThisLoad, starRevealLeaveCounts, useRevealMoment } from './reveal';
import { newUuid } from './uuid';

export const SIDEBAR_TIP_WORDS = {
  eyebrow: 'New',
  title: 'Make the sidebar yours',
  line: 'Hide what you don’t use and reorder the rest. Right-click the sidebar to start.',
  ok: 'Got it',
} as const;

/** What a screen reader hears once, through the window's polite region. */
export const SIDEBAR_TIP_SAID = `${SIDEBAR_TIP_WORDS.eyebrow}: ${SIDEBAR_TIP_WORDS.title}. ${SIDEBAR_TIP_WORDS.line}`;

/** The card's timings, ms. A test shrinks them (and puts them back). */
export const SIDEBAR_TIP_TIMES = {
  /** At its moment it waits this long, so any other reveal that shares the moment claims first. */
  yieldMs: 800,
  /** The way out (a 120 ms fade), then it is gone from the DOM. */
  leaveMs: 130,
};

/** The card's width (inbox.css `.ib-ctip`), its gap from the sidebar's edge (the arrow spans it) and from the window's. */
export const SIDEBAR_TIP_WIDTH = 284;
const GAP = 8;
const EDGE = 8;
/** The arrow's centre, from the card's top, when nothing clamps the card. */
const ARROW_Y = 26;
/** The arrow stays this far inside the card's corners. */
const ARROW_INSET = 16;

/** The Inbox has the tip for this page: the owner's page (never a guest's) on an Inbox that reports it due. */
export function sidebarTipDue(settings: Pick<SettingsModel, 'guest' | 'reveal'> | null | undefined): boolean {
  return !!settings && settings.guest !== true && settings.reveal?.sidebar_tip === true;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

export interface SidebarTipPlace {
  /** From the window's top-left (the card is `position: fixed`). */
  top: number;
  left: number;
  /** The arrow's centre, from the card's top. */
  arrow: number;
}

/**
 * Where the card stands: right of the sidebar, its arrow on the sidebar's edge, level with `row` (the Inbox row, which
 * never hides). A short window keeps the whole card on screen and moves the arrow along it instead. Null when the
 * window has no room beside the sidebar for the card: it does not show.
 */
export function sidebarTipPlace(input: { viewportWidth: number; viewportHeight: number; sidebar: Box; row: Box | null; cardHeight: number }): SidebarTipPlace | null {
  const { viewportWidth, viewportHeight, sidebar, cardHeight } = input;
  const left = Math.round(sidebar.right + GAP);
  if (left + SIDEBAR_TIP_WIDTH + EDGE > viewportWidth) return null;
  const row = input.row ?? { ...sidebar, top: sidebar.top + 60, bottom: sidebar.top + 92, height: 32 };
  const aim = row.top + row.height / 2;
  const top = Math.round(Math.max(EDGE, Math.min(aim - ARROW_Y, viewportHeight - cardHeight - EDGE)));
  const arrow = Math.round(Math.max(ARROW_INSET, Math.min(aim - top, cardHeight - ARROW_INSET)));
  return { top, left, arrow };
}

/** The sidebar on the page and the row the arrow aims at (Inbox, which never hides), or null when no sidebar is drawn. */
export function sidebarTipTarget(root: ParentNode = document): { sidebar: HTMLElement; row: HTMLElement | null } | null {
  const sidebar = root.querySelector<HTMLElement>('aside.ib-side');
  return sidebar ? { sidebar, row: sidebar.querySelector<HTMLElement>('[data-inbox-nav]') } : null;
}

export interface SidebarTipInput {
  /** The Inbox has it for this page (`sidebarTipDue`), on a desktop. */
  due: boolean;
  /** Another one-time dialog, tip or the tour is on this load, or another reveal is claiming or open now. */
  blocked: boolean;
  /** The sidebar is docked open on the Inbox page. */
  sidebar: boolean;
  listLoaded: boolean;
  firstRun: boolean;
  /** The thread open now (the route's), or null. */
  thread: string | null;
  rows: readonly InboxListRow[];
  /** The Inbox page with nothing over it (listIntro.ts `listIntroPageClear`). */
  clear: boolean;
  place: string;
  /** Something typed or open over the page, or a question waiting in the open thread. */
  heldBack: () => boolean;
  toast: boolean;
  /** The page is idle (idleClock.ts). */
  idle: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The tip's moment and claim. `stage: 'open'`: the card is up. A moment another reveal took, or one that stayed held
 * back for its whole length, spends nothing: the Inbox still has the tip, and the next load tries again.
 */
export function useSidebarTip(input: SidebarTipInput) {
  const latest = useRef(input);
  latest.current = input;
  const key = useRef<string | null>(null);
  const free = () => {
    const now = latest.current;
    return now.clear && now.sidebar && !now.toast && !now.heldBack();
  };
  const moment = useRevealMoment({
    wanted: input.due && !input.blocked,
    thread: input.thread,
    rows: input.rows,
    clear: input.clear && input.sidebar,
    place: input.place,
    heldBack: input.heldBack,
    toast: input.toast,
    leaveCounts: (visit, now) => starRevealLeaveCounts(visit, now),
    idle: input.idle,
    mayClaim: (pageAge) => {
      const now = latest.current;
      return now.due && !now.blocked && now.sidebar && now.listLoaded && !now.firstRun && pageAge >= REVEAL_TIMES.pageAgeMs;
    },
    holds: () => true,
    claim: async () => {
      // Every other reveal first: one that shares this moment has claimed by now, and the tip stands down unclaimed.
      await sleep(SIDEBAR_TIP_TIMES.yieldMs);
      for (let waited = 0; ; waited += REVEAL_TIMES.recheckMs) {
        if (latest.current.blocked || oneTimeDialogShownThisLoad() || !latest.current.due) return false;
        if (free()) break;
        if (waited >= REVEAL_TIMES.momentMs) return false;
        await sleep(REVEAL_TIMES.recheckMs);
      }
      // From here the other reveals hold back for the gap: nothing opens over the tip, and the Inbox refuses them too.
      noteOneTimeDialogShown();
      key.current ??= newUuid();
      return (await claimRevealOnce('sidebar_tip', key.current)).show;
    },
  });
  // Unmounted while it waits: the pending claim finds nothing due.
  useEffect(
    () => () => {
      latest.current = { ...latest.current, due: false };
    },
    [],
  );
  return moment;
}
