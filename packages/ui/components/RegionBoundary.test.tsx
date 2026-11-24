/**
 * A part that throws while it draws fails alone (RegionBoundary.tsx).
 *
 * What regresses if these fail:
 * - a render error unmounts the whole window again (a blank page);
 * - the region's notice loses its words or a way out (Try again, Reload, Copy error);
 * - a region beside the failed one remounts, stops answering, or loses what was typed in it;
 * - Try again stops drawing the region afresh;
 * - Copy error stops carrying what a bug report needs (name, message, stack, version, browser);
 * - "Your work is saved." shows where the host did not say it is true;
 * - a DOM test that draws something broken stops failing (the boundary must let it through there).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { catchRenderErrorsInTests, RegionBoundary, renderErrorReport } from './RegionBoundary';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: Array<() => void> = [];

afterEach(async () => {
  if (root) {
    const done = root;
    root = null;
    try {
      await act(async () => done.unmount());
    } catch {
      // A root a test left broken on purpose.
    }
  }
  broken.on = false;
  host?.remove();
  host = null;
  while (restores.length > 0) restores.pop()!();
});

/** The console lines a caught render error makes (React's and the boundary's), kept for the test to read. */
function captureConsoleError(): unknown[][] {
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args);
  };
  restores.push(() => {
    console.error = original;
  });
  return lines;
}

function catching(): void {
  restores.push(catchRenderErrorsInTests());
}

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
  return host;
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Throws while `broken.on` is set: the "+" that blanked the window, on demand. */
const broken = { on: false };
function Diff() {
  const [opened, setOpened] = useState(0);
  if (broken.on) throw new TypeError('can\'t access property "side", range is undefined');
  return (
    <button type="button" data-testid="plus" onClick={() => setOpened((n) => n + 1)}>
      + {opened}
    </button>
  );
}

/** The window around the region: a list that counts clicks and a box holding typed words. */
function Sidebar() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button type="button" data-testid="row" onClick={() => setCount((n) => n + 1)}>
        {`rows ${count}`}
      </button>
      <textarea data-testid="reply" defaultValue="" />
    </div>
  );
}

function Window({ resetKey }: { resetKey?: string }) {
  return (
    <div>
      <Sidebar />
      <RegionBoundary name="Diff" resetKey={resetKey}>
        <Diff />
      </RegionBoundary>
    </div>
  );
}

/** The window with a button that draws it again (a state change above the region), so a set `broken.on` throws. */
function Trigger() {
  const [, setTick] = useState(0);
  return (
    <>
      <button type="button" data-testid="break" onClick={() => setTick((n) => n + 1)} />
      <Window />
    </>
  );
}

describe('RegionBoundary', () => {
  test.skipIf(!hasDom)('a region that throws says so in its place; the window beside it stays mounted and answers', async () => {
    catching();
    const logged = captureConsoleError();
    const el = await mount(<Trigger />);
    const reply = el.querySelector<HTMLTextAreaElement>('[data-testid="reply"]')!;
    reply.value = 'half a reply';
    await click(el.querySelector('[data-testid="row"]'));

    broken.on = true;
    await click(el.querySelector('[data-testid="break"]'));

    const notice = el.querySelector('[data-region-failed="Diff"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("This part didn't load");
    expect(notice!.textContent).toContain('Something went wrong drawing it.');
    // Not said unless the host says it is true: an open comment box's words live in memory only.
    expect(notice!.textContent).not.toContain('Your work is saved.');
    expect([...notice!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Try again', 'Reload', 'Copy error']);
    expect(el.querySelector('[data-testid="plus"]')).toBeNull();

    // The same nodes, the same words and state beside it, and they still answer.
    expect(el.querySelector('[data-testid="reply"]')).toBe(reply);
    expect(reply.value).toBe('half a reply');
    await click(el.querySelector('[data-testid="row"]'));
    expect(el.querySelector('[data-testid="row"]')!.textContent).toBe('rows 2');

    // The console names the region and carries the error.
    expect(logged.some((args) => String(args[0]).includes('Diff failed to draw') && args[1] instanceof TypeError)).toBe(true);
  });

  test.skipIf(!hasDom)('Try again draws the region afresh', async () => {
    catching();
    captureConsoleError();
    const el = await mount(<Trigger />);
    await click(el.querySelector('[data-testid="plus"]'));
    expect(el.querySelector('[data-testid="plus"]')!.textContent).toBe('+ 1');
    broken.on = true;
    await click(el.querySelector('[data-testid="break"]'));
    expect(el.querySelector('[data-region-failed]')).not.toBeNull();

    // Still broken: Try again fails again, in place, and the window is still there.
    await click(el.querySelector('[data-region-try-again]'));
    expect(el.querySelector('[data-region-failed]')).not.toBeNull();
    expect(el.querySelector('[data-testid="row"]')).not.toBeNull();

    broken.on = false;
    await click(el.querySelector('[data-region-try-again]'));
    expect(el.querySelector('[data-region-failed]')).toBeNull();
    // Mounted afresh: its own state starts over.
    expect(el.querySelector('[data-testid="plus"]')!.textContent).toBe('+ 0');
  });

  test.skipIf(!hasDom)('a new resetKey tries again by itself (another thread opens in the pane)', async () => {
    catching();
    captureConsoleError();
    broken.on = true;
    const el = await mount(<Window resetKey="thread-a" />);
    expect(el.querySelector('[data-region-failed]')).not.toBeNull();
    broken.on = false;
    await act(async () => root!.render(<Window resetKey="thread-a" />));
    expect(el.querySelector('[data-region-failed]')).not.toBeNull();
    await act(async () => root!.render(<Window resetKey="thread-b" />));
    expect(el.querySelector('[data-region-failed]')).toBeNull();
    expect(el.querySelector('[data-testid="plus"]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('Copy error copies the error, where, the version and the browser', async () => {
    catching();
    captureConsoleError();
    const copied: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    restores.push(() => {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    });
    broken.on = true;
    const el = await mount(<Window />);
    await click(el.querySelector('[data-region-copy]'));

    expect(copied).toHaveLength(1);
    const text = copied[0]!;
    expect(text.startsWith('TypeError: can\'t access property "side", range is undefined\n')).toBe(true);
    // The stack's frames, then where, the version and the browser, in that order.
    const [errorPart, tail] = text.split('\n\n');
    expect(errorPart!.split('\n').length).toBeGreaterThan(1);
    expect(tail!.split('\n')).toEqual(['Where: Diff', 'Plannotator unknown', navigator.userAgent]);
    expect(el.querySelector('[data-region-copy]')!.textContent).toBe('Copied');
  });

  test('the report keeps a stack without its header (Firefox, Safari) and a thrown non-Error', () => {
    const firefox = new TypeError('x is undefined');
    firefox.stack = 'Diff@http://localhost:19432/assets/review.js:10:5\nrender@http://localhost:19432/assets/review.js:20:3\n';
    expect(renderErrorReport(firefox, 'Diff', '0.29.3', 'Mozilla/5.0 Firefox/140.0')).toBe(
      'TypeError: x is undefined\nDiff@http://localhost:19432/assets/review.js:10:5\nrender@http://localhost:19432/assets/review.js:20:3\n\nWhere: Diff\nPlannotator 0.29.3\nMozilla/5.0 Firefox/140.0',
    );
    expect(renderErrorReport('a string', 'Thread pane', '0.29.3', 'UA')).toBe('a string\n\nWhere: Thread pane\nPlannotator 0.29.3\nUA');
  });

  test.skipIf(!hasDom)('says "Your work is saved." only where the host says so', async () => {
    catching();
    captureConsoleError();
    broken.on = true;
    const el = await mount(
      <RegionBoundary name="List" saved>
        <Diff />
      </RegionBoundary>,
    );
    expect(el.querySelector('[data-region-failed="List"]')!.textContent).toContain('Something went wrong drawing it. Your work is saved.');
  });

  test.skipIf(!hasDom)('in a DOM test that did not ask for it, the error is not caught: the test still fails', async () => {
    captureConsoleError();
    broken.on = true;
    let thrown: unknown = null;
    try {
      await mount(<Window />);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(host!.querySelector('[data-region-failed]')).toBeNull();
  });
});
