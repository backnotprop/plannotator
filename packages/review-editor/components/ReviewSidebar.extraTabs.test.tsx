import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewSidebar, type ReviewSidebarExtraTab } from './ReviewSidebar';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

const CHANGES: ReviewSidebarExtraTab = {
  id: 'changes',
  label: 'Sem',
  title: 'Semantic changes',
  count: 4,
  render: () => <div data-test-changes-body="">semantic changes</div>,
};

async function render(activeTab: string, onSelectTab = (_tab: string) => {}): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ReviewSidebar
        isOpen
        onClose={() => {}}
        activeTab={activeTab}
        onSelectTab={onSelectTab}
        extraTabs={[CHANGES]}
        annotations={[]}
        files={[]}
        selectedAnnotationId={null}
        onSelectAnnotation={() => {}}
        onNavigateToAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
      />,
    );
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.skipIf(!hasDom)('a feature adds its own tab to the right panel', () => {
  test('the tab sits after the built-in ones with its count, and choosing it reaches the app', async () => {
    const onSelectTab = mock((_tab: string) => {});
    const el = await render('annotations', onSelectTab);
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map((tab) => tab.dataset.reviewSidebarTab);
    expect(tabs).toEqual(['annotations', 'changes']);
    const changes = el.querySelector<HTMLButtonElement>('[data-review-sidebar-tab="changes"]')!;
    expect(changes.textContent).toBe('Sem4');
    expect(changes.getAttribute('aria-label')).toBe('Semantic changes, 4');
    expect(changes.title).toBe('Semantic changes');
    expect(el.querySelector('[data-test-changes-body]')).toBeNull();
    await act(async () => changes.click());
    expect(onSelectTab).toHaveBeenCalledWith('changes');
  });

  test('when its tab is the active one, its body is the panel', async () => {
    const el = await render('changes');
    expect(el.querySelector('[data-test-changes-body]')?.textContent).toBe('semantic changes');
    expect(el.querySelector('[data-review-sidebar-tab="changes"]')?.getAttribute('aria-selected')).toBe('true');
  });
});
