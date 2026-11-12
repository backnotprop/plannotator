import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { __resetCodeHighlightCacheForTests, __setCodeHighlightModuleForTests, ensureHighlight, highlightToHtml } from '@plannotator/ui/utils/codeHighlight';
import { getMathRenderer, resetMathRenderer, setMathRendererLoader, type MathRenderer } from '@plannotator/ui/utils/math';
import { __setDrawReadyCapForTests, setThreadFenceTheme, threadDrawReady } from './threadDrawReady';

const THEME = 'pierre-light';
const TS = "export const x: number = 1;";

function thread(...bodies: string[]): InboxThread {
  const messages = bodies.map((body, i) => ({ id: `msg_${i}`, body }) as InboxMessageWire);
  return { thread_id: 'msg_0', messages } as InboxThread;
}

function heldPierre() {
  const held: Array<() => void> = [];
  const asked: string[] = [];
  const mod = {
    getSharedHighlighter: ({ langs }: { langs: string[] }) => {
      asked.push(...langs);
      return new Promise((resolve) => held.push(() => resolve(undefined)));
    },
    getHighlighterIfLoaded: () => ({
      codeToTokens: (code: string) => ({ tokens: code.split('\n').map((line) => [{ content: line, color: '#d73a49' }]) }),
    }),
  };
  __setCodeHighlightModuleForTests(mod as unknown as typeof import('@pierre/diffs'));
  return { asked, release: () => held.splice(0).forEach((resolve) => resolve()) };
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return done;
}

beforeEach(() => {
  setThreadFenceTheme(THEME);
  resetMathRenderer();
});

afterEach(() => {
  __setCodeHighlightModuleForTests(undefined);
  __resetCodeHighlightCacheForTests();
  setMathRendererLoader(null);
  resetMathRenderer();
});

test('a thread with code draws only once each fence can paint highlighted, in the window theme', async () => {
  const pierre = heldPierre();
  expect(highlightToHtml(TS, 'ts', THEME)).toBeNull();
  const ready = threadDrawReady(thread('Before.', '```ts\n' + TS + '\n```\n\nand\n\n```rust\nfn main() {}\n```'));
  expect(await settled(ready)).toBe(false);
  expect(pierre.asked.sort()).toEqual(['rust', 'ts']);
  pierre.release();
  expect(await settled(ready)).toBe(true);
  expect(highlightToHtml(TS, 'ts', THEME)).toContain('<span style="color:#d73a49">');
  expect(highlightToHtml('fn main() {}', 'rust', THEME)).not.toBeNull();
});

test('a fence inside a question card waits too; a diagram fence asks for no grammar', async () => {
  const pierre = heldPierre();
  const ready = threadDrawReady(thread(':::question\nWhich one?\n\n```python\nprint(1)\n```\n:::', '```mermaid\ngraph TD; A-->B\n```'));
  expect(await settled(ready)).toBe(false);
  expect(pierre.asked).toEqual(['python']);
  pierre.release();
  expect(await settled(ready)).toBe(true);
});

test('a thread with no code and no math is not held up, and loads nothing', async () => {
  const pierre = heldPierre();
  let loads = 0;
  setMathRendererLoader(() => {
    loads++;
    return new Promise<MathRenderer>(() => {});
  });
  const ready = threadDrawReady(thread('Plain words.', 'A `const x` inline and a [link](https://example.com).'));
  expect(await settled(ready)).toBe(true);
  expect(pierre.asked).toEqual([]);
  expect(loads).toBe(0);
});

test('a thread with math draws once KaTeX is in, so the math paints typeset, never as TeX', async () => {
  heldPierre();
  let land: (r: MathRenderer) => void = () => {};
  setMathRendererLoader(() => new Promise<MathRenderer>((resolve) => (land = resolve)));
  const ready = threadDrawReady(thread('The delay is $d_0 \\cdot 2^n$ at most.'));
  expect(await settled(ready)).toBe(false);
  expect(getMathRenderer()).toBeNull();
  land({ renderToString: (tex) => `<span class="katex">${tex}</span>` });
  expect(await settled(ready)).toBe(true);
  expect(getMathRenderer()).not.toBeNull();
});

test('a grammar whose chunk failed is asked for again on the next read, and then paints highlighted', async () => {
  const asked: string[] = [];
  let up = false;
  __setCodeHighlightModuleForTests({
    getSharedHighlighter: ({ langs }: { langs: string[] }) => {
      asked.push(...langs);
      return up ? Promise.resolve(undefined) : Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
    },
    getHighlighterIfLoaded: () => ({
      codeToTokens: (code: string) => ({ tokens: code.split('\n').map((line) => [{ content: line, color: '#d73a49' }]) }),
    }),
  } as unknown as typeof import('@pierre/diffs'));
  await threadDrawReady(thread('```go\nfunc main() {}\n```'));
  expect(highlightToHtml('func main() {}', 'go', THEME)).toBeNull();
  up = true;
  await threadDrawReady(thread('```go\nfunc main() {}\n```'));
  expect(asked).toEqual(['go', 'go']);
  expect(highlightToHtml('func main() {}', 'go', THEME)).toContain('<span style="color:#d73a49">');
});

test('a chunk that stalled past the cap holds one read only: the next draws at once, and the code upgrades when it lands', async () => {
  __setDrawReadyCapForTests(40);
  try {
    const pierre = heldPierre();
    const started = Date.now();
    await threadDrawReady(thread('```go\nfunc main() {}\n```'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(await settled(threadDrawReady(thread('```go\nfunc other() {}\n```')))).toBe(true);
    let swapped = false;
    void ensureHighlight('go', THEME).then((ok) => (swapped = ok));
    pierre.release();
    await settled(Promise.resolve());
    expect(swapped).toBe(true);
    expect(highlightToHtml('func main() {}', 'go', THEME)).not.toBeNull();
    expect(await settled(threadDrawReady(thread('```rust\nfn main() {}\n```')))).toBe(false);
    pierre.release();
  } finally {
    __setDrawReadyCapForTests(undefined);
  }
});

test('a grammar already in costs nothing: the next thread with that language draws at once', async () => {
  const pierre = heldPierre();
  const first = threadDrawReady(thread('```ts\n' + TS + '\n```'));
  expect(await settled(first)).toBe(false);
  pierre.release();
  expect(await settled(first)).toBe(true);
  expect(await settled(threadDrawReady(thread('```ts\nlet y = 2;\n```')))).toBe(true);
  expect(pierre.asked).toEqual(['ts']);
});
