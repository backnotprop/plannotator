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

const refreshButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-refresh]');
const toolsToggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-tools-toggle]');

describe.if(hasDom)('HtmlSurfaceActions', () => {
  test('refresh fires the handler and the tools toggle keeps its pressed state', () => {
    let refreshCount = 0;
    const element = renderActions({ onRefresh: () => { refreshCount += 1; } });

    const refresh = refreshButton(element);
    expect(refresh?.getAttribute('aria-disabled')).toBe('false');
    act(() => refresh?.click());
    expect(refreshCount).toBe(1);
    expect(toolsToggle(element)?.getAttribute('aria-pressed')).toBe('false');
  });

  test('an in-flight refresh ignores clicks without dropping focus', () => {
    let refreshCount = 0;
    const element = renderActions({ isRefreshing: true, onRefresh: () => { refreshCount += 1; } });
    const refresh = refreshButton(element);

    // aria-disabled keeps the control focusable (a disabled button drops
    // keyboard focus to body) while the click stays inert.
    expect(refresh?.getAttribute('aria-disabled')).toBe('true');
    expect(refresh?.disabled).toBe(false);
    refresh?.focus();
    act(() => refresh?.click());
    expect(refreshCount).toBe(0);
    expect(document.activeElement).toBe(refresh);
  });

  test('omits refresh when the active HTML source is not refreshable', () => {
    const element = renderActions({ canRefresh: false, toolsHidden: true });

    expect(refreshButton(element)).toBeNull();
    // The tools toggle is the only way back from a hidden state, so it must
    // render regardless of refresh availability.
    expect(toolsToggle(element)?.getAttribute('aria-pressed')).toBe('true');
  });
});
