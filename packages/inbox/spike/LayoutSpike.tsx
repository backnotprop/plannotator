/**
 * SPIKE (never merged): the Inbox's threads and a file as panes of a free layout, on Pierre's @pierre/layouts
 * (vendored, packages/vendor-pierre-layouts). The list stays App's, fixed at the left. Panes:
 *
 * - `main`: App's own ThreadPane (the open thread, its reply box and keys), portalled in (slot.tsx).
 * - `t~<thread>~<n>`: another thread, read only (ReadOnlyThread.tsx).
 * - `f~<thread>~<file>~<n>`: one file in the thread pane's viewer (FilePane.tsx).
 *
 * A pane has no payload in the engine: its id says what it shows, so a saved layout restores its content too.
 * Rows come in by their menu ("Open in a pane" / "Open as a tab") or by dragging a row onto a pane: the engine takes
 * no drop from outside the layout, so useRowDrag hit-tests the panes itself and calls split or addTab.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LayoutStore, type Edge, type LayoutNode, type PaneNode } from '@plannotator/vendor-pierre-layouts';
import { Layout } from '@plannotator/vendor-pierre-layouts/react';
import '@plannotator/vendor-pierre-layouts/styles.css';
import './spike.css';
import { inboxApi } from '../api';
import { OPEN_IN_PANE_EVENT } from './gate';
import { setMainSlot } from './slot';
import { ReadOnlyThread } from './ReadOnlyThread';
import { FilePane } from './FilePane';

const SAVED_KEY = 'plannotator-inbox-layout-spike';
const PANE = { minWidth: 360, minHeight: 200 } as const;
const MAIN: PaneNode = { type: 'pane', id: 'main', ...PANE };

let serial = 0;
const newId = (...parts: string[]) => `${parts.join('~')}~${Date.now().toString(36)}${(serial++).toString(36)}`;
const threadPane = (threadId: string): PaneNode => ({ type: 'pane', id: newId('t', threadId), ...PANE });
const filePane = (threadId: string, fileId: string): PaneNode => ({ type: 'pane', id: newId('f', threadId, fileId), ...PANE });

type PaneContent = { kind: 'main' } | { kind: 'thread'; threadId: string } | { kind: 'file'; threadId: string; fileId: string };

function contentOf(id: string): PaneContent | null {
  if (id === 'main') return { kind: 'main' };
  const [kind, a, b] = id.split('~');
  if (kind === 't' && a) return { kind: 'thread', threadId: a };
  if (kind === 'f' && a && b) return { kind: 'file', threadId: a, fileId: b };
  return null;
}

function routeThread(): string | null {
  const params = new URLSearchParams(location.hash.slice(1));
  return params.get('thread');
}

function createStore(): { store: LayoutStore; restored: boolean } {
  const store = new LayoutStore(MAIN);
  const saved = localStorage.getItem(SAVED_KEY);
  if (saved) {
    try {
      store.restore(saved);
      return { store, restored: true };
    } catch {
      // A layout from another version of the engine: start again from the main pane.
    }
  }
  return { store, restored: false };
}

function panesOf(node: LayoutNode): PaneNode[] {
  if (node.type === 'pane') return [node];
  return node.children.flatMap(panesOf);
}

/** Replaces one pane's node by another in a copy of the tree (the engine's own nodes everywhere else, so they keep their content). */
function replacePane(node: LayoutNode, id: string, next: PaneNode): LayoutNode {
  if (node.type === 'pane') return node.id === id ? next : node;
  if (node.type === 'stack') return { ...node, active: node.active === id ? next.id : node.active, children: node.children.map((c) => (c.id === id ? next : c)) };
  return { ...node, children: node.children.map((c) => replacePane(c, id, next)) };
}

function useThreadSubject(threadId: string | null): string | null {
  const [subject, setSubject] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (!threadId) return;
    let live = true;
    inboxApi.thread(threadId).then(
      (model) => live && setSubject({ id: threadId, text: model.thread.subject ?? '(no subject)' }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [threadId]);
  return threadId && subject?.id === threadId ? subject.text : null;
}

/** The edge of a pane nearest the pointer, or `center` in its middle (a tab). */
function dropPlace(rect: DOMRect, x: number, y: number): Edge | 'center' {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return 'center';
  const near = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ] as const;
  return near.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

type RowDrag = { threadId: string; label: string; x: number; y: number; target: { id: string; rect: DOMRect; place: Edge | 'center' } | null };

/** A list row dragged onto a pane: pointer events from the row, the pane under the pointer hit-tested here. */
function useRowDrag(root: React.RefObject<HTMLElement | null>, onDrop: (threadId: string, targetId: string, place: Edge | 'center') => void): RowDrag | null {
  const [drag, setDrag] = useState<RowDrag | null>(null);
  const drop = useRef(onDrop);
  drop.current = onDrop;
  useEffect(() => {
    let start: { threadId: string; label: string; x: number; y: number; id: number } | null = null;
    let moving: RowDrag | null = null;
    const targetAt = (x: number, y: number): RowDrag['target'] => {
      const host = document.elementsFromPoint(x, y).find((el): el is HTMLElement => el instanceof HTMLElement && el.matches('[data-layout-pane]') && !!root.current?.contains(el));
      if (!host) return null;
      const rect = host.getBoundingClientRect();
      return { id: host.dataset.layoutPane!, rect, place: dropPlace(rect, x, y) };
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const row = event.target.closest<HTMLElement>('.ib-listcol [data-thread-id]');
      if (!row) return;
      const subject = row.querySelector('.ib-subj, .ib-title');
      start = { threadId: row.dataset.threadId!, label: (subject?.textContent ?? '').trim().slice(0, 60), x: event.clientX, y: event.clientY, id: event.pointerId };
    };
    const onMove = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      if (!moving && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) return;
      event.preventDefault();
      moving = { threadId: start.threadId, label: start.label, x: event.clientX, y: event.clientY, target: targetAt(event.clientX, event.clientY) };
      setDrag(moving);
    };
    const onUp = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      const done = moving;
      start = null;
      moving = null;
      setDrag(null);
      if (!done) return;
      // The row's own click would open the thread in the main pane: this press was a drag.
      window.addEventListener('click', (e) => (e.preventDefault(), e.stopPropagation()), { capture: true, once: true });
      if (done.target) drop.current(done.threadId, done.target.id, done.target.place);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && moving) {
        start = null;
        moving = null;
        setDrag(null);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [root]);
  return drag;
}

export default function LayoutSpike() {
  const [{ store, restored }] = useState(createStore);
  const state = useSyncExternalStore(store.subscribe.bind(store), () => store.getSnapshot(), () => store.getSnapshot());
  const [savedNote, setSavedNote] = useState(restored ? 'Restored the saved layout' : 'Not saved');
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [mainThread, setMainThread] = useState(routeThread);
  const mainSubject = useThreadSubject(mainThread);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onHash = () => setMainThread(routeThread());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openThread = useCallback(
    (threadId: string, targetId: string = store.getSnapshot().focusedPane, place: Edge | 'center' = 'right') => {
      const pane = threadPane(threadId);
      if (place === 'center') store.addTab(targetId, pane);
      else store.split(targetId, pane, place);
      store.focusPane(pane.id);
    },
    [store],
  );
  const openFile = useCallback((threadId: string, fileId: string) => store.split(store.getSnapshot().focusedPane, filePane(threadId, fileId), 'right'), [store]);
  /** The thread goes to the main pane (where its reply box is); the main pane's thread takes this pane's place. */
  const replyHere = useCallback(
    (threadId: string) => {
      const snap = store.getSnapshot();
      const from = panesOf(snap.root).find((p) => contentOf(p.id)?.kind === 'thread' && (contentOf(p.id) as { threadId: string }).threadId === threadId);
      const before = routeThread();
      if (from) store.setRoot(before ? replacePane(snap.root, from.id, threadPane(before)) : snap.root);
      if (from && !before) store.close(from.id);
      location.hash = `thread=${encodeURIComponent(threadId)}`;
      store.focusPane('main');
    },
    [store],
  );

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<string | { threadId: string; tab: boolean }>).detail;
      if (typeof detail === 'string') openThread(detail);
      else openThread(detail.threadId, undefined, detail.tab ? 'center' : 'right');
    };
    window.addEventListener(OPEN_IN_PANE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_IN_PANE_EVENT, onOpen);
  }, [openThread]);

  // A click on a pane's header focuses the engine's host, outside the pane's content. The thread's keys (R, J/K) act
  // only on focus inside ThreadPane or on the page itself, and a read-only pane scrolls only from its body: so focus
  // on a host moves on, to the page for the main pane and into the body for the others.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusIn = (event: FocusEvent) => {
      const host = event.target;
      if (!(host instanceof HTMLElement) || !host.matches('[data-layout-pane]')) return;
      if (host.dataset.layoutPane === 'main') host.blur();
      else host.querySelector<HTMLElement>('.ib-pbody')?.focus({ preventScroll: true });
    };
    root.addEventListener('focusin', onFocusIn);
    return () => root.removeEventListener('focusin', onFocusIn);
  }, []);

  const drag = useRowDrag(rootRef, (threadId, targetId, place) => openThread(threadId, targetId, place));

  const handlers = useRef({ openFile, replyHere, setTitles });
  handlers.current = { openFile, replyHere, setTitles };
  const renderPane = useCallback((pane: PaneNode) => {
    const content = contentOf(pane.id);
    if (content?.kind === 'main') return <div className="spk-main" ref={setMainSlot} data-spike-main="" />;
    if (content?.kind === 'thread') return <ReadOnlyThread threadId={content.threadId} onOpenFile={(t, f) => handlers.current.openFile(t, f)} onReplyHere={(t) => handlers.current.replyHere(t)} onSubject={(s) => handlers.current.setTitles((all) => (all[pane.id] === s ? all : { ...all, [pane.id]: s }))} />;
    if (content?.kind === 'file') return <FilePane threadId={content.threadId} attachmentId={content.fileId} onOpenFile={(t, f) => handlers.current.openFile(t, f)} onName={(s) => handlers.current.setTitles((all) => (all[pane.id] === s ? all : { ...all, [pane.id]: s }))} />;
    return <p className="spk-note">Unknown pane</p>;
  }, []);
  useEffect(() => () => setMainSlot(null), []);

  const titleOf = (pane: PaneNode) => (pane.id === 'main' ? (mainSubject ?? 'Main thread') : (titles[pane.id] ?? 'Opening…'));
  const count = panesOf(state.root).length;

  return (
    <div className="spk-root" ref={rootRef} data-layout-spike="">
      <div className="spk-bar">
        <span className="spk-bar-t">Free layout</span>
        <span className="spk-bar-n">
          {count} {count === 1 ? 'pane' : 'panes'} · {savedNote}
        </span>
        <span className="ib-sp" />
        <button type="button" className="ib-btn" onClick={() => mainThread && openThread(mainThread, state.focusedPane, 'right')} disabled={!mainThread} data-spike-split="right">
          Split right
        </button>
        <button type="button" className="ib-btn" onClick={() => mainThread && openThread(mainThread, state.focusedPane, 'bottom')} disabled={!mainThread} data-spike-split="bottom">
          Split down
        </button>
        <button
          type="button"
          className="ib-btn"
          onClick={() => {
            localStorage.setItem(SAVED_KEY, store.serialize());
            setSavedNote(`Saved at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
          }}
          data-spike-save=""
        >
          Save layout
        </button>
        <button
          type="button"
          className="ib-btn"
          onClick={() => {
            store.setRoot(MAIN);
            localStorage.removeItem(SAVED_KEY);
            setSavedNote('Not saved');
          }}
          data-spike-reset=""
        >
          Reset
        </button>
      </div>
      <div className="spk-layout">
        <Layout
          store={store}
          renderPane={renderPane}
          getPaneTitle={titleOf}
          paneActions={(pane) => (pane.id === 'main' ? ['move', 'zoom'] : ['move', 'zoom', 'close'])}
          gap={8}
          label="Threads"
        />
      </div>
      {drag && (
        <>
          {drag.target && (
            <div
              className="spk-drop"
              data-place={drag.target.place}
              style={{ left: drag.target.rect.left, top: drag.target.rect.top, width: drag.target.rect.width, height: drag.target.rect.height }}
            />
          )}
          <div className="spk-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>
            {drag.label || 'Thread'}
          </div>
        </>
      )}
    </div>
  );
}
