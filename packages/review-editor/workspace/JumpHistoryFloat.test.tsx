import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';

function Probe(props: { api: { id: string } }) {
  return <div data-probe={props.api.id} />;
}

mock.module('../dock/reviewPanelComponents', () => ({
  reviewPanelComponents: { 'review-all-files': Probe, 'review-file': Probe, 'review-diff': Probe, 'review-code-nav': Probe },
}));

const { ReviewWorkspace } = (hasDom ? await import('./ReviewWorkspace') : {}) as typeof import('./ReviewWorkspace');
const { ReviewStateProvider } = (hasDom ? await import('../dock/ReviewStateContext') : {}) as typeof import('../dock/ReviewStateContext');
type Api = import('./workspaceStore').WorkspaceApi;
type NavLocation = import('../utils/explorerNavigation').NavLocation;

let root: Root | null = null;
let host: HTMLElement | null = null;
let api: Api | null = null;
const back = mock(() => {});
const forward = mock(() => {});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  api = null;
  back.mockClear();
  forward.mockClear();
});

async function render(backTo: NavLocation | null, forwardTo: NavLocation | null = null) {
  const state = {
    navigation: { canBack: !!backTo, canForward: !!forwardTo, backTo, forwardTo, back, forward },
    jumpCrumb: backTo ? { targetPath: 'src/b.ts', from: backTo, via: 'definition' } : null,
  } as never;
  await act(async () => {
    root!.render(
      <ReviewStateProvider value={state}>
        <ReviewWorkspace onReady={(event) => { api = event.api; }} />
      </ReviewStateProvider>,
    );
  });
}

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await render(null);
  await act(async () => {
    api!.addPanel({ id: 'review-all-files', component: 'review-all-files', title: 'All changes' });
  });
  return host;
}

const float = () => host!.querySelectorAll<HTMLElement>('[data-jump-float]');
const backButton = () => host!.querySelector<HTMLButtonElement>('[data-jump-float-back]')!;
const forwardButton = () => host!.querySelector<HTMLButtonElement>('[data-jump-float-forward]')!;

describe.skipIf(!hasDom)('the jump history float', () => {
  test('nothing with no history; after a jump Back says where it goes and goes there, Forward is shown but off', async () => {
    await mount();
    expect(float().length).toBe(0);
    await act(async () => { api!.addPanel({ id: 'review-file:src/b.ts', component: 'review-file', title: 'b.ts', params: { filePath: 'src/b.ts' } }); });
    await render({ path: 'src/a.ts', line: 42 });
    expect(float().length).toBe(1);
    expect(backButton().getAttribute('aria-label')).toBe('Back to a.ts:42 · Go to Definition');
    expect(backButton().title.startsWith('Back to a.ts:42 · Go to Definition (')).toBe(true);
    await act(async () => backButton().click());
    expect(back).toHaveBeenCalledTimes(1);
    expect(forwardButton().getAttribute('aria-disabled')).toBe('true');
    await act(async () => forwardButton().click());
    expect(forward).not.toHaveBeenCalled();
  });

  test('one float, on the active pane only, and none over the References tab', async () => {
    await mount();
    await render({ path: null });
    await act(async () => { api!.addPanel({ id: 'review-file:src/b.ts', component: 'review-file', title: 'b.ts', params: { filePath: 'src/b.ts' }, position: { referencePanel: 'review-all-files', direction: 'right' } }); });
    expect(host!.querySelectorAll('[data-pane]').length).toBe(2);
    expect(float().length).toBe(1);
    expect(float()[0].closest('[data-pane]')!.getAttribute('data-pane')).toBe('1');
    expect(backButton().getAttribute('aria-label')).toBe('Back to All changes · Go to Definition');
    await act(async () => { api!.getPanel('review-all-files')!.api.setActive(); });
    expect(float().length).toBe(1);
    expect(float()[0].closest('[data-pane]')!.getAttribute('data-pane')).toBe('0');
    await act(async () => { api!.addPanel({ id: 'review-code-nav', component: 'review-code-nav', title: 'References', position: { referencePanel: 'review-all-files', direction: 'within' } }); });
    expect(float().length).toBe(0);
  });

  test('focus on the float stays in the pane when the float goes away', async () => {
    await mount();
    await render({ path: 'src/a.ts', line: 3 });
    backButton().focus();
    expect(document.activeElement).toBe(backButton());
    await render(null);
    expect(float().length).toBe(0);
    expect(document.activeElement).toBe(host!.querySelector('[data-pane="0"] [data-pane-frame]'));
  });

  test('a focused float does not pull the active pane back when another pane takes over', async () => {
    await mount();
    await render({ path: null });
    await act(async () => { api!.addPanel({ id: 'review-file:src/b.ts', component: 'review-file', title: 'b.ts', params: { filePath: 'src/b.ts' }, position: { referencePanel: 'review-all-files', direction: 'right' } }); });
    backButton().focus();
    await act(async () => { api!.getPanel('review-all-files')!.api.setActive(); });
    expect(float().length).toBe(1);
    expect(float()[0].closest('[data-pane]')!.getAttribute('data-pane')).toBe('0');
  });
});
