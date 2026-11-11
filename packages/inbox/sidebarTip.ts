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

export const SIDEBAR_TIP_SAID = `${SIDEBAR_TIP_WORDS.eyebrow}: ${SIDEBAR_TIP_WORDS.title}. ${SIDEBAR_TIP_WORDS.line}`;

export const SIDEBAR_TIP_TIMES = {
  yieldMs: 800,
  leaveMs: 130,
};

export const SIDEBAR_TIP_WIDTH = 284;
const GAP = 8;
const EDGE = 8;
const ARROW_Y = 26;
const ARROW_INSET = 16;

export function sidebarTipDue(settings: Pick<SettingsModel, 'guest' | 'reveal'> | null | undefined): boolean {
  return !!settings && settings.guest !== true && settings.reveal?.sidebar_tip === true;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

export interface SidebarTipPlace {
  top: number;
  left: number;
  arrow: number;
}

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

export function sidebarTipTarget(root: ParentNode = document): { sidebar: HTMLElement; row: HTMLElement | null } | null {
  const sidebar = root.querySelector<HTMLElement>('aside.ib-side');
  return sidebar ? { sidebar, row: sidebar.querySelector<HTMLElement>('[data-inbox-nav]') } : null;
}

export interface SidebarTipInput {
  due: boolean;
  blocked: boolean;
  sidebar: boolean;
  listLoaded: boolean;
  firstRun: boolean;
  thread: string | null;
  rows: readonly InboxListRow[];
  clear: boolean;
  place: string;
  heldBack: () => boolean;
  toast: boolean;
  idle: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  useEffect(
    () => () => {
      latest.current = { ...latest.current, due: false };
    },
    [],
  );
  return moment;
}
