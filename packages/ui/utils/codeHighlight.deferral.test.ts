import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  __resetCodeHighlightCacheForTests,
  __setCodeHighlightModuleForTests,
  applyHighlight,
  ensureHighlight,
  flushPendingHighlights,
  isHighlightPending,
  setCodeHighlightWorker,
  setDeferOffscreenCodeHighlight,
  type CodeHighlightWorker,
} from './codeHighlight';

const hasDom = typeof document !== 'undefined';

const LANG = 'typescript';
const THEME = 'pierre-dark';
const OTHER_THEME = 'pierre-light';
const COLOR: Record<string, string> = { [THEME]: '#79c0ff', [OTHER_THEME]: '#0550ae' };

function markupFor(code: string, theme = THEME): string {
  return code
    .split('\n')
    .map((line) => (line ? `<span style="color:${COLOR[theme]}">${line}</span>` : ''))
    .join('\n');
}

const fakePierre = {
  getSharedHighlighter: () => Promise.resolve(undefined),
  getHighlighterIfLoaded: () => ({
    codeToTokens: (code: string, { theme }: { theme: string }) => ({
      tokens: code.split('\n').map((line) => (line ? [{ content: line, color: COLOR[theme] }] : [])),
    }),
  }),
} as unknown as typeof import('@pierre/diffs');

class StandInResizeObserver {
  static all: StandInResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    StandInResizeObserver.all.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
  }
  notice(): void {
    if (this.observed.size === 0) return;
    const entries = [...this.observed].map((target) => ({ target }) as unknown as ResizeObserverEntry);
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

function layoutNotice(): void {
  for (const observer of StandInResizeObserver.all) observer.notice();
}

let idleQueue: Array<() => void> = [];
function runIdle(): void {
  for (let round = 0; round < 100 && idleQueue.length > 0; round++) {
    const due = idleQueue;
    idleQueue = [];
    for (const callback of due) callback();
  }
}

const saved: Record<string, unknown> = {};
const fences: HTMLElement[] = [];

function fence(top: number, height = 120): HTMLElement {
  const el = document.createElement('code');
  document.body.appendChild(el);
  fences.push(el);
  place(el, top, height);
  return el;
}

function place(el: HTMLElement, top: number, height = 120): void {
  const width = height === 0 ? 0 : 600;
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

const highlighted = (el: HTMLElement) => el.querySelector('span') !== null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe.if(hasDom)('deferOffscreenCodeHighlight', () => {
  const screen = () => window.innerHeight;

  beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    saved.ResizeObserver = g.ResizeObserver;
    saved.requestIdleCallback = g.requestIdleCallback;
    saved.cancelIdleCallback = g.cancelIdleCallback;
    g.ResizeObserver = StandInResizeObserver;
    g.requestIdleCallback = (callback: () => void) => {
      idleQueue.push(callback);
      return idleQueue.length;
    };
    g.cancelIdleCallback = () => {
      idleQueue = [];
    };
  });

  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    g.ResizeObserver = saved.ResizeObserver;
    g.requestIdleCallback = saved.requestIdleCallback;
    g.cancelIdleCallback = saved.cancelIdleCallback;
    __setCodeHighlightModuleForTests(undefined);
    __resetCodeHighlightCacheForTests();
  });

  beforeEach(async () => {
    __resetCodeHighlightCacheForTests();
    __setCodeHighlightModuleForTests(fakePierre);
    expect(await ensureHighlight(LANG, THEME)).toBe(true);
  });

  afterEach(() => {
    setDeferOffscreenCodeHighlight(false);
    setCodeHighlightWorker(null);
    idleQueue = [];
    for (const el of fences.splice(0)) el.remove();
  });

  test('a host that does not turn it on highlights every fence as it mounts', () => {
    const far = fence(screen() * 10);
    applyHighlight(far, 'const far = 1;', LANG, THEME);
    expect(far.innerHTML).toBe(markupFor('const far = 1;'));
    expect(isHighlightPending(far)).toBe(false);
  });

  test('a fence on screen is highlighted at its first layout notice, before it paints', () => {
    setDeferOffscreenCodeHighlight(true);
    const el = fence(100);
    applyHighlight(el, 'const onScreen = 1;', LANG, THEME);
    expect(el.textContent).toBe('const onScreen = 1;');
    layoutNotice();
    expect(el.innerHTML).toBe(markupFor('const onScreen = 1;'));
  });

  test('a fence a screen away counts as near and is highlighted too', () => {
    setDeferOffscreenCodeHighlight(true);
    const below = fence(screen() + screen() / 2);
    const above = fence(-screen() / 2 - 120);
    applyHighlight(below, 'const below = 1;', LANG, THEME);
    applyHighlight(above, 'const above = 1;', LANG, THEME);
    layoutNotice();
    expect(highlighted(below)).toBe(true);
    expect(highlighted(above)).toBe(true);
  });

  test('a fence far off screen keeps its plain text until a scroll brings it near', () => {
    setDeferOffscreenCodeHighlight(true);
    const el = fence(screen() * 8);
    const code = 'export function far() {\n  return 1;\n}';
    applyHighlight(el, code, LANG, THEME);
    layoutNotice();
    expect(highlighted(el)).toBe(false);
    expect(el.textContent).toBe(code);
    expect(isHighlightPending(el)).toBe(true);

    place(el, 200);
    document.dispatchEvent(new Event('scroll'));
    expect(el.innerHTML).toBe(markupFor(code));
    expect(isHighlightPending(el)).toBe(false);
  });

  test('the fences left off screen are highlighted in idle time', () => {
    setDeferOffscreenCodeHighlight(true);
    const far = [fence(screen() * 5), fence(screen() * 9), fence(screen() * 20)];
    far.forEach((el, i) => applyHighlight(el, `const n${i} = ${i};`, LANG, THEME));
    layoutNotice();
    expect(far.some(highlighted)).toBe(false);
    runIdle();
    far.forEach((el, i) => expect(el.innerHTML).toBe(markupFor(`const n${i} = ${i};`)));
  });

  test('a fence in a hidden part waits until it is shown, then is highlighted before it paints', () => {
    setDeferOffscreenCodeHighlight(true);
    const el = fence(100, 0);
    applyHighlight(el, 'const folded = 1;', LANG, THEME);
    layoutNotice();
    runIdle();
    expect(highlighted(el)).toBe(false);
    place(el, 100);
    layoutNotice();
    expect(highlighted(el)).toBe(true);
  });

  test('printing highlights every waiting fence first', () => {
    setDeferOffscreenCodeHighlight(true);
    const far = fence(screen() * 30);
    const hidden = fence(0, 0);
    applyHighlight(far, 'const printed = 1;', LANG, THEME);
    applyHighlight(hidden, 'const alsoPrinted = 1;', LANG, THEME);
    layoutNotice();
    window.dispatchEvent(new Event('beforeprint'));
    expect(highlighted(far)).toBe(true);
    expect(highlighted(hidden)).toBe(true);
  });

  test('flushPendingHighlights(root) finishes the waiting fences inside root only', () => {
    setDeferOffscreenCodeHighlight(true);
    const inside = fence(screen() * 6);
    const outside = fence(screen() * 7);
    const root = document.createElement('div');
    document.body.appendChild(root);
    fences.push(root);
    root.appendChild(inside);
    applyHighlight(inside, 'const hit = 1;', LANG, THEME);
    applyHighlight(outside, 'const other = 1;', LANG, THEME);
    layoutNotice();
    flushPendingHighlights(root);
    expect(highlighted(inside)).toBe(true);
    expect(highlighted(outside)).toBe(false);
  });

  test('turning it off highlights every waiting fence', () => {
    setDeferOffscreenCodeHighlight(true);
    const el = fence(screen() * 12);
    applyHighlight(el, 'const waiting = 1;', LANG, THEME);
    layoutNotice();
    setDeferOffscreenCodeHighlight(false);
    expect(el.innerHTML).toBe(markupFor('const waiting = 1;'));
  });

  test('markup made by a worker is written as it is; a fence it could not make is highlighted on the page', async () => {
    const asked: string[] = [];
    const worker: CodeHighlightWorker = {
      html: async (code) => {
        asked.push(code);
        return code === 'const fromWorker = 1;' ? `<span style="color:#00ff00">${code}</span>` : null;
      },
    };
    setCodeHighlightWorker(worker);
    setDeferOffscreenCodeHighlight(true);
    const made = fence(screen() * 6);
    const refused = fence(screen() * 7);
    applyHighlight(made, 'const fromWorker = 1;', LANG, THEME);
    applyHighlight(refused, 'const onPage = 1;', LANG, THEME);
    layoutNotice();
    await tick();
    runIdle();
    expect(asked.sort()).toEqual(['const fromWorker = 1;', 'const onPage = 1;']);
    expect(made.innerHTML).toBe('<span style="color:#00ff00">const fromWorker = 1;</span>');
    expect(refused.innerHTML).toBe(markupFor('const onPage = 1;'));
  });

  test('a fence that comes near before the worker answers is highlighted on the page, not left plain', () => {
    setCodeHighlightWorker({ html: () => new Promise(() => {}) });
    setDeferOffscreenCodeHighlight(true);
    const el = fence(screen() * 6);
    applyHighlight(el, 'const soon = 1;', LANG, THEME);
    layoutNotice();
    place(el, 50);
    document.dispatchEvent(new Event('scroll'));
    expect(el.innerHTML).toBe(markupFor('const soon = 1;'));
  });

  test('markup for an older version of a fence never lands on the newer one', async () => {
    const answers = new Map<string, (html: string) => void>();
    setCodeHighlightWorker({ html: (code) => new Promise((resolve) => answers.set(code, resolve)) });
    setDeferOffscreenCodeHighlight(true);
    const el = fence(screen() * 6);
    applyHighlight(el, 'const before = 1;', LANG, THEME);
    layoutNotice();
    applyHighlight(el, 'const after = 2;', LANG, THEME);
    layoutNotice();
    answers.get('const before = 1;')!('<span style="color:#00ff00">const before = 1;</span>');
    await tick();
    runIdle();
    expect(el.textContent).toBe('const after = 2;');
    answers.get('const after = 2;')!('<span style="color:#00ff00">const after = 2;</span>');
    await tick();
    runIdle();
    expect(el.innerHTML).toBe('<span style="color:#00ff00">const after = 2;</span>');
  });

  test('a fence redrawn in a theme not attached yet never shows the old theme, and takes the new one near', async () => {
    setDeferOffscreenCodeHighlight(true);
    const el = fence(screen() * 6);
    applyHighlight(el, 'const themed = 1;', LANG, THEME);
    layoutNotice();
    applyHighlight(el, 'const themed = 1;', LANG, OTHER_THEME);
    place(el, 100);
    document.dispatchEvent(new Event('scroll'));
    expect(highlighted(el)).toBe(false);
    await tick();
    layoutNotice();
    expect(el.innerHTML).toBe(markupFor('const themed = 1;', OTHER_THEME));
  });

  test('a fence that loses its language while waiting stays plain', () => {
    setDeferOffscreenCodeHighlight(true);
    const el = fence(screen() * 6);
    applyHighlight(el, 'const tagged = 1;', LANG, THEME);
    layoutNotice();
    applyHighlight(el, 'plain words', undefined, THEME);
    runIdle();
    window.dispatchEvent(new Event('beforeprint'));
    expect(el.textContent).toBe('plain words');
    expect(highlighted(el)).toBe(false);
  });
});
