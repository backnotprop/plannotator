/**
 * The code-file view's line composer (plan review's code-file popout, the
 * Inbox file pane, Shape's Code view) keeps the words typed (DOM-gated).
 *
 * What regresses: Escape on the composer throwing the words away, so choosing
 * the same lines again shows an empty box; one range's words showing up on
 * another range; Save leaving the words behind.
 *
 * Pierre's `File` is replaced by a stub that hands its options back, so a line
 * range is chosen the way Pierre reports one (`onLineSelectionEnd`).
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeFileAnnotationInput } from './CodeFilePopout';

const hasDom = typeof document !== 'undefined';

interface CapturedFileProps {
  options: { onLineSelectionEnd?: (range: { start: number; end: number } | null) => void };
}
let lastFileProps: CapturedFileProps | null = null;

// Spread-captured before the mock replaces the module record (see
// DiffViewer.compactTouchSelection.test.tsx for why a bare namespace will not do).
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

async function mount(added: CodeFileAnnotationInput[]) {
  const CodeFileView = popoutModule!.CodeFileView;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<CodeFileView filepath="src/a.ts" contents={CONTENTS} onAddAnnotation={(a) => added.push(a)} />);
  });
}

async function chooseLines(start: number, end: number): Promise<HTMLTextAreaElement> {
  // The pointer over the file is where the composer opens (the file area remembers it).
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

    // Other lines start empty.
    const other = await chooseLines(4, 4);
    expect(other.value).toBe('');
    await press(other, 'Escape');

    // The same lines again: the words come back.
    const back = await chooseLines(2, 3);
    expect(back.value).toBe('b and c should be one line');

    await press(back, 'Enter', { metaKey: true });
    expect(added.map((a) => [a.lineStart, a.lineEnd, a.text])).toEqual([[2, 3, 'b and c should be one line']]);
    expect((await chooseLines(2, 3)).value).toBe('');
  });
});
