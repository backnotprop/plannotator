import type { RefObject } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { Route } from '../app/route';
import { drawnSection } from '../held';
import type { ThreadSlotHost } from '../thread/slotHost';
import type { PaneId } from './layoutModel';

/** The window's host, and the row of any thread (a pane that is not the active one draws its own thread's row). */
export interface ThreadPanesHost extends ThreadSlotHost {
  rowOf: (threadId: string) => InboxListRow | null;
}

/** The address a pane's own links start from: the window's list and filters, with that pane's thread and nothing open in it. */
export function paneRoute(route: Route, thread: string | null): Route {
  return { page: 'inbox', project: route.project ?? null, machine: route.machine ?? null, agent: route.agent ?? null, tag: route.tag ?? null, thread };
}

/** A pane that is not the active one: its own address and row, with no file, card, guide or snooze of the active pane's. */
export function quietHost(host: ThreadPanesHost, thread: string | null): ThreadSlotHost {
  const route = paneRoute(host.route, thread);
  return { ...host, route, routeRef: { current: route }, fileOpen: false, fromCard: null, openThreadRow: thread ? host.rowOf(thread) : null, snoozeBack: null };
}

/**
 * Beside other panes: the pane's ✕ closes this pane, not the thread under all of them. The way back to the list when
 * it is hidden (full screen's ‹ Inbox) leads the top-left pane only, where the list was.
 */
export function withPaneClose(host: ThreadSlotHost, id: PaneId, closePane: (id: PaneId) => void, first: boolean): ThreadSlotHost {
  const close = (next: Route) => (next.page === 'inbox' && next.thread === null ? closePane(id) : host.close(next));
  return first ? { ...host, paired: true, close } : { ...host, full: false, stack: { ...host.stack, thread: false }, paired: true, close };
}

/**
 * What a pane that is not the active one draws from the window: it draws again only when one of these changes (or
 * its own thread does, which it reads itself). Everything else it takes from the window when it draws (`liveHost`),
 * so an agent's message in another thread, a list refresh or a keystroke in the active pane's reply box draws none
 * of the other panes.
 */
export function quietDigest(host: ThreadSlotHost, paneId: PaneId, thread: string | null): readonly unknown[] {
  const { route } = host;
  return [
    thread, route.project, route.machine, route.agent, route.tag, host.openThreadRow, host.rowPatches.get(thread ?? ''), host.paired, host.full, host.stack.thread,
    host.phone, host.covered, host.rowsPending, host.settings, host.machines, host.outbox, host.pinnedIds, host.pinsOn, host.snoozeOn, host.soundOn,
    host.boardEnabled, host.boardsOn, host.cards, host.pullsShown, host.reviewView, host.threadAgentContext, host.listTitle, host.fullSidebar,
    host.paneReads.view(paneId), thread ? drawnSection(host.shown, thread) : null, host.replyFor === thread, host.notifyAgainIn === thread,
    host.askReply?.threadId === thread ? host.askReply : null, host.shapeReply?.threadId === thread ? host.shapeReply : null,
  ];
}

export const sameDigest = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/** A host that reads the window's latest on every use, its actions stable across draws. */
export function liveHost(ref: RefObject<ThreadSlotHost>): ThreadSlotHost {
  const actions = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy({} as ThreadSlotHost, {
    get(_, key) {
      const value = (ref.current as unknown as Record<PropertyKey, unknown>)[key];
      if (typeof value !== 'function') return value;
      let action = actions.get(key);
      if (!action) {
        action = (...args: unknown[]) => ((ref.current as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>)[key]!)(...args);
        actions.set(key, action);
      }
      return action;
    },
  });
}
