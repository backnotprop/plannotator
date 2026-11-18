/**
 * The thread canvas's keys stay in the canvas (docs/agent-guides/inbox-canvas.md): R, D, A, P and T pick Excalidraw's
 * tools only while focus is inside the canvas, and a key pressed there never reaches the Inbox's own shortcuts (R would
 * open the reply). Outside the canvas, the same keys reach the Inbox as before. The canvas adds no Inbox-wide shortcut.
 *
 * The real CanvasBoard is mounted with Excalidraw stood in for (it draws to a 2D canvas the DOM test world lacks): what
 * is proved is the host's own seam, the canvas's box that keeps the keys, and the flag that keeps Excalidraw's keys off
 * the window. The Inbox's side is the real registry scope, listened to the way Thread.tsx listens (the window).
 *
 * Escape in the canvas does Excalidraw's own thing first; with nothing left to end, it gives focus back (`onLeave`).
 * The stand-in has Excalidraw's state (what the canvas reads before Excalidraw acts) and its own key handler, a React
 * onKeyDown on its `.excalidraw` box as in Excalidraw 0.18.1, so the test sees which of the two took the key. Scenes
 * and pastes reach the stand-in through the canvas's cleaning, as they reach Excalidraw.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom).
 */
import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';

// Excalidraw's props as the canvas passes them, for the flag that keeps its keys inside the canvas.
let excalidrawProps: Record<string, unknown> | null = null;

// The stand-in's state (Excalidraw's appState, as the canvas reads it), what the canvas asked of it, and the keys its
// own handler took.
const idle = () => ({
  activeTool: { type: 'selection', locked: false },
  selectedElementIds: {} as Record<string, boolean>,
  selectedGroupIds: {} as Record<string, boolean>,
  editingGroupId: null as string | null,
  editingTextElement: null as unknown,
  newElement: null,
  multiElement: null,
  editingLinearElement: null,
  croppingElementId: null,
  isCropping: false,
  openMenu: null,
  openPopup: null,
  contextMenu: null,
  showHyperlinkPopup: false,
  openSidebar: null,
  openDialog: null as null | { name: string },
  width: 800,
  height: 600,
  zoom: { value: 1 },
});
let appState = idle();
let updates: Record<string, unknown>[] = [];
let excalidrawKeys: string[] = [];
const standInApi = {
  getAppState: () => appState,
  updateScene: (u: Record<string, unknown>) => updates.push(u),
  getSceneElements: () => [],
  getFiles: () => ({}),
  addFiles: () => {},
  scrollToContent: () => {},
  setActiveTool: () => {},
};

let CanvasBoard: typeof import('./board/CanvasBoard').default;
let useShortcutScope: typeof import('../panes/scope').useShortcutScope;
let shortcuts: typeof import('../shortcuts');

beforeAll(async () => {
  if (!hasDom) return;
  mock.module('@excalidraw/excalidraw', () => ({
    Excalidraw: (props: Record<string, unknown>) => {
      excalidrawProps = props;
      useEffect(() => (props.excalidrawAPI as (a: unknown) => void)(standInApi), []);
      // Excalidraw's own focusable surface (its `.excalidraw` box takes focus and the keys, through React's onKeyDown).
      return createElement('div', { className: 'excalidraw', tabIndex: 0, 'data-testid': 'surface', onKeyDown: (e: { key: string }) => excalidrawKeys.push(e.key) });
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
  appState = idle();
  updates = [];
  excalidrawKeys = [];
});

/** The Inbox's reply key, as the thread pane listens for it: the registry scope on the window, with its typing guard. */
function ReplyKey({ onReply, children }: { onReply: () => void; children?: ReactNode }) {
  useShortcutScope({ scope: shortcuts.inboxThreadShortcuts, handlers: { reply: { when: (e: KeyboardEvent) => shortcuts.bareKeyAllowed(e, { singleKeys: true }), handle: onReply } } });
  return children as never;
}

function mount(onReply: () => void, onWindowKey: (key: string) => void, board: Record<string, unknown> = {}) {
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
      createElement(CanvasBoard, { scene: null, sceneKey: 'k', fileUrl: (n: string) => n, theme: 'light', ...board }),
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

// ---- Escape: Excalidraw's own first, then back to the thread ----

function escapeIn(state: Partial<ReturnType<typeof idle>>) {
  let left = 0;
  const reached: string[] = [];
  mount(() => {}, (k) => reached.push(k), { onLeave: () => left++ });
  appState = { ...idle(), ...state };
  const event = press(document.querySelector('[data-testid=surface]')!, 'Escape');
  return { left: () => left, reached, event };
}

const unmount = () => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
};

test.skipIf(!hasDom)("Escape with a tool picked, words being written, a line being drawn or a menu open is Excalidraw's, and stays in the canvas", () => {
  const busy: Partial<ReturnType<typeof idle>>[] = [
    { activeTool: { type: 'freedraw', locked: false } },
    { activeTool: { type: 'rectangle', locked: true } },
    { editingTextElement: { id: 't1' } },
    { multiElement: { id: 'l1' } as never },
    { contextMenu: { top: 0, left: 0 } as never },
    { openDialog: { name: 'help' } },
  ];
  for (const state of busy) {
    const { left, reached, event } = escapeIn(state);
    expect(excalidrawKeys).toEqual(['Escape']);
    expect(left()).toBe(0);
    expect(reached).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    unmount();
    excalidrawKeys = [];
  }
});

test.skipIf(!hasDom)('Escape with something selected clears the selection, and stays in the canvas', () => {
  const { left, reached } = escapeIn({ selectedElementIds: { box: true } });
  expect(updates).toContainEqual(expect.objectContaining({ appState: { selectedElementIds: {}, selectedGroupIds: {}, editingGroupId: null } }));
  expect(left()).toBe(0);
  expect(reached).toEqual([]);
});

test.skipIf(!hasDom)("Escape with nothing left to end gives focus back (onLeave), and never reaches the Inbox's keys", () => {
  const { left, reached, event } = escapeIn({});
  expect(left()).toBe(1);
  expect(reached).toEqual([]);
  expect(excalidrawKeys).toEqual([]);
  expect(event.defaultPrevented).toBe(true);
  unmount();
  // An export dialog switched off here draws nothing: it does not hold Escape in the canvas.
  const off = escapeIn({ openDialog: { name: 'imageExport' } });
  expect(off.left()).toBe(1);
});

test.skipIf(!hasDom)("the canvas's box tells the host's key and paste handlers to leave it alone", () => {
  mount(() => {}, () => {});
  expect(document.querySelector('.pn-canvas')!.hasAttribute('data-keeps-keys')).toBe(true);
});

test.skipIf(!hasDom)('a tool picked with the pointer leaves focus in the drawing, where its keys and pastes go', () => {
  mount(() => {}, () => {});
  const pen = document.querySelector<HTMLElement>('.pn-canvas-tool[data-tool=freedraw]')!;
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  act(() => {
    pen.dispatchEvent(down);
    pen.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
  expect(down.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(document.querySelector('[data-testid=surface]'));
});

// ---- untrusted scenes: cleaned before Excalidraw holds them ----

const HOSTILE_SCENE = [
  { id: 'box', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, link: 'https://example.invalid', customData: { part: 'box', evil: { a: 1 } } },
  { id: 'frame', type: 'iframe', x: 0, y: 0, width: 10, height: 10, customData: { generationData: { status: 'done', html: '<script>1</script>' } } },
  { id: 'embed', type: 'embeddable', x: 0, y: 0, width: 10, height: 10, link: 'https://www.youtube.com/watch?v=x' },
];

test.skipIf(!hasDom)("a stored scene reaches Excalidraw cleaned: no iframe or embed, no link, only the canvas's own customData", () => {
  mount(() => {}, () => {}, { scene: { elements: HOSTILE_SCENE, files: {} } });
  const initial = (excalidrawProps!.initialData as { elements: { id: string; link: unknown; customData: unknown }[] }).elements;
  expect(initial.map((e) => e.id)).toEqual(['box']);
  expect(initial[0].link).toBeNull();
  expect(initial[0].customData).toEqual({ part: 'box' });
});

test.skipIf(!hasDom)('an embed that lands another way (a pasted or dropped scene) is cleaned out at once, and never saved', () => {
  const saves: { elements: { id: string }[] }[] = [];
  mount(() => {}, () => {}, { onChange: (c: { elements: { id: string }[] }) => saves.push(c) });
  act(() => (excalidrawProps!.onChange as (e: unknown[], s: unknown, f: unknown) => void)(HOSTILE_SCENE.map((e) => ({ ...e, version: 2 })), appState, {}));
  const replaced = updates.find((u) => Array.isArray(u.elements)) as { elements: { id: string; link: unknown }[] } | undefined;
  expect(replaced?.elements.map((e) => e.id)).toEqual(['box']);
  expect(replaced?.elements[0].link).toBeNull();
  expect(saves.at(-1)?.elements.map((e) => e.id)).toEqual(['box']);
});

test.skipIf(!hasDom)("a paste of Excalidraw's elements keeps only what the canvas holds, and an address pasted makes no embed", () => {
  mount(() => {}, () => {});
  const data = { elements: HOSTILE_SCENE as unknown[] };
  const go = (excalidrawProps!.onPaste as (d: typeof data) => boolean)(data);
  expect(go).toBe(true);
  expect((data.elements as { id: string }[]).map((e) => e.id)).toEqual(['box']);
  // Excalidraw makes an embed from a pasted or dropped address only when this says yes (embeddableURLValidator).
  const validate = excalidrawProps!.validateEmbeddable as (url: string) => boolean;
  for (const url of ['https://www.youtube.com/watch?v=x', 'https://figma.com/file/x', 'https://example.com']) expect(validate(url)).toBe(false);
});
