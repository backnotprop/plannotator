/**
 * The canvas in the window, with no switch in Settings (docs/agent-guides/inbox-canvas.md "The switch"): the thread
 * header's canvas button only once the thread has a canvas (its mark), the reply box's + → Canvas on every thread
 * that can have one, and which visit + opens: a thread without a canvas opens it as it is; a thread with one opens a
 * clear spot whose Send carries only the new drawing (`fresh`), while the header's button opens the whole board.
 * An Inbox whose `settings.canvas` is not on (config.json `inboxCanvas: false`, or an older Inbox) has none of it.
 * What the clear spot and its Send pick: canvas/freshVisit.test.ts; the server's reading of it: inbox-canvas.test.ts.
 *
 * What regresses: a header button on a thread with no canvas, none once it has one; + → Canvas opening the whole
 * board (so Send would post everything) on a thread with a canvas; canvas code for an Inbox without the canvas.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { SettingsModel } from '../api';
import type { ThreadSlotHost } from '../thread/slotHost';
import type { ThreadCanvas } from './useThreadCanvas';

const hasDom = typeof document !== 'undefined';
const { useThreadCanvas } = (hasDom ? await import('./useThreadCanvas') : {}) as typeof import('./useThreadCanvas');
const { SketchButtonPart, CanvasLayerPart } = (hasDom ? await import('../lazyParts') : {}) as typeof import('../lazyParts');
const { onCanvasFrame } = (hasDom ? await import('./canvasApi') : {}) as typeof import('./canvasApi');
const { ThemeProvider } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');

let root: Root | null = null;
let host: HTMLElement | null = null;
const savedFetch = globalThis.fetch;
/** The threads whose canvas holds something, as `GET /api/inbox/canvases` answers. */
let withCanvas: string[] = [];

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  if (hasDom) document.body.innerHTML = '';
});

function mount(node: ReactNode) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/canvases')) return Response.json({ canvases: withCanvas.map((thread_id) => ({ thread_id, rev: 2, changed: false })) });
    return Response.json({});
  }) as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The marks are read once and again after a canvas frame (a burst of frames is one read, 400 ms later). */
async function marksNow(threads: string[]) {
  withCanvas = threads;
  act(() => onCanvasFrame(JSON.stringify({ thread_id: threads[0] ?? 'msg_X', rev: 9 })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 480)));
}

const thread = { thread_id: 'msg_A1', subject: 'Berth booking retries', messages: [] } as unknown as InboxThread;
let canvas: ThreadCanvas | null = null;

/** The layer asked for, read from what the hook hands the pane: whether it is a fresh visit. */
function layerFresh(layer: ReactNode): boolean | null {
  if (!isValidElement(layer)) return null;
  const inner = (layer as ReactElement<{ children: ReactElement<{ fresh?: boolean }> }>).props.children;
  return inner.props.fresh === true;
}

function Pane({ settingsCanvas }: { settingsCanvas: { on: boolean } | undefined }) {
  const slot = { settings: { canvas: settingsCanvas } as SettingsModel, setCanvasReply: () => {}, outbox: new Map(), machines: { linked: [] } } as unknown as ThreadSlotHost;
  canvas = useThreadCanvas(thread, slot);
  return <header>{canvas.header}</header>;
}

const renderPane = (settingsCanvas: { on: boolean } | undefined) =>
  mount(
    <ThemeProvider>
      <Pane settingsCanvas={settingsCanvas} />
    </ThemeProvider>,
  );

const headerButton = () => document.querySelector('header [data-thread-sketch]');

describe("a thread's canvas in the window", () => {
  test.skipIf(!hasDom)('an Inbox without the canvas (off in config.json, or older): no header button, no + → Canvas, and no canvas code fetched', async () => {
    for (const settingsCanvas of [{ on: false }, undefined]) {
      renderPane(settingsCanvas);
      await act(async () => {});
      expect(headerButton()).toBeNull();
      expect(canvas!.openFromReply).toBeNull();
      act(() => root?.unmount());
      root = null;
    }
    expect(SketchButtonPart.isLoaded()).toBe(false);
    expect(CanvasLayerPart.isLoaded()).toBe(false);
  });

  test.skipIf(!hasDom)('a thread with no canvas: no header button; + → Canvas opens its canvas as it is', async () => {
    withCanvas = [];
    renderPane({ on: true });
    await act(async () => {
      await SketchButtonPart.preload();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(headerButton()).toBeNull();
    expect(canvas!.openFromReply).not.toBeNull();
    act(() => canvas!.openFromReply!());
    expect(layerFresh(canvas!.layer)).toBe(false);
  });

  test.skipIf(!hasDom)('a thread with a canvas: the header button shows; + → Canvas opens a clear spot (fresh), the header button the whole board', async () => {
    renderPane({ on: true });
    await act(async () => {
      await SketchButtonPart.preload();
    });
    await marksNow([thread.thread_id]);
    await until(() => headerButton() !== null, 'the header button');
    expect(headerButton()!.getAttribute('aria-label')).toBe('Canvas');
    act(() => canvas!.openFromReply!());
    expect(layerFresh(canvas!.layer)).toBe(true);
    // Closed again with the header's button (it toggles), then opened from it: the whole board.
    await act(async () => (headerButton() as HTMLButtonElement).click());
    expect(canvas!.layer).toBeNull();
    await act(async () => (headerButton() as HTMLButtonElement).click());
    expect(layerFresh(canvas!.layer)).toBe(false);
  });

  test.skipIf(!hasDom)("a linked computer's thread: + → Canvas when that computer says `canvas`, none from an older one", async () => {
    const { rememberMachine, resetMachineRoutes, setSelfMachine } = await import('../inboxUrl');
    const self = 'ibx_01M89YNWCSXG5FHZ2AFN0SAG9G';
    const far = 'ibx_01M89YNWCY3TVAFQV2QZH08AMG';
    try {
      for (const [marks, offered] of [[['star', 'canvas'], true], [['star'], false]] as const) {
        resetMachineRoutes();
        setSelfMachine(self, [{ id: self, self: true, name: 'Studio' }, { id: far, name: 'MacBook', marks, list_cursor: 3, state: 'online' }]);
        rememberMachine([thread.thread_id], far);
        renderPane({ on: true });
        await act(async () => {});
        expect([marks.join(','), canvas!.openFromReply !== null]).toEqual([marks.join(','), offered]);
        act(() => root?.unmount());
        root = null;
      }
    } finally {
      resetMachineRoutes();
    }
  });
});
