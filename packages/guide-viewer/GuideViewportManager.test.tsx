import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeGuideData } from '@plannotator/core/guide';
import type { DiffFile } from './types';
import { GuideHostProvider, type GuideHostValue } from './host';
import {
  GUIDE_EAGER_MOUNT_MAX_FILES,
  GuideViewportProvider,
  useGuideFileWindow,
} from './GuideViewportManager';
import { GuideView } from './GuideView';

const hasDom = typeof document !== 'undefined';

/**
 * An IntersectionObserver that never delivers. Mount state observed under it is
 * exactly what the manager decides on its own (seed vs eager), which is what
 * these tests pin.
 */
class SilentIntersectionObserver {
  static instances = 0;
  constructor(_callback: IntersectionObserverCallback) {
    SilentIntersectionObserver.instances += 1;
  }
  observe = () => {};
  unobserve = () => {};
  disconnect = () => {};
}

/** One registered shell; renders a marker only while the manager admits it. */
function Shell({ id }: { id: string }) {
  const { mounted, register } = useGuideFileWindow(id);
  return (
    <div ref={register} data-shell={id}>
      {mounted && <span data-testid="mounted" data-shell-mounted={id} />}
    </div>
  );
}

function FakeDiffRenderer(props: Record<string, unknown>) {
  const files = props.files as DiffFile[];
  return <div data-testid="file-code-view" data-file={files[0]?.path} />;
}

function makeFile(path: string): DiffFile {
  return {
    path,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
    additions: 1,
    deletions: 1,
    status: 'modified',
  };
}

function makeHost(files: DiffFile[]): GuideHostValue<Record<string, unknown>> {
  return {
    files,
    DiffRenderer: FakeDiffRenderer as unknown as GuideHostValue<Record<string, unknown>>['DiffRenderer'],
    getDiffRendererProps: () => ({}),
    revealFile: null,
    activeSearchMatch: null,
  };
}

function makeGuide(files: DiffFile[]): CodeGuideData {
  return {
    title: 'Guide',
    intent: '',
    sections: [{ title: 'All', overview: '', diffs: files.map((file) => ({ file: file.path })) }],
    reviewed: [false],
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const originalObserver = globalThis.IntersectionObserver;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  SilentIntersectionObserver.instances = 0;
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: originalObserver });
  if (hasDom) document.body.innerHTML = '';
});

async function render(node: React.ReactNode, observer: unknown = SilentIntersectionObserver) {
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: observer });
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

function mountedIds(): string[] {
  return [...host!.querySelectorAll<HTMLElement>('[data-shell-mounted]')].map((el) => el.dataset.shellMounted!);
}

describe('GuideViewportProvider eager mode', () => {
  const ids = Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`);

  test.skipIf(!hasDom)('mounts every registered shell without any observer delivery', async () => {
    await render(
      <GuideViewportProvider eager>
        {ids.map((id) => <Shell key={id} id={id} />)}
      </GuideViewportProvider>,
    );

    expect(mountedIds()).toEqual(ids);
    // No window means no observer: nothing is constructed to evict from.
    expect(SilentIntersectionObserver.instances).toBe(0);
  });

  test.skipIf(!hasDom)('keeps every shell mounted when one is added or the focus pin moves', async () => {
    const Harness = ({ count, focused }: { count: number; focused: string }) => (
      <GuideViewportProvider eager>
        {ids.slice(0, count).map((id) => <PinnableShell key={id} id={id} pinned={id === focused} />)}
      </GuideViewportProvider>
    );
    function PinnableShell({ id, pinned }: { id: string; pinned: boolean }) {
      const { mounted, register, requestMount } = useGuideFileWindow(id, pinned);
      React.useEffect(() => {
        if (pinned) requestMount();
      }, [pinned, requestMount]);
      return (
        <div ref={register} data-shell={id}>
          {mounted && <span data-shell-mounted={id} />}
        </div>
      );
    }

    await render(<Harness count={11} focused={ids[0]} />);
    expect(mountedIds()).toEqual(ids.slice(0, 11));

    await act(async () => {
      root!.render(<Harness count={12} focused={ids[11]} />);
    });
    expect(mountedIds()).toEqual(ids);
  });

  test.skipIf(!hasDom)('without eager only the seed mounts before the observer delivers', async () => {
    await render(
      <GuideViewportProvider>
        {ids.map((id) => <Shell key={id} id={id} />)}
      </GuideViewportProvider>,
    );

    const mounted = mountedIds();
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(ids.length);
    expect(SilentIntersectionObserver.instances).toBe(1);
  });
});

/** An IntersectionObserver the test drives: `deliver` says which shells are now in the window. */
class DrivenIntersectionObserver {
  static current: DrivenIntersectionObserver | null = null;
  private targets = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {
    DrivenIntersectionObserver.current = this;
  }
  observe = (target: Element) => void this.targets.add(target);
  unobserve = (target: Element) => void this.targets.delete(target);
  disconnect = () => this.targets.clear();
  deliver(near: (id: string) => boolean) {
    this.callback(
      [...this.targets].map((target) => ({ target, isIntersecting: near((target as HTMLElement).dataset.shell!) })) as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

describe('GuideViewportProvider window', () => {
  const ids = Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`);
  let restoreFrames = () => {};
  afterEach(() => {
    restoreFrames();
    restoreFrames = () => {};
  });

  async function deliver(near: (id: string) => boolean) {
    await act(async () => {
      DrivenIntersectionObserver.current!.deliver(near);
      await new Promise((done) => requestAnimationFrame(done));
    });
  }

  test.skipIf(!hasDom)('every file in the window draws, however many fit, and only those', async () => {
    await render(
      <GuideViewportProvider>
        {ids.map((id) => <Shell key={id} id={id} />)}
      </GuideViewportProvider>,
      DrivenIntersectionObserver,
    );

    const inWindow = ids.slice(5, 35);
    await deliver((id) => inWindow.includes(id));
    expect(mountedIds()).toEqual(inWindow);

    // Further down: what left the window goes, with nothing kept over what arrived.
    const further = ids.slice(10, 40);
    await deliver((id) => further.includes(id));
    expect(mountedIds()).toEqual(further);
  });

  /** The manager's scroller, with a real height (the test DOM has no layout). */
  async function renderInScroller() {
    await render(
      <div data-scroller="" style={{ overflowY: 'auto' }}>
        <GuideViewportProvider>
          {ids.map((id) => <Shell key={id} id={id} />)}
        </GuideViewportProvider>
      </div>,
      DrivenIntersectionObserver,
    );
    const scroller = host!.querySelector<HTMLElement>('[data-scroller]')!;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 1_000 });
    return scroller;
  }

  const scrollTo = (scroller: HTMLElement, top: number) =>
    act(async () => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event('scroll'));
    });

  /** From here on frames run only when the test says, one per call. */
  function manualFrames(): () => Promise<void> {
    const queued = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    const realRequest = globalThis.requestAnimationFrame;
    const realCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      queued.set(nextHandle, callback);
      return nextHandle++;
    };
    globalThis.cancelAnimationFrame = (handle) => void queued.delete(handle);
    restoreFrames = () => {
      globalThis.requestAnimationFrame = realRequest;
      globalThis.cancelAnimationFrame = realCancel;
    };
    return () =>
      act(async () => {
        const callbacks = [...queued.values()];
        queued.clear();
        for (const callback of callbacks) callback(performance.now());
      });
  }

  /** Far enough apart that the step between them is never read as a fast one. */
  const frames = (count: number) =>
    act(async () => {
      for (let i = 0; i < count; i++) await new Promise((done) => setTimeout(done, 20));
    });

  test.skipIf(!hasDom)('a flick draws the files it runs into at once, on screen or not yet, not when the scroll stops', async () => {
    const scroller = await renderInScroller();
    scroller.getBoundingClientRect = () => new DOMRectReadOnly(0, 0, 1_000, 1_000);
    for (const [index, id] of ids.entries()) {
      scroller.querySelector<HTMLElement>(`[data-shell="${id}"]`)!.getBoundingClientRect = () => new DOMRectReadOnly(0, index * 400, 1_000, 300);
    }
    await deliver((id) => ids.slice(0, 5).includes(id));
    await frames(6);

    const frame = manualFrames();
    const landed = ids.slice(4, 12);
    await new Promise((done) => setTimeout(done, 20));
    await scrollTo(scroller, 400);
    DrivenIntersectionObserver.current!.deliver((id) => landed.includes(id));
    await frame();
    expect(mountedIds()).toEqual(landed);
  });

  test.skipIf(!hasDom)('a step of more than a view passes files even on frames too slow to read as fast', async () => {
    const scroller = await renderInScroller();
    const frame = manualFrames();
    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(0, 5).includes(id));
    await frame();

    await new Promise((done) => setTimeout(done, 60));
    await scrollTo(scroller, 1_500);
    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(10, 15).includes(id));
    await frame();
    expect(mountedIds()).toEqual(ids.slice(0, 5));
  });

  test.skipIf(!hasDom)('a scroll passing a whole view each frame mounts nothing until it stops, then draws where it stopped', async () => {
    const scroller = await renderInScroller();
    const frame = manualFrames();
    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(0, 5).includes(id));
    await frame();
    expect(mountedIds()).toEqual(ids.slice(0, 5));

    let top = 0;
    for (const passing of [10, 20, 30]) {
      top += 5_000;
      await scrollTo(scroller, top);
      DrivenIntersectionObserver.current!.deliver((id) => ids.slice(passing, passing + 5).includes(id));
      await frame();
      // Still what it was: nothing it passes mounts, and what it left is not torn down on the way.
      expect(mountedIds()).toEqual(ids.slice(0, 5));
    }

    // One still frame may be a gap in the input; the second is the stop.
    await frame();
    expect(mountedIds()).toEqual(ids.slice(0, 5));
    await frame();
    expect(mountedIds()).toEqual(expect.arrayContaining(ids.slice(30, 35)));
    expect(mountedIds()).not.toContain(ids[10]);
    expect(mountedIds()).not.toContain(ids[20]);
  });

  test.skipIf(!hasDom)('End mounts nothing on its way, however short the way, and draws where it ends', async () => {
    const scroller = await renderInScroller();
    const frame = manualFrames();
    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(0, 5).includes(id));
    await frame();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    for (const [step, passing] of [[100, 5], [200, 10]] as const) {
      // Slow enough that only the key says this is passing.
      await new Promise((done) => setTimeout(done, 40));
      await scrollTo(scroller, step);
      DrivenIntersectionObserver.current!.deliver((id) => ids.slice(passing, passing + 5).includes(id));
      await frame();
      expect(mountedIds()).toEqual(ids.slice(0, 5));
    }

    await frame();
    await frame();
    expect(mountedIds()).toEqual(expect.arrayContaining(ids.slice(10, 15)));
    expect(mountedIds()).not.toContain(ids[5]);
  });

  test.skipIf(!hasDom)('End that moves nothing (a text field has it) does not hold the window up', async () => {
    await renderInScroller();
    const frame = manualFrames();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(0, 5).includes(id));
    for (let i = 0; i < 12; i++) await frame();
    expect(mountedIds()).toEqual(expect.arrayContaining(ids.slice(0, 5)));
  });

  test.skipIf(!hasDom)('the pointer does not mount each file a fast scroll carries under it', async () => {
    let hover: () => void = () => {};
    function Hovered({ id, target }: { id: string; target?: boolean }) {
      const { mounted, register, requestMount } = useGuideFileWindow(id);
      if (target) hover = requestMount;
      return <div ref={register} data-shell={id}>{mounted && <span data-shell-mounted={id} />}</div>;
    }
    await render(
      <div data-scroller="" style={{ overflowY: 'auto' }}>
        <GuideViewportProvider>
          {ids.map((id, index) => <Hovered key={id} id={id} target={index === 20} />)}
        </GuideViewportProvider>
      </div>,
      DrivenIntersectionObserver,
    );
    const scroller = host!.querySelector<HTMLElement>('[data-scroller]')!;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 1_000 });
    const frame = manualFrames();
    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(0, 5).includes(id));
    await frame();

    await scrollTo(scroller, 5_000);
    await frame();
    await act(async () => hover());
    expect(mountedIds()).not.toContain(ids[20]);

    // Still under the pointer when the scroll stops, it draws.
    await frame();
    await frame();
    expect(mountedIds()).toContain(ids[20]);
  });

  test.skipIf(!hasDom)('at rest, what is on screen draws at once and the rest of the window follows one file a frame, nearest first', async () => {
    const scroller = await renderInScroller();
    scroller.getBoundingClientRect = () => new DOMRectReadOnly(0, 0, 1_000, 1_000);
    for (const [index, id] of ids.entries()) {
      scroller.querySelector<HTMLElement>(`[data-shell="${id}"]`)!.getBoundingClientRect = () => new DOMRectReadOnly(0, index * 400, 1_000, 300);
    }
    const frame = manualFrames();

    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(0, 6).includes(id));
    await frame();
    // On screen: tops 0, 400 and 800. The next nearest, top 1,200, comes along in the same step.
    expect(mountedIds()).toEqual(ids.slice(0, 4));
    await frame();
    expect(mountedIds()).toEqual(ids.slice(0, 5));
    await frame();
    expect(mountedIds()).toEqual(ids.slice(0, 6));
  });

  test.skipIf(!hasDom)('when frames fall behind during a scroll, what is on screen still draws and the rest waits a frame', async () => {
    const scroller = await renderInScroller();
    scroller.getBoundingClientRect = () => new DOMRectReadOnly(0, 0, 1_000, 1_000);
    for (const [index, id] of ids.entries()) {
      scroller.querySelector<HTMLElement>(`[data-shell="${id}"]`)!.getBoundingClientRect = () => new DOMRectReadOnly(0, index * 400, 1_000, 300);
    }
    const frame = manualFrames();
    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(0, 2).includes(id));
    await frame();

    // Moving, at a good pace.
    await new Promise((done) => setTimeout(done, 20));
    await scrollTo(scroller, 100);
    await frame();

    // The next frame takes 60 ms: of the files it brings into the window, 0 to 2 are on screen, 3 is nearest, the rest wait.
    await new Promise((done) => setTimeout(done, 60));
    await scrollTo(scroller, 200);
    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(0, 8).includes(id));
    await frame();
    expect(mountedIds()).toEqual(ids.slice(0, 4));
  });

  test.skipIf(!hasDom)('what a fast scroll stops on stays put while the files above it settle', async () => {
    const scroller = await renderInScroller();
    scroller.getBoundingClientRect = () => new DOMRectReadOnly(0, 0, 1_000, 1_000);
    let shift = 0;
    for (const [index, id] of ids.entries()) {
      scroller.querySelector<HTMLElement>(`[data-shell="${id}"]`)!.getBoundingClientRect = () => new DOMRectReadOnly(0, (index - 20) * 400 + 120 + shift, 1_000, 300);
    }
    const frame = manualFrames();
    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(0, 3).includes(id));
    await frame();

    await scrollTo(scroller, 5_000);
    DrivenIntersectionObserver.current!.deliver((id) => ids.slice(18, 24).includes(id));
    await frame();
    await frame();
    await frame();

    // A file above swaps its estimate: everything below moves up with no scroll of its own, and the scroll takes it back.
    shift = -99;
    const before = scroller.scrollTop;
    await frame();
    expect(scroller.scrollTop).toBe(before - 99);
  });

  test.skipIf(!hasDom)('a scrollbar drag that pauses and moves on is not pulled back', async () => {
    const scroller = await renderInScroller();
    scroller.getBoundingClientRect = () => new DOMRectReadOnly(0, 0, 1_000, 1_000);
    const shellTop = () => (20 * 400) - scroller.scrollTop + 120;
    for (const [index, id] of ids.entries()) {
      scroller.querySelector<HTMLElement>(`[data-shell="${id}"]`)!.getBoundingClientRect = () => new DOMRectReadOnly(0, (index - 20) * 400 + shellTop(), 1_000, 300);
    }
    const frame = manualFrames();
    await scrollTo(scroller, 8_000);
    await frame();
    await frame();
    await frame();
    await frame();

    // The thumb moves again, with no pointer event: the view is the person's.
    await scrollTo(scroller, 8_200);
    await frame();
    await frame();
    expect(scroller.scrollTop).toBe(8_200);
  });

  test.skipIf(!hasDom)('before the observer first reports, a scroll keeps the first files instead of flashing them away', async () => {
    const scroller = await renderInScroller();
    const seeded = mountedIds();
    expect(seeded).toEqual(ids.slice(0, 2));

    await scrollTo(scroller, 50);
    await frames(3);
    expect(mountedIds()).toEqual(seeded);
  });

  test.skipIf(!hasDom)('a jump target stays drawn while the window moves on, for as long as the jump needs it', async () => {
    let jump: () => void = () => {};
    function Far({ id, target }: { id: string; target?: boolean }) {
      const { mounted, register, requestMount } = useGuideFileWindow(id);
      if (target) jump = requestMount;
      return <div ref={register} data-shell={id}>{mounted && <span data-shell-mounted={id} />}</div>;
    }
    await render(
      <GuideViewportProvider>
        {ids.map((id, index) => <Far key={id} id={id} target={index === 39} />)}
      </GuideViewportProvider>,
      DrivenIntersectionObserver,
    );
    await deliver((id) => ids.slice(0, 5).includes(id));

    await act(async () => jump());
    await deliver((id) => ids.slice(5, 10).includes(id));
    await frames(3);
    expect(mountedIds()).toContain(ids[39]);
  });

  test.skipIf(!hasDom)('focusing a file far off draws it right away, with no help from the observer', async () => {
    function Pinnable({ id, pinned }: { id: string; pinned: boolean }) {
      const { mounted, register } = useGuideFileWindow(id, pinned);
      return <div ref={register} data-shell={id}>{mounted && <span data-shell-mounted={id} />}</div>;
    }
    const tree = (pinnedIndex: number) => (
      <GuideViewportProvider>
        {ids.map((id, index) => <Pinnable key={id} id={id} pinned={index === pinnedIndex} />)}
      </GuideViewportProvider>
    );
    await render(tree(-1), DrivenIntersectionObserver);
    await deliver((id) => ids.slice(0, 5).includes(id));
    expect(mountedIds()).not.toContain(ids[30]);

    await act(async () => root!.render(tree(30)));
    expect(mountedIds()).toContain(ids[30]);
  });

  test.skipIf(!hasDom)('a focused file and a jump target far off draw beside the window, taking nothing from it', async () => {
    let jump: () => void = () => {};
    function Far({ id, pinned, target }: { id: string; pinned?: boolean; target?: boolean }) {
      const { mounted, register, requestMount } = useGuideFileWindow(id, pinned);
      if (target) jump = requestMount;
      return (
        <div ref={register} data-shell={id}>
          {mounted && <span data-shell-mounted={id} />}
        </div>
      );
    }
    await render(
      <GuideViewportProvider>
        {ids.map((id, index) => <Far key={id} id={id} pinned={index === 0} target={index === 39} />)}
      </GuideViewportProvider>,
      DrivenIntersectionObserver,
    );

    const inWindow = ids.slice(10, 30);
    await deliver((id) => inWindow.includes(id));
    expect(mountedIds()).toEqual([ids[0], ...inWindow]);

    await act(async () => jump());
    expect(mountedIds()).toEqual([ids[0], ...inWindow, ids[39]]);
  });
});

describe('a jump', () => {
  const ids = Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`);
  const originalScrollIntoView = hasDom ? HTMLElement.prototype.scrollIntoView : undefined;
  afterEach(() => {
    if (hasDom) HTMLElement.prototype.scrollIntoView = originalScrollIntoView!;
  });

  /**
   * A view 1,000 px tall over shells with a settable place. Its scrollIntoView does what the browser's does at once: it
   * puts the shell at 16 px from the top (its scroll margin). A smooth one is left to `finishSmooth`.
   */
  async function setup(startTop: number) {
    const calls: string[] = [];
    let targetTop = startTop;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
      const behavior = typeof options === 'object' ? options.behavior ?? 'auto' : 'auto';
      calls.push(behavior);
      if (behavior === 'instant') targetTop = 16;
    };
    let jump: () => void = () => {};
    function Target({ id, target }: { id: string; target?: boolean }) {
      const { mounted, register, jumpTo } = useGuideFileWindow(id);
      if (target) jump = jumpTo;
      return <div ref={register} data-shell={id} style={{ scrollMarginTop: 16 }}>{mounted && <span data-shell-mounted={id} />}</div>;
    }
    await render(
      <div data-scroller="" style={{ overflowY: 'auto' }}>
        <GuideViewportProvider>
          {ids.map((id, index) => <Target key={id} id={id} target={index === 20} />)}
        </GuideViewportProvider>
      </div>,
      DrivenIntersectionObserver,
    );
    const scroller = host!.querySelector<HTMLElement>('[data-scroller]')!;
    scroller.getBoundingClientRect = () => new DOMRectReadOnly(0, 0, 1_000, 1_000);
    const shell = scroller.querySelector<HTMLElement>(`[data-shell="${ids[20]}"]`)!;
    shell.getBoundingClientRect = () => new DOMRectReadOnly(0, targetTop, 1_000, 300);
    return {
      calls,
      jump: () => act(async () => jump()),
      moveTarget: (top: number) => {
        targetTop = top;
      },
      top: () => targetTop,
      frames: (count: number) =>
        act(async () => {
          for (let i = 0; i < count; i++) await new Promise((done) => requestAnimationFrame(done));
        }),
    };
  }

  test.skipIf(!hasDom)('more than two views away goes at once, and what it lands on draws in the same frame', async () => {
    const view = await setup(2_100);
    await view.jump();
    expect(view.calls).toEqual(['instant']);
    expect(mountedIds()).toContain(ids[20]);
  });

  test.skipIf(!hasDom)('within two views stays smooth', async () => {
    const view = await setup(1_900);
    await view.jump();
    expect(view.calls).toEqual(['smooth']);
  });

  test.skipIf(!hasDom)('files above swapping their height do not move the target off its place', async () => {
    const view = await setup(5_000);
    await view.jump();
    await view.frames(2);

    view.moveTarget(-599);
    await view.frames(2);
    expect(view.top()).toBe(16);
  });

  test.skipIf(!hasDom)('a smooth jump is left alone while it runs, then corrected where it stopped', async () => {
    const view = await setup(1_000);
    await view.jump();

    // Still on its way: moving every frame, and no instant scroll cuts it short.
    for (const top of [800, 500, 200]) {
      view.moveTarget(top);
      await view.frames(1);
    }
    expect(view.calls).toEqual(['smooth']);

    // It ended on the old estimate, short of the place.
    view.moveTarget(-90);
    await view.frames(5);
    expect(view.top()).toBe(16);
    expect(view.calls.at(-1)).toBe('instant');
  });

  test.skipIf(!hasDom)('the person scrolling first takes the view back', async () => {
    const view = await setup(5_000);
    await view.jump();
    await view.frames(1);

    await act(async () => {
      window.dispatchEvent(new Event('wheel'));
    });
    view.moveTarget(300);
    await view.frames(4);
    expect(view.top()).toBe(300);
  });

  test.skipIf(!hasDom)('once settled the jump lets go: a later height change is not pulled back', async () => {
    const view = await setup(5_000);
    await view.jump();
    await view.frames(12);
    const scrolls = view.calls.length;

    view.moveTarget(300);
    await view.frames(4);
    expect(view.top()).toBe(300);
    expect(view.calls.length).toBe(scrolls);
  });
});

describe('GuideView eager threshold', () => {
  function renderGuide(files: DiffFile[], hostFiles: DiffFile[] = files) {
    return render(
      <GuideHostProvider value={makeHost(hostFiles)}>
        <GuideView
          guide={makeGuide(files)}
          reviewed={[false]}
          onToggleReviewed={() => {}}
          focusedFile={null}
          onFocusFile={() => {}}
        />
      </GuideHostProvider>,
    );
  }

  test.skipIf(!hasDom)('a guide at the file limit mounts every CodeView up front, however large the review', async () => {
    // The threshold counts the guide's own files, not the whole review behind the host.
    const review = Array.from({ length: GUIDE_EAGER_MOUNT_MAX_FILES + 10 }, (_, index) => makeFile(`src/file-${index}.ts`));
    const files = review.slice(0, GUIDE_EAGER_MOUNT_MAX_FILES);
    await renderGuide(files, review);

    expect(host!.querySelectorAll('[data-guide-file-shell]')).toHaveLength(files.length);
    expect(host!.querySelectorAll('[data-testid="file-code-view"]')).toHaveLength(files.length);
  });

  test.skipIf(!hasDom)('one file over the limit runs the window: only the seed before the observer delivers', async () => {
    const files = Array.from({ length: GUIDE_EAGER_MOUNT_MAX_FILES + 1 }, (_, index) => makeFile(`src/file-${index}.ts`));
    await renderGuide(files);

    expect(host!.querySelectorAll('[data-guide-file-shell]')).toHaveLength(files.length);
    const mounted = host!.querySelectorAll('[data-testid="file-code-view"]').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(files.length);
  });
});
