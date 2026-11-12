/**
 * Ctrl+C / Cmd+C in the code-file view's line composer (plan review's
 * code-file popout, the Inbox file pane, code review's whole-file view)
 * (DOM-gated, DOM_TESTS=1).
 *
 * What regresses: with lines chosen and their composer open (focus in its
 * textarea) the copy carries nothing, or the lines lose their line breaks;
 * text typed and selected in the composer is overwritten by the lines; a copy
 * still takes the clipboard once the composer has closed.
 *
 * Pierre's `File` is replaced by a stub that hands its options back, so a line
 * range is chosen the way Pierre reports one (`onLineSelectionEnd`).
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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

async function mount() {
  const CodeFileView = popoutModule!.CodeFileView;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<CodeFileView filepath="src/a.ts" contents={CONTENTS} onAddAnnotation={() => {}} />);
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

/** What a Ctrl+C at `target` puts on the clipboard (the browser fires `copy`). */
function copyAt(target: EventTarget) {
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' } });
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, plain: data.get('text/plain'), html: data.get('text/html') };
}

describe.if(hasDom)('CodeFileView: Ctrl+C with the line composer open', () => {
  test('copies the chosen lines as plain text, line breaks kept', async () => {
    await mount();
    const area = await chooseLines(2, 3);
    area.focus();
    expect(copyAt(area)).toEqual({ prevented: true, plain: 'const b = 2;\nconst c = 3;', html: undefined });
  });

  test('text typed and selected in the composer copies natively', async () => {
    await mount();
    const area = await chooseLines(2, 2);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'rename b');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    area.focus();
    area.setSelectionRange(0, 6);
    expect(copyAt(area)).toMatchObject({ prevented: false, plain: undefined });
  });

  test('once the composer closes, Ctrl+C is the browser\'s own again', async () => {
    await mount();
    const area = await chooseLines(1, 1);
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
    expect(copyAt(document.body)).toMatchObject({ prevented: false, plain: undefined });
  });
});
