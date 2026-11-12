import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const viewModule = hasDom ? await import('./PlanCleanDiffView') : null;
const engine = hasDom ? await import('../../utils/planDiffEngine') : null;

const OLD = 'Intro.\n\nThe service retries a failed payout three times.\n';
const NEW = 'Intro.\n\nThe service retries a failed payout four times.\n';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

async function mount() {
  const { blocks } = engine!.computePlanDiff(OLD, NEW);
  const PlanCleanDiffView = viewModule!.PlanCleanDiffView;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<PlanCleanDiffView blocks={blocks} wordLevel={false} mode="selection" onAddAnnotation={() => {}} />);
  });
  return host!;
}

function addedBlock(el: HTMLElement) {
  const block = el.querySelector<HTMLElement>('.plan-diff-added');
  if (!block) throw new Error('no added block');
  return block;
}

async function dragThenClick(block: HTMLElement, phrase?: string) {
  if (phrase) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
    const at = node!.textContent!.indexOf(phrase);
    const range = document.createRange();
    range.setStart(node!, at);
    range.setEnd(node!, at + phrase.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  }
  await act(async () => block.click());
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const area = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!area) throw new Error('no composer');
  window.getSelection()!.removeAllRanges();
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

test.skipIf(!hasDom)('a drag that opened the block composer: Ctrl+C copies the dragged words', async () => {
  const el = await mount();
  const area = await dragThenClick(addedBlock(el), 'payout four times');
  expect(copyAt(area)).toEqual({ prevented: true, plain: 'payout four times' });
});

test.skipIf(!hasDom)('a bare click (nothing dragged) leaves Ctrl+C native', async () => {
  const el = await mount();
  const area = await dragThenClick(addedBlock(el));
  expect(copyAt(area)).toEqual({ prevented: false, plain: undefined });
});

test.skipIf(!hasDom)('text selected in the composer copies natively', async () => {
  const el = await mount();
  const area = await dragThenClick(addedBlock(el), 'payout four times');
  area.value = 'Why four?';
  area.setSelectionRange(4, 8);
  expect(copyAt(area)).toEqual({ prevented: false, plain: undefined });
});
