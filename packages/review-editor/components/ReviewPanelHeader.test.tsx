/**
 * DOM coverage (DOM_TESTS=1) for the top of the code review sidebar
 * (approved design records "review-sidebar-header", variant "sentence", and
 * "review-sidebar-aligned").
 *
 * Regressions guarded:
 *  - a control of the header (view, diff type, base, Go to File) or of the
 *    scope (Changes | All files) no longer reachable in one click, or its menu
 *    no longer opening;
 *  - the view switch losing its tabs semantics: one Tab stop, Left and Right
 *    moving focus between the tabs (wrapping) without switching the view, the
 *    list below labelled by the chosen tab, focus kept on the chosen tab when
 *    the panel remounts for the new view;
 *  - a long base losing its end (the part that tells stacked branches apart)
 *    or its full name;
 *  - a header control that cannot take keyboard focus;
 *  - Changes | All files losing its counts, its choice, or the live status;
 *  - choosing All files from Git status not landing on the tree.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  REVIEW_PANEL_BODY_ID,
  ReviewPanelHeader,
  ScopeSwitch,
  ariaKeyShortcut,
  diffWords,
  middleTruncateRef,
  reviewPanelBodyProps,
  type ReviewPanelHeaderModel,
} from './ReviewPanelHeader';
import type { RepoFilesState } from '../hooks/useRepoFiles';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const LONG_BASE = 'feature/very-long-branch-name-for-a-stack';

const OPTIONS = [
  { id: 'since-base', label: 'All changes since main' },
  { id: 'uncommitted', label: 'Uncommitted changes' },
  { id: 'merge-base', label: 'Committed changes (PR view)' },
];

function model(overrides: Partial<ReviewPanelHeaderModel> = {}): ReviewPanelHeaderModel {
  return {
    view: 'tree',
    showSections: true,
    showCommits: true,
    onSelectView: () => {},
    scope: { value: 'changes', onSelect: () => {}, changed: 4, all: 8 },
    diff: { options: OPTIONS, active: 'since-base', onSelect: () => {}, activeBase: 'main', hasBasePicker: true },
    base: {
      availableBranches: { local: ['main', LONG_BASE], remote: [] },
      selectedBase: 'main',
      detectedBase: 'main',
      onSelectBase: () => {},
      copy: {
        rowLabel: 'compare against',
        triggerLabel: 'base',
        triggerTitlePrefix: 'Review base',
        searchPlaceholder: 'Search branches…',
        emptyText: 'No branches match.',
        localGroupLabel: 'Local',
        remoteGroupLabel: 'Remote',
      },
    },
    onGoToFile: () => {},
    ...overrides,
  };
}

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  // Menus and popovers portal into the body.
  if (hasDom) document.body.innerHTML = '';
});

const viewTab = (el: HTMLElement, view: string) => el.querySelector<HTMLButtonElement>(`[data-panel-view="${view}"]`)!;
const sentence = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-panel-sentence]')!;
const diffTrigger = (el: HTMLElement) => sentence(el).querySelector<HTMLButtonElement>('button[aria-label^="Changes shown"]')!;
const baseTrigger = (el: HTMLElement) => sentence(el).querySelector<HTMLButtonElement>('button[aria-label^="Review base"]')!;

async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('the sentence words', () => {
  test('a base diff reads "<noun> <connector>" and leaves the base to its own word', () => {
    expect(diffWords(model())).toEqual({ noun: 'All changes', connector: 'since' });
    expect(diffWords(model({ diff: { ...model().diff!, active: 'merge-base' } }))).toEqual({ noun: 'Committed changes', connector: 'since' });
    expect(diffWords(model({ view: 'sections', diff: undefined }))).toEqual({ noun: 'All changes', connector: 'since' });
  });

  test('without a base word the option says everything itself', () => {
    expect(diffWords(model({ base: undefined }))).toEqual({ noun: 'All changes since main', connector: null });
    expect(diffWords(model({ base: undefined, diff: { ...model().diff!, active: 'uncommitted' } }))).toEqual({ noun: 'Uncommitted changes', connector: null });
  });

  test('a long base keeps its start and end; the end grows with the panel', () => {
    expect(middleTruncateRef(LONG_BASE, 256)).toBe('feature/very-l…ame-for-a-stack');
    expect(middleTruncateRef(LONG_BASE, 160)).toBe('feature…-a-stack');
    expect(middleTruncateRef('main', 160)).toBe('main');
    // A SHA base is its short form first.
    expect(middleTruncateRef('4f2a9c1d4f2a9c1d4f2a9c1d4f2a9c1d4f2a9c1d', 160)).toBe('4f2a9c1');
  });
});

describe('the list under the tabs', () => {
  test('is the tab panel of the chosen tab when the header draws tabs', () => {
    expect(reviewPanelBodyProps(model({ view: 'sections' }))).toEqual({
      id: REVIEW_PANEL_BODY_ID,
      role: 'tabpanel',
      'aria-labelledby': 'review-panel-tab-sections',
    });
  });

  test('is a plain region with one view or no header', () => {
    expect(reviewPanelBodyProps(model({ showSections: false, showCommits: false }))).toEqual({});
    expect(reviewPanelBodyProps(undefined)).toEqual({});
  });
});

describe.skipIf(!hasDom)('ReviewPanelHeader', () => {
  test('Go to file, then the views as tabs, then the sentence', async () => {
    const el = await mount(<ReviewPanelHeader model={model()} width={256} />);
    const tablist = el.querySelector('[role="tablist"][aria-label="Panel view"]')!;
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Tree', 'Git status', 'Commits']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    for (const tab of tabs) expect(tab.getAttribute('aria-controls')).toBe(REVIEW_PANEL_BODY_ID);
    // The tab panel names itself by the chosen tab's id.
    expect(tabs[0].id).toBe(reviewPanelBodyProps(model())['aria-labelledby']!);
    expect(sentence(el).textContent).toBe('All changessincemain');
    expect(el.querySelector('[data-go-to-file-button]')).not.toBeNull();
    // Go to file comes first in reading and Tab order.
    expect(el.querySelector('button')).toBe(el.querySelector('[data-go-to-file-button]'));
  });

  test('every control takes keyboard focus; the tabs are one Tab stop', async () => {
    const el = await mount(<ReviewPanelHeader model={model()} width={256} />);
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')];
    // Go to File, Tree, Git status, Commits, diff type, base.
    expect(buttons.length).toBe(6);
    const tabStops = buttons.filter((b) => b.tabIndex === 0);
    expect(tabStops.map((b) => b.getAttribute('data-panel-view') ?? b.getAttribute('aria-label'))).toEqual([
      'Go to File…',
      'tree',
      'Changes shown: All changes',
      'Review base: main',
    ]);
    for (const button of buttons) {
      expect(button.disabled).toBe(false);
      await act(async () => button.focus());
      expect(document.activeElement).toBe(button);
      // The visible ring is the shared focus-visible class.
      expect(button.className).toContain('focus-visible:ring-2');
    }
  });

  test('Left and Right move focus between the tabs, wrapping, and never switch the view', async () => {
    const onSelectView = mock((_view: string) => {});
    const el = await mount(<ReviewPanelHeader model={model({ onSelectView })} width={256} />);
    await act(async () => viewTab(el, 'tree').focus());
    let event = await press(document.activeElement!, 'ArrowRight');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(viewTab(el, 'sections'));
    await press(document.activeElement!, 'ArrowRight');
    expect(document.activeElement).toBe(viewTab(el, 'commits'));
    await press(document.activeElement!, 'ArrowRight');
    expect(document.activeElement).toBe(viewTab(el, 'tree'));
    await press(document.activeElement!, 'ArrowLeft');
    expect(document.activeElement).toBe(viewTab(el, 'commits'));
    // With a modifier the arrow is not the tabs' key.
    event = await press(document.activeElement!, 'ArrowLeft', { metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(viewTab(el, 'commits'));
    expect(onSelectView).not.toHaveBeenCalled();
    // Up and Down stay with the page (file navigation).
    event = await press(document.activeElement!, 'ArrowDown');
    expect(event.defaultPrevented).toBe(false);
  });

  test('choosing a tab reaches the app and focus stays on it in the new panel', async () => {
    const onSelectView = mock((_view: string) => {});
    const el = await mount(<ReviewPanelHeader model={model({ onSelectView })} width={256} />);
    // Each view is its own panel: in the app the click's own update unmounts
    // this header and mounts the new view's.
    await act(async () => {
      viewTab(el, 'commits').click();
      root?.unmount();
      root = createRoot(el);
      root.render(<ReviewPanelHeader model={model({ view: 'commits', onSelectView })} width={256} />);
    });
    expect(onSelectView).toHaveBeenLastCalledWith('commits');
    expect(document.activeElement).toBe(viewTab(el, 'commits'));
    expect(viewTab(el, 'commits').tabIndex).toBe(0);
    expect(viewTab(el, 'tree').tabIndex).toBe(-1);
  });

  test('a tab choice the app refused does not pull focus later', async () => {
    // The app keeps the tree (the switch is refused).
    const el = await mount(<ReviewPanelHeader model={model({ onSelectView: () => {} })} width={256} />);
    await act(async () => viewTab(el, 'commits').click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    // Later the view changes by another route.
    await act(async () => root?.render(<ReviewPanelHeader model={model({ view: 'commits' })} width={256} />));
    expect(document.activeElement).toBe(outside);
  });

  test('a panel that mounts without a tab choice leaves focus alone', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await mount(<ReviewPanelHeader model={model({ view: 'sections' })} width={256} />);
    expect(document.activeElement).toBe(outside);
  });

  test('the diff word opens the diff type menu, and a choice reaches the app', async () => {
    const onSelect = mock((_id: string) => {});
    const el = await mount(<ReviewPanelHeader model={model({ diff: { ...model().diff!, onSelect } })} width={256} />);
    await act(async () => diffTrigger(el).click());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'All changes since main',
      'Uncommitted changes',
      'Committed changes (PR view)',
    ]);
    await act(async () => items[1].click());
    expect(onSelect).toHaveBeenCalledWith('uncommitted');
  });

  test('the base word opens the base picker with its search', async () => {
    const onSelectBase = mock((_base: string) => {});
    const el = await mount(<ReviewPanelHeader model={model({ base: { ...model().base!, onSelectBase } })} width={256} />);
    await act(async () => baseTrigger(el).click());
    const search = document.querySelector<HTMLInputElement>('input[placeholder="Search branches…"]');
    expect(search).not.toBeNull();
    const option = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find((b) => b.textContent?.includes(LONG_BASE));
    expect(option).toBeDefined();
    await act(async () => option!.click());
    expect(onSelectBase).toHaveBeenCalledWith(LONG_BASE);
  });

  test('a long base keeps its start and end on screen and its full name in the title', async () => {
    const base = { ...model().base!, selectedBase: LONG_BASE };
    const el = await mount(<ReviewPanelHeader model={model({ base })} width={256} />);
    const trigger = baseTrigger(el);
    expect(trigger.getAttribute('title')).toBe(`Review base: ${LONG_BASE}`);
    expect(trigger.getAttribute('aria-label')).toBe(`Review base: ${LONG_BASE}`);
    expect(trigger.querySelector('[data-base-ref]')?.textContent).toBe('feature/very-l…ame-for-a-stack');
  });

  test('a short base is drawn whole', async () => {
    const el = await mount(<ReviewPanelHeader model={model()} width={160} />);
    expect(baseTrigger(el).querySelector('[data-base-ref]')?.textContent).toBe('main');
  });

  test('narrow: icon tabs that keep their names, and Go to File without its keys', async () => {
    const el = await mount(<ReviewPanelHeader model={model()} width={160} />);
    expect(viewTab(el, 'sections').textContent).toBe('');
    expect(viewTab(el, 'sections').getAttribute('aria-label')).toBe('Git status');
    expect(el.querySelector('[data-go-to-file-button] kbd')).toBeNull();
  });

  test('Git status: the diff is fixed to all changes', async () => {
    const el = await mount(<ReviewPanelHeader model={model({ view: 'sections', diff: undefined })} width={256} />);
    expect(diffTrigger(el)).toBeNull();
    expect(sentence(el).textContent).toBe('All changessincemain');
  });

  test('Commits: no sentence, Go to File stays', async () => {
    const el = await mount(<ReviewPanelHeader model={model({ view: 'commits', diff: undefined, base: undefined })} width={256} />);
    expect(el.querySelector('[data-panel-sentence]')).toBeNull();
    expect(el.querySelector('[data-go-to-file-button]')).not.toBeNull();
  });

  test('a session with one view draws "Files", not a lone tab', async () => {
    const el = await mount(<ReviewPanelHeader model={model({ showSections: false, showCommits: false })} width={256} />);
    expect(el.querySelector('[role="tablist"]')).toBeNull();
    expect(el.querySelector('[data-panel-view]')).toBeNull();
    expect(el.textContent).toContain('Files');
  });

  test('Go to File names its keys for assistive tech, not the drawn keycaps', async () => {
    expect(ariaKeyShortcut('Mod+P', true)).toBe('Meta+P');
    expect(ariaKeyShortcut('Mod+P', false)).toBe('Control+P');
    const onGoToFile = mock(() => {});
    const el = await mount(<ReviewPanelHeader model={model({ onGoToFile })} width={256} />);
    const button = el.querySelector<HTMLButtonElement>('[data-go-to-file-button]')!;
    expect(button.getAttribute('aria-keyshortcuts')).toMatch(/^(Meta|Control)\+P$/);
    await act(async () => button.click());
    expect(onGoToFile).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!hasDom)('ScopeSwitch (Changes | All files)', () => {
  const readyRepo = (overrides: Partial<Extract<RepoFilesState, { status: 'ready' }>> = {}): Extract<RepoFilesState, { status: 'ready' }> => ({
    status: 'ready',
    revision: { kind: 'worktree', label: 'working tree' },
    total: 8,
    live: true,
    truncated: false,
    paths: [],
    dirs: new Map(),
    onDisk: { 'a.ts': 'M', 'b.ts': 'A' },
    updatedAt: Date.now(),
    liveVersion: 0,
    ...overrides,
  });

  test('both scopes with their counts, the chosen one pressed', async () => {
    const el = await mount(<ScopeSwitch model={model()} width={256} />);
    expect(el.querySelector('[role="group"][aria-label="Files shown in the tree"]')).not.toBeNull();
    expect(el.querySelector('[data-tree-scope="changes"]')?.textContent).toBe('Changes4');
    expect(el.querySelector('[data-tree-scope="all"]')?.textContent).toBe('All files8');
    expect(el.querySelector('[data-tree-scope="changes"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-tree-scope="all"]')?.getAttribute('aria-pressed')).toBe('false');
    // All files' count is in its name and tooltip, so the row keeps one line.
    expect(el.querySelector('[data-tree-scope="all"]')?.getAttribute('title')).toContain('(8 files)');
  });

  test('narrow: All files reads "All"', async () => {
    const el = await mount(<ScopeSwitch model={model()} width={160} />);
    expect(el.querySelector('[data-tree-scope="all"]')?.textContent).toBe('All8');
  });

  test('a scope reaches the app', async () => {
    const onScope = mock((_scope: string) => {});
    const el = await mount(<ScopeSwitch model={model({ scope: { value: 'changes', onSelect: onScope, changed: 4, all: 8 } })} width={256} />);
    await act(async () => el.querySelector<HTMLButtonElement>('[data-tree-scope="all"]')!.click());
    expect(onScope).toHaveBeenLastCalledWith('all');
  });

  test('Git status: Changes is on, and All files goes to the tree', async () => {
    const onSelectView = mock((_view: string) => {});
    const onScope = mock((_scope: string) => {});
    const el = await mount(
      <ScopeSwitch model={model({ view: 'sections', diff: undefined, onSelectView, scope: { value: 'all', onSelect: onScope, changed: 4, all: 8 } })} width={256} />,
    );
    // Git status lists the changes, whatever the tree's scope.
    expect(el.querySelector('[data-tree-scope="changes"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-tree-scope="changes"]')!.click());
    expect(onSelectView).not.toHaveBeenCalled();
    await act(async () => el.querySelector<HTMLButtonElement>('[data-tree-scope="all"]')!.click());
    expect(onSelectView).toHaveBeenLastCalledWith('tree');
    expect(onScope).toHaveBeenLastCalledWith('all');
  });

  test('Commits and a running search show no scope', async () => {
    let el = await mount(<ScopeSwitch model={model({ view: 'commits' })} width={256} />);
    expect(el.querySelector('[data-tree-scope]')).toBeNull();
    await act(async () => root?.unmount());
    host?.remove();
    el = await mount(<ScopeSwitch model={model({ searching: true })} width={256} />);
    expect(el.querySelector('[data-tree-scope]')).toBeNull();
  });

  test('a live listing: a dot in the pill, its words in a polite status of their own', async () => {
    const el = await mount(
      <ScopeSwitch model={model({ scope: { value: 'all', onSelect: () => {}, changed: 4, all: 8 }, repo: readyRepo() })} width={256} />,
    );
    const all = el.querySelector<HTMLButtonElement>('[data-tree-scope="all"]')!;
    // The button is named by its words and count alone; the dot is decoration.
    expect(all.textContent).toBe('All files8');
    expect(all.querySelector('[data-repo-listing-dot="live"]')?.getAttribute('aria-hidden')).toBe('true');
    const status = el.querySelector('[role="status"][data-repo-listing-status="live"]')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('All files is live: 1 added, 1 edited on disk since the diff.');
    // No age in the announced words: they do not change on the 15 s tick.
    expect(status.textContent).not.toContain('ago');
  });

  test('a partial listing says so in words on screen', async () => {
    const el = await mount(
      <ScopeSwitch
        model={model({ scope: { value: 'all', onSelect: () => {}, changed: 4, all: 8 }, repo: readyRepo({ live: false, truncated: true }) })}
        width={256}
      />,
    );
    expect(el.querySelector('[data-repo-listing-status="partial"]')?.textContent).toBe('Part of the repository is listed (the platform stopped early).');
  });
});
