/**
 * A part that throws while it draws fails alone (RegionBoundary.tsx).
 *
 * What regresses if these fail:
 * - a render error unmounts the whole window again (a blank page);
 * - the region's notice loses its words or a way out (Try again, Reload, Copy error, and a closable region's Back);
 * - a region beside the failed one remounts, stops answering, or loses what was typed in it;
 * - Try again stops drawing the region afresh, or stops letting the host clear what failed it first;
 * - Copy error stops carrying what a bug report needs (name, message, stack, version, browser), or copies an
 *   address's query or hash;
 * - focus that was in the region is dropped on the page's body; "Copied" is said with the whole notice again;
 * - the console gets a second or third copy of one failure;
 * - a browser proof's switch stops failing the region it names, or fails another;
 * - a DOM test that draws something broken stops failing (the boundary must let it through there).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { catchRenderErrorsInTests, onCaughtRenderError, RegionBoundary, renderErrorReport, stripAddressQueries } from './RegionBoundary';

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
  delete (globalThis as { __plannotatorBreakRegionForTests?: unknown }).__plannotatorBreakRegionForTests;
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

async function mount(element: React.ReactElement, options?: Parameters<typeof createRoot>[1]): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host, options);
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
    <>
      <button type="button" data-testid="plus" onClick={() => setOpened((n) => n + 1)}>
        + {opened}
      </button>
      <textarea data-testid="comment" defaultValue="" />
    </>
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
    // A region the host cannot close has no Back.
    expect([...notice!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Try again', 'Reload', 'Copy error']);
    expect(el.querySelector('[data-testid="plus"]')).toBeNull();

    // The same nodes, the same words and state beside it, and they still answer.
    expect(el.querySelector('[data-testid="reply"]')).toBe(reply);
    expect(reply.value).toBe('half a reply');
    await click(el.querySelector('[data-testid="row"]'));
    expect(el.querySelector('[data-testid="row"]')!.textContent).toBe('rows 2');

    // The boundary writes no console line of its own (React's, or the page's `reportError`, is the one).
    expect(logged.some((args) => String(args[0]).includes('[plannotator]'))).toBe(false);
  });

  test.skipIf(!hasDom)("a region the host can close: its Back, in the host's words, in the one row, closes it", async () => {
    catching();
    captureConsoleError();
    broken.on = true;
    let closed = 0;
    const el = await mount(
      <RegionBoundary name="Thread pane" onClose={() => (closed += 1)} closeLabel="Back to Inbox">
        <Diff />
      </RegionBoundary>,
    );
    const buttons = [...el.querySelectorAll('[data-region-failed="Thread pane"] button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Try again', 'Reload', 'Copy error', 'Back to Inbox']);
    // One wrapping row: the four share one parent.
    expect(new Set(buttons.map((b) => b.parentElement)).size).toBe(1);
    await click(el.querySelector('[data-region-close]'));
    expect(closed).toBe(1);
  });

  test.skipIf(!hasDom)('Try again lets the host clear what failed the region first (a selection kept above it)', async () => {
    catching();
    captureConsoleError();
    const calls: string[] = [];
    /** The host holds the selection; the diff throws while one is set (the "+" that blanked the window). */
    function Host() {
      const [selection, setSelection] = useState<number | null>(null);
      return (
        <>
          <button type="button" data-testid="select" onClick={() => setSelection(3)} />
          <RegionBoundary
            name="Diff"
            onRetry={() => {
              calls.push('retry');
              setSelection(null);
            }}
          >
            <Selected selection={selection} />
          </RegionBoundary>
        </>
      );
    }
    function Selected({ selection }: { selection: number | null }) {
      calls.push(`draw ${selection}`);
      if (selection !== null) throw new TypeError('range is undefined');
      return <div data-testid="diff" />;
    }
    const el = await mount(<Host />);
    await click(el.querySelector('[data-testid="select"]'));
    expect(el.querySelector('[data-region-failed="Diff"]')).not.toBeNull();
    calls.length = 0;
    await click(el.querySelector('[data-region-try-again]'));
    expect(el.querySelector('[data-region-failed]')).toBeNull();
    expect(el.querySelector('[data-testid="diff"]')).not.toBeNull();
    // Cleared before the region drew again: it never drew with the selection that failed it.
    expect(calls[0]).toBe('retry');
    expect(calls.filter((c) => c.startsWith('draw'))).not.toContain('draw 3');
  });

  test.skipIf(!hasDom)('focus that was in the region goes to Try again; focus beside it stays where it is', async () => {
    catching();
    captureConsoleError();
    const el = await mount(<Trigger />);
    el.querySelector<HTMLTextAreaElement>('[data-testid="comment"]')!.focus();
    broken.on = true;
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="break"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.activeElement).toBe(el.querySelector('[data-region-try-again]'));

    // Focus in the list beside the region: the region failing again leaves it there.
    broken.on = false;
    await click(el.querySelector('[data-region-try-again]'));
    const reply = el.querySelector<HTMLTextAreaElement>('[data-testid="reply"]')!;
    reply.focus();
    broken.on = true;
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="break"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(el.querySelector('[data-region-failed]')).not.toBeNull();
    expect(document.activeElement).toBe(reply);
  });

  test.skipIf(!hasDom)('the notice is said once; only the Copy button\'s word is said when it changes', async () => {
    catching();
    captureConsoleError();
    broken.on = true;
    const el = await mount(<Window />);
    const alert = el.querySelector('[data-region-failed] [role="alert"]')!;
    expect(alert.textContent).toBe("This part didn't loadSomething went wrong drawing it.");
    // The buttons, and what Copy error says after a press, are not part of the alert.
    expect(alert.querySelector('button')).toBeNull();
    expect(alert.contains(el.querySelector('[data-region-copy]'))).toBe(false);
    const word = el.querySelector('[data-region-copy] [aria-live="polite"]');
    expect(word?.textContent).toBe('Copy error');
  });

  test.skipIf(!hasDom)("one failure, one console line: an app root's onCaughtRenderError leaves React's copy out", async () => {
    catching();
    const logged = captureConsoleError();
    broken.on = true;
    const el = await mount(<Window />, { onCaughtError: onCaughtRenderError });
    expect(el.querySelector('[data-region-failed="Diff"]')).not.toBeNull();
    // Under the act environment the boundary's reportError is off too: nothing at all here, where the page gets one.
    expect(logged).toEqual([]);
    // An error another boundary caught is still logged, as React would.
    const other = new Error('a chunk that cannot load');
    onCaughtRenderError(other, { errorBoundary: {} });
    expect(logged).toEqual([[other]]);
  });

  test.skipIf(!hasDom)("a browser proof's switch fails the region it names, and only that one", async () => {
    catching();
    captureConsoleError();
    (globalThis as { __plannotatorBreakRegionForTests?: unknown }).__plannotatorBreakRegionForTests = 'Thread pane';
    const el = await mount(
      <>
        <RegionBoundary name="Thread pane">
          <div data-testid="pane" />
        </RegionBoundary>
        <RegionBoundary name="Diff">
          <div data-testid="diff" />
        </RegionBoundary>
      </>,
    );
    expect(el.querySelector('[data-region-failed="Thread pane"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="pane"]')).toBeNull();
    expect(el.querySelector('[data-region-failed="Diff"]')).toBeNull();
    expect(el.querySelector('[data-testid="diff"]')).not.toBeNull();
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

  test("the report keeps each address's origin, path and line:column, and drops its query and hash", () => {
    const chrome = new TypeError('Failed to fetch http://127.0.0.1:19432/api/file-content?path=src%2Fberth.swift&base=main#L4');
    chrome.stack = [
      'TypeError: Failed to fetch http://127.0.0.1:19432/api/file-content?path=src%2Fberth.swift&base=main#L4',
      '    at Diff (http://127.0.0.1:19432/assets/review.js?v=0.29.3:10:5)',
      '    at blob:http://127.0.0.1:19432/2f1e?token=abc:3:9',
      '    at render (http://127.0.0.1:19432/assets/review.js:20:3)',
    ].join('\n');
    const text = renderErrorReport(chrome, 'Diff', '0.29.3', 'UA');
    expect(text).toBe(
      [
        'TypeError: Failed to fetch http://127.0.0.1:19432/api/file-content',
        '    at Diff (http://127.0.0.1:19432/assets/review.js:10:5)',
        '    at blob:http://127.0.0.1:19432/2f1e:3:9',
        '    at render (http://127.0.0.1:19432/assets/review.js:20:3)',
        '',
        'Where: Diff',
        'Plannotator 0.29.3',
        'UA',
      ].join('\n'),
    );
    // Firefox's frames: name@address:line:col, the hash before the place.
    expect(stripAddressQueries('Diff@http://localhost:19432/assets/review.js?x=1#top:10:5')).toBe('Diff@http://localhost:19432/assets/review.js:10:5');
    // Text with no address, or an address with nothing to drop, is untouched.
    expect(stripAddressQueries('range is undefined at http://localhost:19432/assets/review.js:1:2')).toBe('range is undefined at http://localhost:19432/assets/review.js:1:2');
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
