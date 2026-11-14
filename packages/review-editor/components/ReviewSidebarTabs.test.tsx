import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewSidebarTabs, type ReviewSidebarTabItem } from './ReviewSidebarTabs';
import type { ReviewSidebarTab } from './ReviewSidebar';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const TABS: ReviewSidebarTabItem[] = [
  { id: 'annotations', label: 'Comments', count: 3 },
  { id: 'ai', label: 'AI', attention: true },
  { id: 'agents', label: 'Agents', count: 1 },
];

function Harness({ tabs = TABS, initial = 'annotations' as ReviewSidebarTab }) {
  const [active, setActive] = useState<ReviewSidebarTab>(initial);
  return (
    <>
      <ReviewSidebarTabs tabs={tabs} active={active} onSelect={setActive} />
      <output data-active={active} />
    </>
  );
}

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  return host;
}

const tab = (el: HTMLElement, id: string) => el.querySelector<HTMLButtonElement>(`[data-review-sidebar-tab="${id}"]`)!;
const active = (el: HTMLElement) => el.querySelector('output')?.getAttribute('data-active');

describe.skipIf(!hasDom)('Comments, AI and Agents as tabs in the right panel', () => {
  test('each tab is one click away and only the chosen one is a Tab stop', async () => {
    const el = await mount(<Harness />);
    expect(tab(el, 'annotations').getAttribute('aria-selected')).toBe('true');
    await act(async () => tab(el, 'agents').click());
    expect(active(el)).toBe('agents');
    expect([...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter((b) => b.tabIndex === 0).map((b) => b.dataset.reviewSidebarTab)).toEqual(['agents']);
  });

  test('Left and Right reach AI and Agents from the keyboard, wrapping', async () => {
    const el = await mount(<Harness />);
    const list = el.querySelector('[role="tablist"]')!;
    await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(active(el)).toBe('ai');
    await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(active(el)).toBe('agents');
    await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(active(el)).toBe('annotations');
    await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(active(el)).toBe('agents');
  });

  test('a tab the session cannot use is not drawn', async () => {
    const el = await mount(<Harness tabs={[TABS[0]]} />);
    expect(tab(el, 'ai')).toBeNull();
    expect(tab(el, 'agents')).toBeNull();
  });

  test('counts show on the tabs and new AI activity marks its tab while another is open', async () => {
    const el = await mount(<Harness />);
    expect(tab(el, 'annotations').textContent).toBe('Comments3');
    expect(tab(el, 'ai').querySelector('[aria-label="New activity"]')).not.toBeNull();
  });
});
