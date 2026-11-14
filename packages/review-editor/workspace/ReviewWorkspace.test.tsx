import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';

function Probe(props: { params: Record<string, unknown>; api: { id: string } }) {
  const [text, setText] = React.useState('');
  return (
    <div data-probe={props.api.id}>
      <input data-probe-input={props.api.id} value={text} onChange={(event) => setText(event.target.value)} />
      <span data-probe-path="">{String(props.params.filePath ?? '')}</span>
    </div>
  );
}

mock.module('../dock/reviewPanelComponents', () => ({
  reviewPanelComponents: { 'review-all-files': Probe, 'review-file': Probe, 'review-diff': Probe },
}));

const { ReviewWorkspace } = (hasDom ? await import('./ReviewWorkspace') : {}) as typeof import('./ReviewWorkspace');
const { ReviewStateProvider } = (hasDom ? await import('../dock/ReviewStateContext') : {}) as typeof import('../dock/ReviewStateContext');
type Api = import('./workspaceStore').WorkspaceApi;

let root: Root | null = null;
let host: HTMLElement | null = null;
let api: Api | null = null;
const kept: string[] = [];

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  api = null;
  kept.length = 0;
});

async function mount(singlePane = false, extra: { tabsSlot?: HTMLElement; reviewKey?: string } = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const state = { onKeepFileTab: (id: string) => kept.push(id) } as never;
  await act(async () => {
    root!.render(
      <ReviewStateProvider value={state}>
        <ReviewWorkspace singlePane={singlePane} tabsSlot={extra.tabsSlot} reviewKey={extra.reviewKey} onReady={(event) => { api = event.api; }} />
      </ReviewStateProvider>,
    );
  });
  await act(async () => {
    api!.addPanel({ id: 'review-all-files', component: 'review-all-files', title: 'All changes' });
  });
  return host;
}

const tabRow = (el: HTMLElement, pane = 0) => el.querySelector(`[data-pane="${pane}"] [data-pane-tabs]`);
const tabButton = (el: HTMLElement, id: string) => el.querySelector<HTMLButtonElement>(`[data-pane-tab="${id}"]`)!;

describe.skipIf(!hasDom)('the review panes', () => {
  test('one tab draws no tab row; a second tab brings it; a click switches; a middle click closes', async () => {
    const el = await mount();
    expect(tabRow(el)).toBeNull();
    await act(async () => { api!.addPanel({ id: 'review-file:a.ts', component: 'review-file', title: 'a.ts', params: { filePath: 'a.ts' } }); });
    expect(tabRow(el)).not.toBeNull();
    expect(tabButton(el, 'review-file:a.ts').getAttribute('aria-selected')).toBe('true');
    await act(async () => tabButton(el, 'review-all-files').click());
    expect(api!.activePanel?.id).toBe('review-all-files');
    await act(async () => { tabButton(el, 'review-file:a.ts').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })); });
    expect(api!.getPanel('review-file:a.ts')).toBeUndefined();
    expect(tabRow(el)).toBeNull();
  });

  test('a preview tab is italic and a double click keeps it', async () => {
    const el = await mount();
    await act(async () => { api!.addPanel({ id: 'review-file-preview:1', component: 'review-file', title: 'b.ts', params: { filePath: 'b.ts', preview: true } }); });
    const preview = tabButton(el, 'review-file-preview:1');
    expect(preview.className).toContain('italic');
    await act(async () => preview.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(kept).toEqual(['review-file-preview:1']);
  });

  test('to the side opens a second pane with one divider the keyboard can move; a phone keeps one pane', async () => {
    const el = await mount();
    await act(async () => { api!.addPanel({ id: 'review-file:a.ts', component: 'review-file', title: 'a.ts', params: { filePath: 'a.ts' }, position: { referencePanel: 'review-all-files', direction: 'right' } }); });
    expect(el.querySelectorAll('[data-pane]').length).toBe(2);
    const divider = el.querySelector<HTMLElement>('[data-pane-divider]')!;
    expect(divider.getAttribute('aria-valuenow')).toBe('50');
    await act(async () => divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(divider.getAttribute('aria-valuenow')).toBe('48');
    await act(async () => divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(divider.getAttribute('aria-valuenow')).toBe('50');
    await act(async () => root?.unmount());
    host?.remove();
    const phone = await mount(true);
    await act(async () => { api!.addPanel({ id: 'review-file:a.ts', component: 'review-file', title: 'a.ts', params: { filePath: 'a.ts' }, position: { referencePanel: 'review-all-files', direction: 'right' } }); });
    expect(phone.querySelectorAll('[data-pane]').length).toBe(1);
  });

  test('a tab keeps its state while another tab is shown, and its parameters reach it', async () => {
    const el = await mount();
    const input = () => el.querySelector<HTMLInputElement>('[data-probe-input="review-all-files"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input(), 'kept');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { api!.addPanel({ id: 'review-file:a.ts', component: 'review-file', title: 'a.ts', params: { filePath: 'a.ts' } }); });
    expect(el.querySelector('[data-pane-panel="review-all-files"]')).toBeNull();
    await act(async () => api!.getPanel('review-file:a.ts')!.api.updateParameters({ filePath: 'c.ts' }));
    expect(el.querySelector('[data-probe="review-file:a.ts"] [data-probe-path]')?.textContent).toBe('c.ts');
    await act(async () => tabButton(el, 'review-all-files').click());
    expect(input().value).toBe('kept');
  });

  test('with the header slot, tabs appear in the header row and nothing is added above the code', async () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const el = await mount(false, { tabsSlot: slot });
    await act(async () => { api!.addPanel({ id: 'review-file:a.ts', component: 'review-file', title: 'a.ts', params: { filePath: 'a.ts' } }); });
    expect(slot.querySelector('[data-pane-tab="review-file:a.ts"]')).not.toBeNull();
    expect(el.querySelector('[data-pane] [data-pane-tabs]')).toBeNull();
    slot.remove();
  });

  test('a preview tab shows a new title only once the file settles, so arrowing does not flicker it', async () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    await mount(false, { tabsSlot: slot });
    await act(async () => { api!.addPanel({ id: 'review-file-preview:1', component: 'review-file', title: 'one.ts', params: { filePath: 'one.ts', preview: true } }); });
    const title = () => slot.querySelector('[data-pane-tab="review-file-preview:1"]')?.textContent;
    await act(async () => {
      api!.getPanel('review-file-preview:1')!.api.setTitle('two.ts');
      api!.getPanel('review-file-preview:1')!.api.setTitle('three.ts');
    });
    expect(title()).toBe('one.ts');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    expect(title()).toBe('three.ts');
    slot.remove();
  });

  test('a review reopened comes back with its two panes, kept tabs and divider', async () => {
    const { writeSavedLayout } = await import('./layoutMemory');
    const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
    const memory = new Map<string, string>();
    setStorageBackend({ getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: (key) => { memory.delete(key); } });
    writeSavedLayout('repo#branch', {
      panes: [
        { tabs: [{ id: 'review-all-files', component: 'review-all-files', title: 'All changes', params: {} }], activeId: 'review-all-files' },
        { tabs: [{ id: 'review-file:a.ts', component: 'review-file', title: 'a.ts', params: { filePath: 'a.ts' } }], activeId: 'review-file:a.ts' },
      ],
      activePane: 0,
      ratio: 0.62,
    });
    const el = await mount(false, { reviewKey: 'repo#branch' });
    await act(async () => { await Promise.resolve(); });
    expect(el.querySelectorAll('[data-pane]').length).toBe(2);
    expect(api!.getPanel('review-file:a.ts')).toBeDefined();
    expect(el.querySelector('[data-pane-divider]')?.getAttribute('aria-valuenow')).toBe('62');
    resetStorageBackend();
  });

  test('every tab opened is remembered, a preview or one opened into the pane that is not focused, and comes back on reload', async () => {
    const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
    const memory = new Map<string, string>();
    setStorageBackend({ getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: (key) => { memory.delete(key); } });
    await mount(false, { reviewKey: 'repo#reload' });
    await act(async () => { api!.addPanel({ id: 'review-file:balance.ts', component: 'review-file', title: 'balance.ts', params: { filePath: 'balance.ts' }, position: { referencePanel: 'review-all-files', direction: 'right' } }); });
    await act(async () => { api!.addPanel({ id: 'review-file-preview:1', component: 'review-file', title: 'validate.ts', params: { filePath: 'validate.ts', preview: true }, position: { referencePanel: 'review-all-files', direction: 'within' } }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await act(async () => root?.unmount());
    host?.remove();
    const el = await mount(false, { reviewKey: 'repo#reload' });
    await act(async () => { await Promise.resolve(); });
    expect([...el.querySelectorAll('[data-pane="0"] [data-pane-tab]')].map((tab) => tab.getAttribute('data-pane-tab'))).toEqual(['review-all-files', 'review-file-preview:1']);
    expect(el.querySelector('[data-pane="1"] [data-pane-tab="review-file:balance.ts"]')).not.toBeNull();
    resetStorageBackend();
  });

  test('a References tab reads as the symbol with an icon, and a long title is capped', async () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    await mount(false, { tabsSlot: slot });
    await act(async () => { api!.addPanel({ id: 'review-code-nav', component: 'review-code-nav', title: 'References: validateEntryBoundaries' }); });
    const tab = slot.querySelector<HTMLElement>('[data-pane-tab="review-code-nav"]')!;
    expect(tab.textContent).toBe('validateEntryBoundaries');
    expect(tab.querySelector('[data-references-tab-icon]')).not.toBeNull();
    expect(tab.className).toContain('max-w-[180px]');
    slot.remove();
  });

  test('with two panes the second tab group starts over the second pane', async () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const left = this.matches('[data-pane="1"]') ? 700 : this.matches('[data-header-pane-tabs]') ? 200 : 0;
      return { left, right: left, top: 0, bottom: 0, width: 0, height: 0, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    try {
      await mount(false, { tabsSlot: slot });
      await act(async () => { api!.addPanel({ id: 'review-file:b.ts', component: 'review-file', title: 'b.ts', params: { filePath: 'b.ts' }, position: { referencePanel: 'review-all-files', direction: 'right' } }); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
      const second = slot.querySelector<HTMLElement>('[data-header-group="1"]')!;
      expect(second.style.left).toBe('512px');
      expect(slot.querySelector<HTMLElement>('[data-header-group="0"]')!.style.maxWidth).toBe('484px');
    } finally {
      Element.prototype.getBoundingClientRect = original;
      slot.remove();
    }
  });
});
