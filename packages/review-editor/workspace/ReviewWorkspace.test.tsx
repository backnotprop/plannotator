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

async function mount(singlePane = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const state = { onKeepFileTab: (id: string) => kept.push(id) } as never;
  await act(async () => {
    root!.render(
      <ReviewStateProvider value={state}>
        <ReviewWorkspace singlePane={singlePane} onReady={(event) => { api = event.api; }} />
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
    expect(el.querySelector('[data-pane-panel="review-all-files"]')?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => api!.getPanel('review-file:a.ts')!.api.updateParameters({ filePath: 'c.ts' }));
    expect(el.querySelector('[data-probe="review-file:a.ts"] [data-probe-path]')?.textContent).toBe('c.ts');
    await act(async () => tabButton(el, 'review-all-files').click());
    expect(input().value).toBe('kept');
  });
});
