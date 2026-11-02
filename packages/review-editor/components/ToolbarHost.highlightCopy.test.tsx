/**
 * Ctrl+C / Cmd+C in code review once a drag over the diff became a line range
 * and opened its composer (DOM-gated, DOM_TESTS=1).
 *
 * Failures to catch: the copy carries nothing while the selected lines are
 * highlighted and the composer's empty textarea has the focus; it carries the
 * wrong side's lines; it fires with no line range open; or text the person
 * selected in the textarea is overwritten.
 */
import { afterEach, expect, test } from 'bun:test';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ToolbarHostHandle } from './ToolbarHost';

const hasDom = typeof document !== 'undefined';
const hostModule = hasDom ? await import('./ToolbarHost') : null;

const PATCH = [
  'diff --git a/refund.ts b/refund.ts',
  '--- a/refund.ts',
  '+++ b/refund.ts',
  '@@ -1,3 +1,3 @@',
  ' export function retries(): number {',
  '-  return 3;',
  '+  return 4;',
  ' }',
  '',
].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

async function mount() {
  const ToolbarHost = hostModule!.ToolbarHost;
  const ref = createRef<ToolbarHostHandle>();
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <ToolbarHost
        ref={ref}
        patch={PATCH}
        filePath="refund.ts"
        isFocused
        onLineSelection={() => {}}
        onAddAnnotation={() => {}}
        onEditAnnotation={() => {}}
      />,
    );
  });
  return ref;
}

async function selectLine(ref: React.RefObject<ToolbarHostHandle | null>, side: 'additions' | 'deletions', line: number) {
  await act(async () => ref.current!.handleLineSelectionEnd({ start: line, end: line, side } as never));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const area = document.querySelector<HTMLTextAreaElement>('textarea');
  if (!area) throw new Error('no line composer');
  area.focus();
  return area;
}

function copyAt(target: EventTarget) {
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' } });
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, plain: data.get('text/plain') };
}

test.skipIf(!hasDom)('a selected added line: Ctrl+C in the empty composer copies its code', async () => {
  const ref = await mount();
  const area = await selectLine(ref, 'additions', 2);
  expect(copyAt(area)).toEqual({ prevented: true, plain: '  return 4;' });
});

test.skipIf(!hasDom)('a selected removed line copies the old side', async () => {
  const ref = await mount();
  const area = await selectLine(ref, 'deletions', 2);
  expect(copyAt(area)).toEqual({ prevented: true, plain: '  return 3;' });
});

test.skipIf(!hasDom)('no line range open: Ctrl+C stays native', async () => {
  await mount();
  expect(copyAt(document.body)).toEqual({ prevented: false, plain: undefined });
});

test.skipIf(!hasDom)('text selected in the composer copies natively', async () => {
  const ref = await mount();
  const area = await selectLine(ref, 'additions', 2);
  area.value = 'Why four?';
  area.setSelectionRange(4, 8);
  expect(copyAt(area)).toEqual({ prevented: false, plain: undefined });
});
