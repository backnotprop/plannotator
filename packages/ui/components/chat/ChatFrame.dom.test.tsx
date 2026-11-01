/**
 * The floating window's behavior: where it can go, what a narrow frame does to
 * it, who it tells, and that it listens to no key unless a host asks.
 * Requires DOM (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useRef } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatFrameProps } from './ChatFrame';
import type { ChatWindowStore as Store } from './chatWindowStore';

const hasDom = typeof document !== 'undefined';
const frameModule = hasDom ? await import('./ChatFrame') : null;
const storeModule = hasDom ? await import('./chatWindowStore') : null;
const platformModule = hasDom ? await import('../../utils/platform') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const realResizeObserver = hasDom ? globalThis.ResizeObserver : undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (realResizeObserver) globalThis.ResizeObserver = realResizeObserver;
  else delete (globalThis as Record<string, unknown>).ResizeObserver;
});

/** A frame with a real size, which happy-dom cannot lay out: fires once on observe. */
function sizedFrame(width: number, height: number) {
  host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: height });
  document.body.appendChild(host);
  return host;
}

function openStore(options?: ConstructorParameters<typeof Store>[0]) {
  const store = new storeModule!.ChatWindowStore(options);
  store.setMinimized(false);
  return store;
}

function mount(store: Store, props: Partial<ChatFrameProps> = {}, frame = sizedFrame(1200, 800)) {
  const { ChatFrame } = frameModule!;
  root = createRoot(frame);
  act(() => {
    root!.render(
      <ChatFrame store={store} label="Chat" {...props}>
        {props.children ?? (() => <p data-body>body</p>)}
      </ChatFrame>,
    );
  });
  return frame;
}

const win = () => document.querySelector<HTMLElement>('[data-chat-window]');
const handle = () => document.querySelector<HTMLElement>('[data-chat-drag-handle]');
const grip = () => document.querySelector<HTMLButtonElement>('[data-chat-resize-grip]');
const button = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

function press(el: Element, init: KeyboardEventInit) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

function pointer(
  el: Element,
  type: string,
  clientX: number,
  clientY: number,
  { button = 0, pointerId = 1, isPrimary = true, ctrlKey = false } = {},
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button, ctrlKey });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'isPrimary', { value: isPrimary });
  act(() => {
    el.dispatchEvent(event);
  });
}

/** happy-dom has no pointer capture; the frame only needs the call to exist. */
function capturable(el: HTMLElement) {
  el.setPointerCapture = () => {};
}

function drag(el: HTMLElement, from: [number, number], to: [number, number]) {
  capturable(el);
  pointer(el, 'pointerdown', ...from);
  pointer(el, 'pointermove', ...to);
  pointer(el, 'pointerup', ...to);
}

describe.if(hasDom)('window limits', () => {
  test('dragging the grip grows the window, up to the frame minus margins', () => {
    const store = openStore();
    mount(store);
    drag(grip()!, [500, 500], [-2000, -2000]);
    expect(store.winW).toBe(1200 - 16 * 2);
    expect(store.winH).toBe(800 - 16 * 2);
    expect(win()!.style.width).toBe('1168px');
  });

  test('dragging the grip inward stops at the minimum size', () => {
    const store = openStore();
    mount(store);
    drag(grip()!, [500, 500], [5000, 5000]);
    expect(store.winW).toBe(360);
    expect(store.winH).toBe(420);
  });

  test('dragging the header moves the offsets, stopping at the frame edges', () => {
    const store = openStore();
    mount(store);
    drag(handle()!, [500, 500], [440, 470]);
    expect([store.winRight, store.winBottom]).toEqual([76, 46]);
    drag(handle()!, [500, 500], [-5000, -5000]);
    expect([store.winRight, store.winBottom]).toEqual([1200 - 420, 800 - 560]);
    drag(handle()!, [500, 500], [5000, 5000]);
    expect([store.winRight, store.winBottom]).toEqual([0, 0]);
  });

  test('a press on a header button is not a drag', () => {
    const store = openStore();
    mount(store);
    const minimize = button('Minimize')!;
    capturable(handle()!);
    pointer(minimize, 'pointerdown', 500, 500);
    pointer(handle()!, 'pointermove', 400, 400);
    expect([store.winRight, store.winBottom]).toEqual([16, 16]);
  });

  test.each([
    ['the right button', { button: 2 }],
    ['the middle button', { button: 1 }],
    ['a Ctrl+press, the context menu on a Mac', { ctrlKey: true }],
    ['a second finger', { isPrimary: false }],
  ])('%s moves and resizes nothing', (_name, press) => {
    const store = openStore();
    mount(store);
    for (const target of [handle()!, grip()!]) {
      capturable(target);
      pointer(target, 'pointerdown', 500, 500, press);
      pointer(target, 'pointermove', 400, 400, press);
      pointer(target, 'pointerup', 400, 400, press);
    }
    expect(store.geometry()).toEqual({ w: 420, h: 560, right: 16, bottom: 16 });
  });

  test('a drag follows the pointer that started it, not a second one', () => {
    const store = openStore();
    mount(store);
    const row = handle()!;
    capturable(row);
    pointer(row, 'pointerdown', 500, 500);
    pointer(row, 'pointermove', 100, 100, { pointerId: 2 });
    expect([store.winRight, store.winBottom]).toEqual([16, 16]);
    pointer(row, 'pointerup', 100, 100, { pointerId: 2 });
    pointer(row, 'pointermove', 490, 490);
    expect([store.winRight, store.winBottom]).toEqual([26, 26]);
    pointer(row, 'pointerup', 490, 490);
    pointer(row, 'pointermove', 400, 400);
    expect([store.winRight, store.winBottom]).toEqual([26, 26]);
  });

  test('a link in the header keeps its own press', () => {
    const store = openStore();
    mount(store, { header: () => <a href="#tab" data-link>Tab</a> });
    const link = document.querySelector<HTMLElement>('[data-link]')!;
    capturable(handle()!);
    pointer(link, 'pointerdown', 500, 500);
    pointer(handle()!, 'pointermove', 400, 400);
    expect([store.winRight, store.winBottom]).toEqual([16, 16]);
  });

  test('the grip resizes from the keyboard, clamped like the drag', () => {
    const store = openStore();
    mount(store);
    press(grip()!, { key: 'ArrowLeft' });
    press(grip()!, { key: 'ArrowUp', shiftKey: true });
    expect([store.winW, store.winH]).toEqual([436, 624]);
    press(grip()!, { key: 'Home' });
    expect([store.winW, store.winH]).toEqual([420, 560]);
    for (let i = 0; i < 12; i += 1) press(grip()!, { key: 'ArrowRight', shiftKey: true });
    expect(store.winW).toBe(360);
  });

  test('double-click on the header re-docks; on a button it does not', () => {
    const store = openStore();
    mount(store);
    act(() => store.setWindowOffsets(200, 300));
    act(() => {
      button('Minimize')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect([store.winRight, store.winBottom]).toEqual([200, 300]);
    act(() => {
      handle()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect([store.winRight, store.winBottom]).toEqual([16, 16]);
  });

  test('Home from a corner keeps the window, its grip and its handle on the frame', () => {
    const store = openStore({ initialGeometry: { w: 360, h: 420, right: 640, bottom: 280 } });
    mount(store, {}, sizedFrame(1000, 700));
    press(grip()!, { key: 'Home' });
    const { width, height, right, bottom } = win()!.style;
    expect([width, height]).toEqual(['420px', '560px']);
    expect(parseInt(right, 10) + parseInt(width, 10)).toBeLessThanOrEqual(1000);
    expect(parseInt(bottom, 10) + parseInt(height, 10)).toBeLessThanOrEqual(700);
  });

  test('a re-dock on a frame shorter than the window keeps the handle on it', () => {
    const store = openStore({ initialGeometry: { w: 420, h: 420, right: 100, bottom: 0 } });
    mount(store, {}, sizedFrame(1000, 400));
    act(() => {
      handle()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(win()!.style.bottom).toBe('0px');
  });
});

describe.if(hasDom)('a frame that changes size changes the picture, not the choice', () => {
  /** A frame the test can resize, telling the window as a real one would. */
  function resizableFrame(width: number, height: number) {
    const frame = sizedFrame(width, height);
    let tell = () => {};
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        tell = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const resize = (nextWidth: number, nextHeight: number) => {
      Object.defineProperty(frame, 'clientWidth', { configurable: true, value: nextWidth });
      Object.defineProperty(frame, 'clientHeight', { configurable: true, value: nextHeight });
      act(() => tell());
    };
    return { frame, resize };
  }

  const big = { w: 800, h: 700, right: 500, bottom: 100 };

  function floating(reports: unknown[]) {
    return openStore({ initialGeometry: big, onGeometryChange: (geometry) => reports.push(geometry) });
  }

  test('a saved window opening in a smaller frame draws fitted and stays as saved', () => {
    const reports: unknown[] = [];
    const store = floating(reports);
    mount(store, {}, resizableFrame(700, 500).frame);
    expect(win()!.style.width).toBe('668px');
    expect(win()!.style.height).toBe('468px');
    expect(win()!.style.right).toBe('32px');
    expect(store.geometry()).toEqual(big);
    expect(reports).toEqual([]);
  });

  test('a brief narrow frame leaves the size the person chose, and tells nobody', () => {
    const reports: unknown[] = [];
    const store = floating(reports);
    const { frame, resize } = resizableFrame(1400, 900);
    mount(store, {}, frame);
    expect(win()!.style.width).toBe('800px');

    resize(340, 900);
    expect(win()!.className).toContain('inset-0');
    expect(store.geometry()).toEqual(big);

    resize(1400, 900);
    expect(win()!.className).not.toContain('inset-0');
    expect(win()!.style.width).toBe('800px');
    expect(win()!.style.right).toBe('500px');
    expect(reports).toEqual([]);
  });

  test('a frame that shrinks and grows back draws the same window again', () => {
    const reports: unknown[] = [];
    const store = floating(reports);
    const { frame, resize } = resizableFrame(1400, 900);
    mount(store, {}, frame);
    resize(700, 500);
    expect(win()!.style.width).toBe('668px');
    resize(1400, 900);
    expect(win()!.style.width).toBe('800px');
    expect(win()!.style.height).toBe('700px');
    expect(reports).toEqual([]);
  });

  test('a frame that cannot be measured keeps the last choice as drawn', () => {
    const store = floating([]);
    const { frame, resize } = resizableFrame(1400, 900);
    mount(store, {}, frame);
    resize(0, 0);
    expect(win()!.className).not.toContain('inset-0');
    expect(win()!.style.width).toBe('800px');
  });

  test('moving a fitted window saves the move and leaves the chosen size', () => {
    const reports: unknown[] = [];
    const store = floating(reports);
    mount(store, {}, resizableFrame(700, 500).frame);
    drag(handle()!, [300, 300], [310, 320]);
    expect(reports.at(-1)).toEqual({ w: 800, h: 700, right: 22, bottom: 12 });
  });

  test('a move along one axis leaves the other where the person chose', () => {
    const reports: unknown[] = [];
    const store = floating(reports);
    mount(store, {}, resizableFrame(700, 500).frame);
    drag(handle()!, [300, 300], [300, 310]);
    expect(reports.at(-1)).toEqual({ w: 800, h: 700, right: 500, bottom: 22 });
  });

  test('resizing a fitted window along one axis leaves the other as chosen', () => {
    const reports: unknown[] = [];
    const store = floating(reports);
    mount(store, {}, resizableFrame(700, 500).frame);
    press(grip()!, { key: 'ArrowRight' });
    expect(reports).toEqual([{ w: 652, h: 700, right: 500, bottom: 100 }]);
  });

  test('a saved value taken while open redraws at once', () => {
    const store = openStore();
    mount(store);
    act(() => store.restore({ w: 500, h: 500, right: 40, bottom: 40 }));
    expect(win()!.style.width).toBe('500px');
  });
});

describe.if(hasDom)('forced fullscreen on a narrow frame', () => {
  const observing = () => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  };

  test('a frame without room to float draws the window full, with no way to float it', () => {
    observing();
    const store = openStore();
    mount(store, {}, sizedFrame(390, 800));
    expect(win()!.className).toContain('inset-0');
    expect(win()!.style.width).toBe('');
    expect(grip()).toBeNull();
    expect(handle()).toBeNull();
    expect(button('Fullscreen')).toBeNull();
    expect(button('Exit fullscreen')).toBeNull();
    // Runtime only: the store's own wish is untouched for a wider frame.
    expect(store.fullscreen).toBe(false);
  });

  test('exactly enough room still floats', () => {
    observing();
    const store = openStore();
    mount(store, {}, sizedFrame(360 + 16 * 2, 800));
    expect(win()!.className).not.toContain('inset-0');
    expect(button('Fullscreen')).not.toBeNull();
  });

  test('a narrow parent with no height of its own still forces it', () => {
    observing();
    const store = openStore();
    mount(store, {}, sizedFrame(390, 0));
    expect(win()!.className).toContain('inset-0');
  });

  test('allowFullscreen false still forces it, because floating cannot work there', () => {
    observing();
    const store = openStore();
    mount(store, { allowFullscreen: false }, sizedFrame(320, 800));
    expect(win()!.className).toContain('inset-0');
  });
});

describe.if(hasDom)('optional fullscreen and drag', () => {
  test('the fullscreen toggle fills the frame and comes back', () => {
    const store = openStore();
    mount(store);
    act(() => button('Fullscreen')!.click());
    expect(win()!.className).toContain('inset-0');
    expect(button('Exit fullscreen')!.getAttribute('aria-pressed')).toBe('true');
    act(() => button('Exit fullscreen')!.click());
    expect(win()!.className).not.toContain('inset-0');
  });

  test('allowFullscreen false draws no toggle and ignores the store flag', () => {
    const store = openStore();
    store.toggleFullscreen();
    mount(store, { allowFullscreen: false });
    expect(button('Fullscreen')).toBeNull();
    expect(button('Exit fullscreen')).toBeNull();
    expect(win()!.className).not.toContain('inset-0');
  });

  test('allowDrag false leaves the header still: no move, no re-dock', () => {
    const store = openStore();
    act(() => store.setWindowOffsets(100, 100));
    mount(store, { allowDrag: false });
    expect(handle()).toBeNull();
    const row = button('Minimize')!.closest('header')!.firstElementChild as HTMLElement;
    capturable(row);
    pointer(row, 'pointerdown', 500, 500);
    pointer(row, 'pointermove', 400, 400);
    act(() => {
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect([store.winRight, store.winBottom]).toEqual([100, 100]);
  });
});

describe.if(hasDom)('minimize and close are the host\'s to hear', () => {
  test('minimize minimizes, then tells the host, and the window goes', () => {
    const store = openStore();
    let minimizedWhenCalled: boolean | null = null;
    mount(store, { onMinimize: () => (minimizedWhenCalled = store.minimized) });
    act(() => button('Minimize')!.click());
    expect(minimizedWhenCalled).toBe(true);
    expect(win()).toBeNull();
  });

  test('× appears only with onClose, and closing is the host\'s: the store stays open', () => {
    const store = openStore();
    let closed = 0;
    mount(store);
    expect(button('Close')).toBeNull();
    act(() => root!.unmount());
    root = null;
    mount(store, { onClose: () => (closed += 1) }, host!);
    act(() => button('Close')!.click());
    expect(closed).toBe(1);
    expect(store.minimized).toBe(false);
  });

  test('a double-click in a menu portaled out of the header does not re-dock', () => {
    const store = openStore();
    act(() => store.setWindowOffsets(200, 100));
    mount(store, {
      header: () => createPortal(<div role="menuitem" data-portaled />, document.body),
    });
    const row = document.querySelector('[data-portaled]')!;
    act(() => {
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect([store.winRight, store.winBottom]).toEqual([200, 100]);
  });

  test('a host\'s data attributes reach the root', () => {
    const store = openStore();
    mount(store, { rootProps: { 'data-host-window': '', 'data-drop-active': 'true' } });
    expect(win()!.hasAttribute('data-host-window')).toBe(true);
    expect(win()!.getAttribute('data-drop-active')).toBe('true');
  });

  test('the slots receive what the frame knows', () => {
    const store = openStore();
    let seen: unknown = null;
    mount(store, {
      header: (frame) => {
        seen = frame;
        return <span data-mark>Ask</span>;
      },
      headerBelow: <div data-below />,
    });
    expect(seen).toEqual({ fullscreen: false, width: 420 });
    expect(document.querySelector('[data-mark]')?.closest('header')).not.toBeNull();
    expect(document.querySelector('[data-below]')?.closest('header')).not.toBeNull();
  });
});

describe.if(hasDom)('no launcher', () => {
  test('a host with no launcher minimizes to nothing, and nothing throws', async () => {
    const { useChatFrameFocusReturn } = frameModule!;
    const store = openStore();
    function Host() {
      useChatFrameFocusReturn(store);
      return frameModule!.ChatFrame({ store, label: 'Chat', children: () => <p /> });
    }
    host = sizedFrame(1200, 800);
    root = createRoot(host);
    act(() => root!.render(<Host />));
    act(() => store.setMinimized(true));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(win()).toBeNull();
    expect(host.childElementCount).toBe(0);
    expect(document.activeElement).toBe(document.body);
  });

  test('with no children the open frame draws nothing', () => {
    const { ChatFrame } = frameModule!;
    const store = openStore();
    host = sizedFrame(1200, 800);
    root = createRoot(host);
    act(() => root!.render(<ChatFrame store={store} label="Chat" />));
    expect(win()).toBeNull();
  });

  test('the launcher slot shows only while minimized', () => {
    const { ChatFrameLauncher } = frameModule!;
    const store = openStore();
    host = sizedFrame(1200, 800);
    root = createRoot(host);
    act(() =>
      root!.render(
        <ChatFrameLauncher store={store}>
          <button type="button" data-chat-launcher />
        </ChatFrameLauncher>,
      ),
    );
    expect(document.querySelector('[data-chat-launcher]')).toBeNull();
    act(() => store.setMinimized(true));
    expect(document.querySelector('[data-chat-launcher]')).not.toBeNull();
  });
});

describe.if(hasDom)('focus return', () => {
  function HostWithLauncher({ store }: { store: Store }) {
    const { ChatFrame, ChatFrameLauncher, useChatFrameFocusReturn } = frameModule!;
    useChatFrameFocusReturn(store);
    const ref = useRef<HTMLElement | null>(null);
    return (
      <>
        <ChatFrame store={store} label="Chat" windowRef={ref}>
          {() => <textarea data-composer />}
        </ChatFrame>
        <ChatFrameLauncher store={store}>
          <button type="button" data-chat-launcher>
            Open
          </button>
        </ChatFrameLauncher>
      </>
    );
  }

  test('minimizing hands focus to the launcher, whatever minimized it', async () => {
    const store = openStore();
    host = sizedFrame(1200, 800);
    root = createRoot(host);
    act(() => root!.render(<HostWithLauncher store={store} />));
    document.querySelector<HTMLElement>('[data-composer]')!.focus();

    // From the store, as a host's own gesture would.
    act(() => store.setMinimized(true));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.activeElement).toBe(document.querySelector('[data-chat-launcher]'));
  });

  test('focus in a field outside the window stays there', async () => {
    const store = openStore();
    host = sizedFrame(1200, 800);
    root = createRoot(host);
    act(() => root!.render(<HostWithLauncher store={store} />));
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();

    act(() => store.setMinimized(true));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  test('opening does not pull focus to the launcher; an unmount cancels the return', async () => {
    const store = openStore();
    host = sizedFrame(1200, 800);
    root = createRoot(host);
    act(() => root!.render(<HostWithLauncher store={store} />));
    act(() => store.setMinimized(true));
    act(() => root!.unmount());
    root = null;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(document.body);
  });
});

describe.if(hasDom)('the keyboard map is the host\'s to opt into', () => {
  const mod = platformModule?.isMac ? { metaKey: true } : { ctrlKey: true };

  test('off by default: a frame alone listens to no key', () => {
    const store = openStore();
    mount(store);
    press(document.body, { key: 'j', ...mod });
    expect(store.minimized).toBe(false);
    press(document.body, { key: 'Escape' });
    expect(store.minimized).toBe(false);
    press(document.body, { key: 'j', shiftKey: true, ...mod });
    expect(store.fullscreen).toBe(false);
  });

  function Keys({
    store,
    summon = true,
    onKey,
    onMinimize,
  }: {
    store: Store;
    summon?: boolean;
    onKey?: (event: KeyboardEvent, isMac: boolean) => boolean;
    onMinimize?: () => void;
  }) {
    frameModule!.useChatFrameKeys(store, { summon, onKey, onMinimize });
    return null;
  }

  function mountKeys(props: React.ComponentProps<typeof Keys>) {
    host = sizedFrame(1200, 800);
    root = createRoot(host);
    act(() => root!.render(<Keys {...props} />));
  }

  test('opted in: Mod+J toggles, Shift+Mod+J fullscreens, Escape minimizes', () => {
    const store = openStore();
    let told = 0;
    mountKeys({ store, onMinimize: () => (told += 1) });
    press(document.body, { key: 'j', ...mod });
    expect(store.minimized).toBe(true);
    expect(told).toBe(1);
    press(document.body, { key: 'j', ...mod });
    expect(store.minimized).toBe(false);
    expect(told).toBe(1);
    press(document.body, { key: 'J', shiftKey: true, ...mod });
    expect(store.fullscreen).toBe(true);
    press(document.body, { key: 'Escape' });
    expect(store.minimized).toBe(true);
    expect(told).toBe(2);
  });

  test('summon false leaves Mod+J alone; a host can take Escape first', () => {
    const store = openStore();
    mountKeys({ store, summon: false, onKey: (event) => event.key === 'Escape' });
    press(document.body, { key: 'j', ...mod });
    expect(store.minimized).toBe(false);
    press(document.body, { key: 'Escape' });
    expect(store.minimized).toBe(false);
  });

  test('a key something else already used is left alone', () => {
    const store = openStore();
    mountKeys({ store });
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(store.minimized).toBe(false);
  });

  test('Shift+Mod+J from minimized opens through onOpen', () => {
    let opened = 0;
    const store = new storeModule!.ChatWindowStore({ onOpen: () => (opened += 1) });
    mountKeys({ store });
    press(document.body, { key: 'J', shiftKey: true, ...mod });
    expect(store.minimized).toBe(false);
    expect(store.fullscreen).toBe(true);
    expect(opened).toBe(1);
  });

  test.each([
    ['a composing Escape', { isComposing: true }],
    ['Safari\'s keyCode 229', { keyCode: 229 }],
  ])('%s belongs to the input method and leaves the window open', (_name, init) => {
    const store = openStore();
    mountKeys({ store });
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
    if ('keyCode' in init) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(store.minimized).toBe(false);
  });
});
