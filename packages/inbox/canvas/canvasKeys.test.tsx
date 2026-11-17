/**
 * The thread canvas's keys stay in the canvas (docs/agent-guides/inbox-canvas.md): R, D, A, P and T pick Excalidraw's
 * tools only while focus is inside the canvas, and a key pressed there never reaches the Inbox's own shortcuts (R would
 * open the reply). Outside the canvas, the same keys reach the Inbox as before. The canvas adds no Inbox-wide shortcut.
 *
 * The real CanvasBoard is mounted with Excalidraw stood in for (it draws to a 2D canvas the DOM test world lacks): what
 * is proved is the host's own seam, the canvas's box that keeps the keys, and the flag that keeps Excalidraw's keys off
 * the window. The Inbox's side is the real registry scope, listened to the way Thread.tsx listens (the window).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom).
 */
import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';

// Excalidraw's props as the canvas passes them, for the flag that keeps its keys inside the canvas.
let excalidrawProps: Record<string, unknown> | null = null;

let CanvasBoard: typeof import('./board/CanvasBoard').default;
let useShortcutScope: typeof import('../panes/scope').useShortcutScope;
let shortcuts: typeof import('../shortcuts');

beforeAll(async () => {
  if (!hasDom) return;
  mock.module('@excalidraw/excalidraw', () => ({
    Excalidraw: (props: Record<string, unknown>) => {
      excalidrawProps = props;
      // Excalidraw's own focusable surface (its `.excalidraw` box takes focus and the keys).
      return createElement('div', { className: 'excalidraw', tabIndex: 0, 'data-testid': 'surface' });
    },
    exportToBlob: async () => null,
    restoreElements: (elements: unknown[]) => elements,
  }));
  mock.module('@excalidraw/excalidraw/index.css?inline', () => ({ default: '' }));
  CanvasBoard = (await import('./board/CanvasBoard')).default;
  ({ useShortcutScope } = await import('../panes/scope'));
  shortcuts = await import('../shortcuts');
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  excalidrawProps = null;
});

/** The Inbox's reply key, as the thread pane listens for it: the registry scope on the window, with its typing guard. */
function ReplyKey({ onReply, children }: { onReply: () => void; children?: ReactNode }) {
  useShortcutScope({ scope: shortcuts.inboxThreadShortcuts, handlers: { reply: { when: (e: KeyboardEvent) => shortcuts.bareKeyAllowed(e, { singleKeys: true }), handle: onReply } } });
  return children as never;
}

function mount(onReply: () => void, onWindowKey: (key: string) => void) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  function Page() {
    useEffect(() => {
      const listen = (e: KeyboardEvent) => onWindowKey(e.key);
      window.addEventListener('keydown', listen);
      return () => window.removeEventListener('keydown', listen);
    }, []);
    return createElement(
      ReplyKey,
      { onReply },
      createElement('textarea', { 'aria-label': 'Reply' }),
      createElement('button', { type: 'button', 'data-outside': '' }, 'Outside'),
      createElement(CanvasBoard, { scene: null, sceneKey: 'k', fileUrl: (n: string) => n, theme: 'light' }),
    );
  }
  act(() => root!.render(createElement(Page)));
}

const press = (el: Element, key: string) => {
  const event = new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
};

test.skipIf(!hasDom)('R, D, A, P and T pressed inside the canvas never reach the window, so the Inbox reply key stays still', () => {
  let replies = 0;
  const reached: string[] = [];
  mount(() => replies++, (k) => reached.push(k));
  const surface = document.querySelector('[data-testid=surface]')!;
  expect(surface.closest('.pn-canvas')).not.toBeNull();
  for (const key of ['r', 'd', 'a', 'p', 't']) press(surface, key);
  expect(reached).toEqual([]);
  expect(replies).toBe(0);
  // A dock button inside the canvas keeps its keys too.
  press(document.querySelector('.pn-canvas-tool')!, 'r');
  expect(reached).toEqual([]);
  expect(replies).toBe(0);
});

test.skipIf(!hasDom)('Excalidraw listens for its keys only while focus is in the canvas, never on the window', () => {
  mount(() => {}, () => {});
  expect(excalidrawProps?.handleKeyboardGlobally).toBe(false);
});

test.skipIf(!hasDom)('outside the canvas the same keys reach the Inbox: R on the page opens the reply, letters typed in the reply box are not swallowed', () => {
  let replies = 0;
  const reached: string[] = [];
  mount(() => replies++, (k) => reached.push(k));
  const outside = document.querySelector('[data-outside]')!;
  const r = press(outside, 'r');
  expect(replies).toBe(1);
  expect(reached).toEqual(['r']);
  expect(r.defaultPrevented).toBe(true);

  reached.length = 0;
  const box = document.querySelector('textarea')!;
  const typed = ['r', 'd', 'a', 'p', 't'].map((k) => press(box, k));
  // The window hears them (nothing in the page swallows them) and the box keeps them: none is prevented.
  expect(reached).toEqual(['r', 'd', 'a', 'p', 't']);
  expect(typed.every((e) => !e.defaultPrevented)).toBe(true);
  expect(replies).toBe(1);
});

test.skipIf(!hasDom)('the canvas adds no Inbox-wide shortcut: no registry scope or action is the canvas', () => {
  for (const scope of shortcuts.inboxShortcutRegistry as unknown as { id: string; shortcuts: Record<string, { description: string }> }[]) {
    expect(scope.id).not.toMatch(/canvas/i);
    for (const [action, s] of Object.entries(scope.shortcuts)) {
      expect(action).not.toMatch(/canvas/i);
      expect(s.description).not.toMatch(/canvas/i);
    }
  }
});
