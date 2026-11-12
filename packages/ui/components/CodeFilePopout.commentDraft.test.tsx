import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeFileAnnotationInput } from './CodeFilePopout';

const hasDom = typeof document !== 'undefined';

interface CapturedFileProps {
  options: { onLineSelectionEnd?: (range: { start: number; end: number } | null) => void };
}
let lastFileProps: CapturedFileProps | null = null;

const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
mock.module('@pierre/diffs/react', () => ({
  ...realPierreDiffsReact,
  File: function MockFile(props: CapturedFileProps) {
    lastFileProps = props;
    return null;
  },
}));

const popoutModule = hasDom ? await import('./CodeFilePopout') : null;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  lastFileProps = null;
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

const CONTENTS = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'].join('\n');

async function mount(added: CodeFileAnnotationInput[], filepath = 'src/a.ts', contents = CONTENTS) {
  const CodeFileView = popoutModule!.CodeFileView;
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<CodeFileView filepath={filepath} contents={contents} onAddAnnotation={(a) => added.push(a)} />);
  });
}

async function chooseLines(start: number, end: number): Promise<HTMLTextAreaElement> {
  const area = host!.firstElementChild as HTMLElement;
  await act(async () => {
    area.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 40 * start, bubbles: true }));
  });
  await act(async () => { lastFileProps!.options.onLineSelectionEnd!({ start, end }); });
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('composer textarea missing');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

describe.if(hasDom)('CodeFileView line composer draft', () => {
  test('Escape keeps the words for these lines, reopening restores them, Save clears them', async () => {
    const added: CodeFileAnnotationInput[] = [];
    await mount(added);

    await type(await chooseLines(2, 3), 'b and c should be one line');
    await press(document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!, 'Escape');
    expect(document.querySelector('[data-comment-popover]')).toBeNull();

    const other = await chooseLines(4, 4);
    expect(other.value).toBe('');
    await press(other, 'Escape');

    const back = await chooseLines(2, 3);
    expect(back.value).toBe('b and c should be one line');

    await press(back, 'Enter', { metaKey: true });
    expect(added.map((a) => [a.lineStart, a.lineEnd, a.text])).toEqual([[2, 3, 'b and c should be one line']]);
    expect((await chooseLines(2, 3)).value).toBe('');
  });

  test('two files with the same name keep separate drafts: the other one opens empty', async () => {
    const added: CodeFileAnnotationInput[] = [];
    await mount(added, 'index.ts', 'export const a = 1;\nexport const b = 2;');
    await type(await chooseLines(1, 1), 'rename a for thread A');
    await press(document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!, 'Escape');

    await mount(added, 'index.ts', 'export const x = 9;\nexport const y = 8;');
    const other = await chooseLines(1, 1);
    expect(other.value).toBe('');
    await press(other, 'Escape');

    await mount(added, 'index.ts', 'export const a = 1;\nexport const b = 2;');
    expect((await chooseLines(1, 1)).value).toBe('rename a for thread A');
    expect(added).toEqual([]);
  });
});
