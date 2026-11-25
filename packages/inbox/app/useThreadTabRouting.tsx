import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { ListModel } from '@plannotator/core/inbox-wire-models';
import type { SettingsModel } from '../api';
import { AnchoredLine } from '../components/NotificationAsk';
import { rowAgent, slotSession, titleOf } from '../components/rowParts';
import { inboxLinkHash } from '../links';
import { setRowClickGate } from '../starPress';
import { inboxTabCount, setAppBadge, useTabCount, useThreadTabIcon } from '../tabCount';
import { excludedFromCounts, focusOpener, focusThreadTab, isThreadTabClick, openThreadTab, routeClick } from '../threadTabs';
import { useThreadFaceSrc } from '../threadFace';
import { useThreadTabs } from '../useThreadTabs';
import { routeOf, type Route } from './route';
import { hashOf, writeRoute } from './writeRoute';

type ClickEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'button' | 'preventDefault' | 'stopPropagation'>;

/**
 * Thread tabs in the Inbox window (threadTabs.ts): with the capability on, `#thread=<id>&alone` makes this window a
 * thread tab. It joins the tab channel, writes the tab's count, title and icon (a main tab leaves out the threads that
 * have a thread tab, unless Settings puts them back; a thread tab shows its own thread), and answers a click on a
 * thread or on a link into this Inbox.
 */
export function useThreadTabRouting({ settings, route, routeRef, sections, heldTitle, faviconHref, faviconBadgeHref }: {
  settings: SettingsModel | null;
  route: Route;
  routeRef: MutableRefObject<Route>;
  sections: ListModel['sections'] | null;
  /** The title to give a thread tab while its row is not in the list read. */
  heldTitle: string;
  faviconHref: string | null;
  faviconBadgeHref: string | null;
}) {
  const on = settings?.thread_tabs?.on === true;
  const countAnchored = settings?.thread_tabs?.count_anchored === true;
  const aloneThread = on && route.page === 'inbox' && route.alone === true && route.thread ? route.thread : null;
  const { anchored, requestOpen } = useThreadTabs(on, aloneThread, (hash) => {
    writeRoute(routeOf(hash));
    window.focus();
  });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // The tab's count (tabCount.ts): every thread with news the person has not looked at, from the latest read (not the
  // held list on screen, and not the sidebar's project filter).
  const tabCount = useMemo(() => (sections ? inboxTabCount(sections, excludedFromCounts(anchored, countAnchored)) : 0), [sections, anchored, countAnchored]);
  useTabCount(tabCount, faviconHref, faviconBadgeHref, aloneThread === null);
  const aloneRow = aloneThread && sections ? (sections.flatMap((section) => section.threads).find((row) => row.thread_id === aloneThread) ?? null) : null;
  const aloneAgent = aloneRow ? rowAgent(aloneRow) : null;
  const aloneFace = useThreadFaceSrc(aloneRow ? (slotSession(aloneRow) ?? null) : null, aloneAgent?.kind === 'agent' ? aloneAgent.host : null);
  useThreadTabIcon(aloneThread !== null, (aloneRow ? titleOf(aloneRow) : heldTitle).trim() || 'Plannotator Inbox', aloneFace, aloneRow?.questions.open ?? 0, (aloneRow?.unseen ?? 0) > 0, faviconHref, faviconBadgeHref);
  // The installed app's badge is shared by every window: only a main tab that has read a list writes it.
  useEffect(() => {
    if (sections && aloneThread === null) setAppBadge(tabCount);
  }, [sections, tabCount, aloneThread]);

  const [anchoredBanner, setAnchoredBanner] = useState<{ thread: string; open: () => void } | null>(null);
  const clickState = useRef({ enabled: false, aloneThread: null as string | null, anchored: new Set<string>() as ReadonlySet<string>, requestOpen });
  clickState.current = { enabled: on, aloneThread, anchored, requestOpen };
  const threadClick = useCallback((event: ClickEvent, thread: string | null, hash: string | null, open: () => void): boolean => {
    const state = clickState.current;
    const action = routeClick({ enabled: state.enabled, role: state.aloneThread ? { kind: 'thread', thread: state.aloneThread } : { kind: 'main' }, anchored: state.anchored, thread, modified: isThreadTabClick(event) });
    if (action === 'default') return false;
    event.preventDefault();
    event.stopPropagation();
    const base = window.location.href.split('#')[0]!;
    if (action === 'open-alone' && thread) openThreadTab(base + hashOf({ page: 'inbox', project: null, thread, alone: true }), thread);
    else if (action === 'focus-anchored' && thread) {
      if (!focusThreadTab(thread)) setAnchoredBanner({ thread, open });
    } else if (action === 'ask-main') {
      const target = hash ?? (thread ? hashOf({ page: 'inbox', project: null, thread }) : '');
      const url = base + (target.startsWith('#') || target === '' ? target : `#${target}`);
      state.requestOpen(target, () => void window.open(url));
      focusOpener();
    }
    return true;
  }, []);
  useEffect(() => {
    setRowClickGate(on ? (event, thread, open) => threadClick(event, thread, null, open) : null);
    return () => setRowClickGate(null);
  }, [on, threadClick]);
  /** A click on a link into this Inbox (`href`): true when thread tabs took it. */
  const linkClick = useCallback(
    (event: ClickEvent, href: string, open: () => void): boolean => {
      const now = settingsRef.current;
      const hash = inboxLinkHash(href, { origin: window.location.origin, addresses: [now?.url, now?.tailscale?.url] });
      return hash !== null && threadClick(event, routeOf(hash).thread, hash, open);
    },
    [threadClick],
  );

  const banner: ReactNode = anchoredBanner ? (
    <AnchoredLine
      onOpenHere={() => {
        anchoredBanner.open();
        setAnchoredBanner(null);
      }}
      onDismiss={() => setAnchoredBanner(null)}
    />
  ) : null;
  /** A thread tab's way out of full screen is "Show full Inbox": the same address without `&alone`, in place. True: it left. */
  const leaveAlone = (): boolean => {
    if (aloneThread === null) return false;
    writeRoute({ ...routeRef.current, alone: false }, { replace: true });
    return true;
  };
  return { aloneThread, anchored, notify: on ? { alone: aloneThread, anchored } : undefined, linkClick, banner, leaveAlone };
}
