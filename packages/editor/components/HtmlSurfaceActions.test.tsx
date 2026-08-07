import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HtmlSurfaceActions } from './HtmlSurfaceActions';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function renderActions(props?: Partial<React.ComponentProps<typeof HtmlSurfaceActions>>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <HtmlSurfaceActions
        canRefresh
        isRefreshing={false}
        toolsHidden={false}
        onRefresh={() => {}}
        onToggleTools={() => {}}
        {...props}
      />,
    );
  });
  return container;
}

describe.if(hasDom)('HtmlSurfaceActions', () => {
  test('offers manual refresh and annotation-tool visibility actions', () => {
    let refreshCount = 0;
    const element = renderActions({ onRefresh: () => { refreshCount += 1; } });

    const refresh = element.querySelector<HTMLButtonElement>('[aria-label="Refresh HTML from disk"]');
    expect(refresh).not.toBeNull();
    expect(element.textContent).toContain('Refresh');
    expect(element.textContent).toContain('Hide tools');

    act(() => refresh?.click());
    expect(refreshCount).toBe(1);
  });

  test('communicates refresh progress and prevents duplicate requests', () => {
    const element = renderActions({ isRefreshing: true });
    const refresh = element.querySelector<HTMLButtonElement>('[aria-label="Refreshing HTML from disk"]');

    expect(refresh?.disabled).toBe(true);
    expect(element.textContent).toContain('Refreshing');
  });

  test('omits refresh when the active HTML source is not refreshable', () => {
    const element = renderActions({ canRefresh: false, toolsHidden: true });

    expect(element.querySelector('[aria-label*="HTML from disk"]')).toBeNull();
    expect(element.textContent).toContain('Show tools');
  });
});
