/**
 * Opening a code file from a `file.ts:250` reference brings line 250 into
 * view (#1784). Pierre draws the lines into a shadow root, sometimes well
 * after mount, so the scroll waits for the line itself instead of a delay.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { whenCodeLineRendered } from '../utils/codeLineScroll';

const hasDom = typeof document !== 'undefined';

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

let root: Root | null = null;
let host: HTMLElement | null = null;
const realScrollIntoView = hasDom ? HTMLElement.prototype.scrollIntoView : undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (hasDom) HTMLElement.prototype.scrollIntoView = realScrollIntoView!;
});

function lineDiv(line: number): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-line', String(line));
  return el;
}

describe.if(hasDom)('whenCodeLineRendered', () => {
  test('waits for a line drawn later inside a shadow root that appears later', async () => {
    const area = document.createElement('div');
    document.body.appendChild(area);
    const found: HTMLElement[] = [];
    const stop = whenCodeLineRendered(area, 40, (el) => found.push(el));

    const container = document.createElement('diffs-container');
    const shadow = container.attachShadow({ mode: 'open' });
    area.appendChild(container);
    await nextFrame();
    expect(found).toHaveLength(0);

    shadow.appendChild(lineDiv(39));
    await nextFrame();
    expect(found).toHaveLength(0);

    const target = lineDiv(40);
    shadow.appendChild(target);
    await nextFrame();
    await nextFrame();
    expect(found).toEqual([target]);

    // Called once, even when the file is drawn again.
    shadow.replaceChildren(lineDiv(40));
    await nextFrame();
    await nextFrame();
    expect(found).toHaveLength(1);
    stop();
    area.remove();
  });

  test('a line past the end of the file is never waited for', async () => {
    const area = document.createElement('div');
    document.body.appendChild(area);
    const found: HTMLElement[] = [];
    whenCodeLineRendered(area, 31, (el) => found.push(el), { lineCount: 30 });
    whenCodeLineRendered(area, 0, (el) => found.push(el));
    area.append(lineDiv(31), lineDiv(0));
    await nextFrame();
    await nextFrame();
    expect(found).toHaveLength(0);
    area.remove();
  });

  test('gives up when the line never comes within the time limit', async () => {
    const area = document.createElement('div');
    document.body.appendChild(area);
    const found: HTMLElement[] = [];
    whenCodeLineRendered(area, 5, (el) => found.push(el), { timeoutMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    area.appendChild(lineDiv(5));
    await nextFrame();
    await nextFrame();
    expect(found).toHaveLength(0);
    area.remove();
  });

  test('stopping before the line appears never calls back', async () => {
    const area = document.createElement('div');
    document.body.appendChild(area);
    const found: HTMLElement[] = [];
    const stop = whenCodeLineRendered(area, 7, (el) => found.push(el));
    stop();
    area.appendChild(lineDiv(7));
    await nextFrame();
    await nextFrame();
    expect(found).toHaveLength(0);
    area.remove();
  });
});

describe.if(hasDom)('CodeFileView with a referenced line', () => {
  const contents = Array.from({ length: 300 }, (_, i) => `const x${i + 1} = ${i + 1};`).join('\n');

  let scrolled: string[] = [];

  async function waitForScroll(count: number): Promise<void> {
    for (let i = 0; i < 50 && scrolled.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async function renderView(props: Record<string, unknown>): Promise<string[]> {
    scrolled = [];
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute('data-line') ?? this.getAttribute('data-code-annotation-id') ?? this.tagName);
    };
    const { CodeFileView } = await import('./CodeFilePopout');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<CodeFileView filepath="/repo/src/big.ts" contents={contents} {...props} />));
    await waitForScroll(1);
    return scrolled;
  }

  const lineElement = (line: number) =>
    host!.querySelector('diffs-container')?.shadowRoot?.querySelector(`[data-line="${line}"]`) ?? null;

  test('scrolls to the referenced line and marks it selected', async () => {
    const scrolled = await renderView({ line: 250 });
    expect(scrolled).toEqual(['250']);
    expect(lineElement(250)?.hasAttribute('data-selected-line')).toBe(true);
  });

  test('marks a referenced range', async () => {
    const scrolled = await renderView({ line: 120, lineEnd: 123 });
    expect(scrolled).toEqual(['120']);
    for (const line of [120, 121, 122, 123]) expect(lineElement(line)?.hasAttribute('data-selected-line')).toBe(true);
    expect(lineElement(124)?.hasAttribute('data-selected-line')).toBe(false);
  });

  test('a line past the end of the file scrolls nowhere', async () => {
    expect(await renderView({ line: 400 })).toEqual([]);
  });

  test('reopening the same file and line scrolls to it again', async () => {
    const { CodeFileView } = await import('./CodeFilePopout');
    await renderView({ line: 250, revealKey: 1 });
    expect(scrolled).toEqual(['250']);
    await act(async () => root!.render(<CodeFileView filepath="/repo/src/big.ts" contents={contents} line={250} revealKey={2} />));
    await waitForScroll(2);
    expect(scrolled).toEqual(['250', '250']);
  });

  test('without a line nothing scrolls', async () => {
    const scrolled = await renderView({});
    expect(scrolled).toEqual([]);
  });
});

describe.if(hasDom)('scrollCodeLineIntoView', () => {
  test('a short file with nothing to scroll down: the line is brought on screen, never slid sideways', async () => {
    const { scrollCodeLineIntoView } = await import('../utils/codeLineScroll');
    // A code block scrolled sideways by nothing, inside Pierre's shadow root, and a line wider than it.
    const area = document.createElement('div');
    document.body.appendChild(area);
    // (A plain host: Pierre's own element is registered by now and makes its own shadow root.)
    const container = document.createElement('div');
    const shadow = container.attachShadow({ mode: 'open' });
    const pre = document.createElement('pre');
    const row = lineDiv(3);
    pre.appendChild(row);
    shadow.appendChild(pre);
    area.appendChild(container);
    let asked: ScrollIntoViewOptions | boolean | undefined;
    // The browser's scrollIntoView slides the block to the long row's start (the gutter's width).
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: ScrollIntoViewOptions | boolean) {
      asked = options;
      pre.scrollLeft = 64;
    };
    scrollCodeLineIntoView(row);
    expect(asked).toEqual({ block: 'center', inline: 'nearest' });
    expect(pre.scrollLeft).toBe(0);
    area.remove();
  });
});
