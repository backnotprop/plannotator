import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { configStore } from '@plannotator/ui/config';
import { ReviewDockRightActions } from './ReviewDockRightActions';
import { ReviewStateProvider, type ReviewState } from './ReviewStateContext';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
let originalDiffStyle: 'split' | 'unified' = 'split';

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  configStore.set('diffStyle', originalDiffStyle);
});

describe('ReviewDockRightActions', () => {
  test.skipIf(!hasDom)('removes dense dock actions from the compact tab strip', async () => {
    originalDiffStyle = configStore.get('diffStyle');
    configStore.set('diffStyle', 'unified');
    const onDiffStyleChange = mock(() => {});
    const state = {
      diffStyle: 'unified',
      onDiffStyleChange,
      isCompactTouchLayout: true,
      allFilesAllCollapsed: false,
      onToggleAllFilesCollapsed: () => {},
    } as unknown as ReviewState;

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(
      <ReviewStateProvider value={state}>
        <ReviewDockRightActions {...({ activePanel: null } as unknown as IDockviewHeaderActionsProps)} />
      </ReviewStateProvider>,
    ));

    expect(host?.querySelector('button')).toBeNull();
    expect(onDiffStyleChange).not.toHaveBeenCalled();
    expect(configStore.get('diffStyle')).toBe('unified');
  });

  test.skipIf(!hasDom)('desktop: one Split/Unified button that switches to the other layout, and the Diff display gear with every row', async () => {
    const onDiffStyleChange = mock((_style: 'split' | 'unified') => {});
    const state = {
      diffStyle: 'unified',
      onDiffStyleChange,
      isCompactTouchLayout: false,
      allFilesAllCollapsed: false,
      onToggleAllFilesCollapsed: () => {},
    } as unknown as ReviewState;

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(
      <ReviewStateProvider value={state}>
        <ReviewDockRightActions {...({ activePanel: null } as unknown as IDockviewHeaderActionsProps)} />
      </ReviewStateProvider>,
    ));

    // One button, no "Split" / "Unified" words: it shows the layout on screen and offers the other.
    const buttons = Array.from(host.querySelectorAll('button'));
    expect(buttons.some((button) => button.textContent === 'Split' || button.textContent === 'Unified')).toBe(false);
    const toggle = host.querySelector<HTMLButtonElement>('[data-diff-layout-toggle]')!;
    expect(toggle.getAttribute('data-diff-layout-toggle')).toBe('unified');
    expect(toggle.getAttribute('aria-label')).toBe('Switch to Split view');
    await act(async () => toggle.click());
    expect(onDiffStyleChange).toHaveBeenCalledWith('split');

    // The gear opens the popover: no layout row (the button above has it), and code review's two repository rows.
    const gear = buttons.find((button) => button.title === 'Diff display options')!;
    await act(async () => gear.click());
    const popup = document.querySelector('[data-diff-display-popup]')!;
    const rows = Array.from(popup.querySelectorAll('[role="switch"]')).map((row) => row.textContent);
    expect(rows).toEqual(['Wrap long lines', 'Line numbers', 'Backgrounds', 'Whole file', 'Hide whitespace']);
    expect(popup.textContent).not.toContain('Unified');
  });
});
