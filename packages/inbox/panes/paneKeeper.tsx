/**
 * Every pane's thread stays mounted while the layout changes: a narrow window, a file opening beside the active pane,
 * the window going to one pane (a phone, a stacked window, a card's or Reviews' thread, a file full screen) and back.
 * Losing the person's work is the worst failure the Inbox can have, and a pane that mounts again loses its scroll,
 * its folds, an open reply box and a recording in progress.
 *
 * So each pane draws once, into a node of its own (a portal, ThreadPanes.tsx), and a layout only says where that node
 * is: in its place in the free layout, in today's one slot, or nowhere: off the page, still mounted. Moving a node
 * keeps everything React holds. What the browser drops with a box taken off the page, its scroll offsets and focus,
 * is put back each time the node is put on the page again.
 *
 * The node also hears what the engine's own pane handlers no longer can (React events follow the portal, not the
 * page): a press or focus in a pane makes it the active one, and a press on its header may pick it up.
 */
import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import { pressToDrag } from './paneDrag';
import type { PaneId } from './layoutModel';

/** What a press on a pane's header can start a drag from: its empty part and its title, never a control. */
const CONTROL = 'button, a, input, textarea, select, [role="menuitem"], [role="button"], [contenteditable="true"]';
/** A recording in progress (VoiceMic.tsx): the mic lit while it opens or listens. */
const RECORDING = '[data-voice-mic][data-state="live"]';

export interface KeeperLive {
  active: PaneId | null;
  onFocus: (id: PaneId) => void;
  /** The panes draw in the free layout: a header press may pick one up. */
  engine: boolean;
  title: (id: PaneId) => string;
}

export interface PaneKeeper {
  /** The pane's node, made the first time it is asked for. */
  nodeOf: (id: PaneId) => HTMLElement;
  /** Put the pane on the page in `host`: its scroll offsets and focus come back. */
  dock: (id: PaneId, host: HTMLElement) => void;
  /** Take the pane off `host` (still mounted, off the page). */
  undock: (id: PaneId, host: HTMLElement) => void;
  /** Forget every pane but these: their nodes go. */
  keep: (ids: ReadonlySet<PaneId>) => void;
  /** A recording is in progress in the pane. */
  recording: (id: PaneId) => boolean;
  live: { current: KeeperLive };
}

interface Kept {
  node: HTMLElement;
  /** Each scrolled box's offsets, as last scrolled: a box taken off the page forgets its own. */
  scrolls: Map<Element, [number, number]>;
  /** Where focus was in the pane when it went off the page. */
  focus: HTMLElement | null;
}

export function createPaneKeeper(): PaneKeeper {
  const kept = new Map<PaneId, Kept>();
  const live: { current: KeeperLive } = { current: { active: null, onFocus: () => {}, engine: false, title: () => 'Thread' } };
  // Off the page: a node no host holds sits here (never in the document).
  const park = typeof document === 'undefined' ? null : document.createElement('div');

  const make = (id: PaneId): Kept => {
    const node = document.createElement('div');
    node.className = 'ib-panedock';
    node.setAttribute('data-pane-dock', id);
    const entry: Kept = { node, scrolls: new Map(), focus: null };
    node.addEventListener(
      'scroll',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        entry.scrolls.set(target, [target.scrollTop, target.scrollLeft]);
        if (entry.scrolls.size > 64) for (const el of entry.scrolls.keys()) if (!node.contains(el)) entry.scrolls.delete(el);
      },
      true,
    );
    const activate = () => {
      if (live.current.active !== id) live.current.onFocus(id);
    };
    node.addEventListener('focusin', activate);
    node.addEventListener('pointerdown', (event) => {
      activate();
      if (!live.current.engine || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const head = target?.closest('.ib-phead');
      const host = node.closest<HTMLElement>('[data-layout-pane]');
      if (!head || !host || !node.contains(head) || target!.closest(CONTROL)) return;
      pressToDrag({
        event,
        payload: { kind: 'pane', paneId: id, label: live.current.title(id) },
        onBegin: () => host.setAttribute('data-pane-dragging', ''),
        onEnd: () => host.removeAttribute('data-pane-dragging'),
      });
    });
    park?.appendChild(node);
    kept.set(id, entry);
    return entry;
  };
  const entryOf = (id: PaneId) => kept.get(id) ?? make(id);

  return {
    nodeOf: (id) => entryOf(id).node,
    dock(id, host) {
      const entry = entryOf(id);
      const { node } = entry;
      if (node.parentNode === host) return;
      const focused = node.isConnected && document.activeElement instanceof HTMLElement && node.contains(document.activeElement) ? document.activeElement : entry.focus;
      entry.focus = null;
      host.appendChild(node);
      for (const [el, [top, left]] of entry.scrolls) {
        if (!node.contains(el)) {
          entry.scrolls.delete(el);
          continue;
        }
        if (el.scrollTop !== top) el.scrollTop = top;
        if (el.scrollLeft !== left) el.scrollLeft = left;
      }
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (focused && lost && node.contains(focused)) focused.focus({ preventScroll: true });
    },
    undock(id, host) {
      const entry = kept.get(id);
      if (!entry || entry.node.parentNode !== host) return;
      entry.focus = document.activeElement instanceof HTMLElement && entry.node.contains(document.activeElement) ? document.activeElement : null;
      park?.appendChild(entry.node);
    },
    keep(ids) {
      for (const [id, entry] of kept) {
        if (ids.has(id)) continue;
        entry.node.remove();
        kept.delete(id);
      }
    },
    recording: (id) => !!kept.get(id)?.node.querySelector(RECORDING),
    live,
  };
}

export const PaneKeeperContext = createContext<PaneKeeper | null>(null);

/** Where pane `paneId` shows: its node is put here while this is drawn, and taken off the page when it is not. */
export function PaneDock({ paneId }: { paneId: PaneId }) {
  const keeper = useContext(PaneKeeperContext)!;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current!;
    keeper.dock(paneId, host);
    return () => keeper.undock(paneId, host);
  }, [keeper, paneId]);
  return <div ref={ref} className="ib-panehost" />;
}
