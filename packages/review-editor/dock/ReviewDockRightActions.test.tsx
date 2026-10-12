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

describe('ReviewDockRightActions: "Preview .md"', () => {
  async function renderWith(markdownPreview: unknown) {
    const state = {
      diffStyle: 'unified',
      onDiffStyleChange: mock(() => {}),
      isCompactTouchLayout: false,
      allFilesAllCollapsed: false,
      onToggleAllFilesCollapsed: () => {},
      markdownPreview,
    } as unknown as ReviewState;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(
      <ReviewStateProvider value={state}>
        <ReviewDockRightActions {...({ activePanel: null } as unknown as IDockviewHeaderActionsProps)} />
      </ReviewStateProvider>,
    ));
    return host;
  }

  test.skipIf(!hasDom)('sits beside Split | Unified, never inside it, and presses the switch for every Markdown file', async () => {
    const toggleAll = mock(() => {});
    const el = await renderWith({ hasMarkdownFiles: true, all: false, toggleAll });
    const button = el.querySelector<HTMLButtonElement>('[data-markdown-preview-all]')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    const split = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Split')!;
    expect(split.parentElement!.contains(button)).toBe(false);
    await act(async () => button.click());
    expect(toggleAll).toHaveBeenCalledTimes(1);
  });

  test.skipIf(!hasDom)('is hidden for a review without Markdown files, or a server without the preview', async () => {
    expect((await renderWith({ hasMarkdownFiles: false, all: false, toggleAll: () => {} })).querySelector('[data-markdown-preview-all]')).toBeNull();
    if (root) await act(async () => root?.unmount());
    host?.remove();
    expect((await renderWith(undefined)).querySelector('[data-markdown-preview-all]')).toBeNull();
  });
});
