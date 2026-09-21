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

  test.skipIf(!hasDom)('preserves desktop split and options controls', async () => {
    const state = {
      diffStyle: 'unified',
      onDiffStyleChange: mock(() => {}),
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

    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Split')).toBe(true);
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.title === 'Diff display options')).toBe(true);
  });
});
