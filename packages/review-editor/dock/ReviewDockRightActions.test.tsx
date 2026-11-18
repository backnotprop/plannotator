import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { configStore } from '@plannotator/ui/config';
import { ReviewDockRightActions } from './ReviewDockRightActions';
import { ReviewStateProvider, type ReviewState } from './ReviewStateContext';
import { PaneSlotContext, usePaneDiffStyle, type PaneSlot } from '../workspace/paneContext';
import type { WorkspaceStore } from '../workspace/workspaceStore';

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
    expect(rows).toEqual(['Wrap long lines', 'Line numbers', 'Backgrounds', 'Whole file', 'Hide whitespace', 'Show moved & renamed code']);
    expect(popup.textContent).not.toContain('Unified');
  });

  test.skipIf(!hasDom)('the top bar has no jump history buttons, and its buttons are the same with or without history', async () => {
    const render = async (canBack: boolean, canForward: boolean) => {
      const state = {
        diffStyle: 'split',
        onDiffStyleChange: () => {},
        isCompactTouchLayout: false,
        allFilesAllCollapsed: false,
        onToggleAllFilesCollapsed: () => {},
        navigation: { canBack, canForward, back: () => {}, forward: () => {} },
      } as unknown as ReviewState;
      await act(async () => root?.render(
        <ReviewStateProvider value={state}>
          <ReviewDockRightActions activePanel={null} />
        </ReviewStateProvider>,
      ));
      return [...host!.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.title);
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const empty = await render(false, false);
    const full = await render(true, true);
    expect(full).toEqual(empty);
    expect(full.some((label) => /back|forward/i.test(label))).toBe(false);
    expect(host.querySelector('[data-jump-history], [data-nav-history]')).toBeNull();
  });

  test.skipIf(!hasDom)('Collapse all files sits just left of Split/Unified while All changes is shown in either pane; elsewhere its place stays empty so the bar never moves', async () => {
    const onToggleAllFilesCollapsed = mock(() => {});
    const render = async (panel: string, collapsed: boolean) => {
      const state = {
        diffStyle: 'split',
        onDiffStyleChange: () => {},
        isCompactTouchLayout: false,
        allFilesAllCollapsed: collapsed,
        onToggleAllFilesCollapsed,
      } as unknown as ReviewState;
      await act(async () => root?.render(
        <ReviewStateProvider value={state}>
          <ReviewDockRightActions activePanel={{ id: panel }} />
        </ReviewStateProvider>,
      ));
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await render('review-all-files', false);
    const button = host.querySelector<HTMLButtonElement>('[data-header-collapse-all-files]')!;
    expect(button.getAttribute('aria-label')).toBe('Collapse all files');
    expect(button.nextElementSibling?.hasAttribute('data-diff-layout-toggle')).toBe(true);
    await act(async () => button.click());
    expect(onToggleAllFilesCollapsed).toHaveBeenCalledTimes(1);
    await render('review-all-files', true);
    expect(host.querySelector('[data-header-collapse-all-files]')!.getAttribute('aria-label')).toBe('Expand all files');
    await act(async () => root?.render(
      <ReviewStateProvider value={{ diffStyle: 'split', onDiffStyleChange: () => {}, isCompactTouchLayout: false, allFilesAllCollapsed: false, onToggleAllFilesCollapsed } as unknown as ReviewState}>
        <ReviewDockRightActions activePanel={{ id: 'review-diff' }} allChangesShown />
      </ReviewStateProvider>,
    ));
    const otherPane = host.querySelector<HTMLButtonElement>('[data-header-collapse-all-files]')!;
    expect(otherPane.disabled).toBe(false);
    await act(async () => otherPane.click());
    expect(onToggleAllFilesCollapsed).toHaveBeenCalledTimes(2);
    expect(otherPane.hasAttribute('aria-pressed')).toBe(false);
    await render('review-diff', false);
    const hidden = host.querySelector<HTMLButtonElement>('[data-header-collapse-all-files]')!;
    expect(hidden.disabled).toBe(true);
    expect(hidden.classList.contains('invisible')).toBe(true);
  });

  test.skipIf(!hasDom)('Split saved but every shown diff pane too narrow: the button says Split needs a wider pane, and a wide pane makes it plain again', async () => {
    const pane = (width: number) => {
      const element = document.createElement('section');
      Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width });
      return element;
    };
    const elements = [pane(500), pane(900)];
    const layout = { panes: [{ tabs: [], activeId: 'left' }, { tabs: [], activeId: 'right' }], activePane: 0 };
    const store = { subscribe: () => () => {}, getLayout: () => layout, paneElement: (index: number) => elements[index] } as unknown as WorkspaceStore;
    const slot = (paneIndex: number, tabId: string): PaneSlot => ({ store, paneIndex, tabId, component: 'review-all-files' });
    const drawn: string[] = [];
    const Probe = ({ name }: { name: string }) => {
      drawn.push(`${name}:${usePaneDiffStyle('split')}`);
      return null;
    };
    const left = slot(0, 'left');
    const right = slot(1, 'right');
    const onDiffStyleChange = mock((_style: 'split' | 'unified') => {});
    const state = { diffStyle: 'split', onDiffStyleChange, isCompactTouchLayout: false, allFilesAllCollapsed: false, onToggleAllFilesCollapsed: () => {} } as unknown as ReviewState;
    const render = async (withWide: boolean) => act(async () => root?.render(
      <ReviewStateProvider value={state}>
        <PaneSlotContext.Provider value={left}><Probe name="left" /></PaneSlotContext.Provider>
        {withWide && <PaneSlotContext.Provider value={right}><Probe name="right" /></PaneSlotContext.Provider>}
        <ReviewDockRightActions activePanel={null} />
      </ReviewStateProvider>,
    ));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await render(false);
    expect(drawn.at(-1)).toBe('left:unified');
    const toggle = host.querySelector<HTMLButtonElement>('[data-diff-layout-toggle]')!;
    expect(toggle.getAttribute('data-diff-layout-toggle')).toBe('split');
    expect(toggle.hasAttribute('data-split-too-narrow')).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('Split needs a wider pane. Showing Unified.');
    expect(toggle.title).toBe('Split needs a wider pane. Showing Unified.');
    expect(toggle.disabled).toBe(false);
    await act(async () => toggle.click());
    expect(onDiffStyleChange).toHaveBeenCalledWith('unified');

    await render(true);
    expect(drawn).toContain('right:split');
    expect(toggle.hasAttribute('data-split-too-narrow')).toBe(false);
    expect(toggle.getAttribute('aria-label')).toBe('Switch to Unified view');
  });
});
