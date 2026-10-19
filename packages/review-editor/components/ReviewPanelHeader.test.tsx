/**
 * DOM coverage (DOM_TESTS=1) for the top of the code review sidebar
 * (approved design record "review-sidebar-header", variant "sentence").
 *
 * Regressions guarded:
 *  - a control of the old header (view, diff type, base, scope, Go to File)
 *    no longer reachable in one click, or its menu no longer opening;
 *  - a long base losing its end (the part that tells stacked branches apart)
 *    or its full name;
 *  - a header control that cannot take keyboard focus;
 *  - Changes | All files losing its counts, its choice, or the live status;
 *  - choosing All files from Git status not landing on the tree.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewPanelHeader, ariaKeyShortcut, diffWords, middleTruncateRef, type ReviewPanelHeaderModel } from './ReviewPanelHeader';
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

describe.skipIf(!hasDom)('ReviewPanelHeader', () => {
  test('three rows: the view tabs, the sentence, and the scope with Go to File', async () => {
    const el = await mount(<ReviewPanelHeader model={model()} width={256} />);
    const group = el.querySelector('[role="group"][aria-label="Panel view"]')!;
    expect([...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Tree', 'Git status', 'Commits']);
    expect(viewTab(el, 'tree').getAttribute('aria-pressed')).toBe('true');
    expect(sentence(el).textContent).toBe('All changessincemain');
    expect(el.querySelector('[data-tree-scope="changes"]')?.textContent).toBe('Changes4');
    expect(el.querySelector('[data-tree-scope="all"]')?.textContent).toBe('All files8');
    expect(el.querySelector('[data-go-to-file-button]')).not.toBeNull();
  });

  test('every control is a button that takes keyboard focus', async () => {
    const el = await mount(<ReviewPanelHeader model={model()} width={256} />);
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')];
    // Tree, Git status, Commits, diff type, base, Changes, All files, Go to File.
    expect(buttons.length).toBe(8);
    for (const button of buttons) {
      expect(button.disabled).toBe(false);
      expect(button.tabIndex).toBe(0);
      await act(async () => button.focus());
      expect(document.activeElement).toBe(button);
      // The visible ring is the shared focus-visible class.
      expect(button.className).toContain('focus-visible:ring-2');
    }
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

  test('narrow: icon tabs that keep their names, "All", and Go to File without its keys', async () => {
    const el = await mount(<ReviewPanelHeader model={model()} width={160} />);
    expect(viewTab(el, 'sections').textContent).toBe('');
    expect(viewTab(el, 'sections').getAttribute('aria-label')).toBe('Git status');
    expect(el.querySelector('[data-tree-scope="all"]')?.textContent).toBe('All8');
    expect(el.querySelector('[data-go-to-file-button] kbd')).toBeNull();
  });

  test('a view tab and a scope reach the app', async () => {
    const onSelectView = mock((_view: string) => {});
    const onScope = mock((_scope: string) => {});
    const el = await mount(
      <ReviewPanelHeader model={model({ onSelectView, scope: { value: 'changes', onSelect: onScope, changed: 4, all: 8 } })} width={256} />,
    );
    await act(async () => viewTab(el, 'commits').click());
    expect(onSelectView).toHaveBeenLastCalledWith('commits');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-tree-scope="all"]')!.click());
    expect(onScope).toHaveBeenLastCalledWith('all');
  });

  test('Git status: the diff is fixed to all changes, and All files goes to the tree', async () => {
    const onSelectView = mock((_view: string) => {});
    const onScope = mock((_scope: string) => {});
    const el = await mount(
      <ReviewPanelHeader
        model={model({ view: 'sections', diff: undefined, onSelectView, scope: { value: 'all', onSelect: onScope, changed: 4, all: 8 } })}
        width={256}
      />,
    );
    expect(diffTrigger(el)).toBeNull();
    expect(sentence(el).textContent).toBe('All changessincemain');
    // Git status lists the changes, whatever the tree's scope.
    expect(el.querySelector('[data-tree-scope="changes"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-tree-scope="changes"]')!.click());
    expect(onSelectView).not.toHaveBeenCalled();
    await act(async () => el.querySelector<HTMLButtonElement>('[data-tree-scope="all"]')!.click());
    expect(onSelectView).toHaveBeenLastCalledWith('tree');
    expect(onScope).toHaveBeenLastCalledWith('all');
  });

  test('Commits: no sentence and no scope, Go to File stays', async () => {
    const el = await mount(<ReviewPanelHeader model={model({ view: 'commits', diff: undefined, base: undefined })} width={256} />);
    expect(el.querySelector('[data-panel-sentence]')).toBeNull();
    expect(el.querySelector('[data-tree-scope]')).toBeNull();
    expect(el.querySelector('[data-go-to-file-button]')).not.toBeNull();
  });

  test('a session with one view draws "Files", not a lone tab', async () => {
    const el = await mount(<ReviewPanelHeader model={model({ showSections: false, showCommits: false })} width={256} />);
    expect(el.querySelector('[role="group"][aria-label="Panel view"]')).toBeNull();
    expect(el.querySelector('[data-panel-view]')).toBeNull();
    expect(el.textContent).toContain('Files');
  });

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

  test('a live listing: a dot in the pill, its words in a polite status of their own', async () => {
    const el = await mount(
      <ReviewPanelHeader model={model({ scope: { value: 'all', onSelect: () => {}, changed: 4, all: 8 }, repo: readyRepo() })} width={256} />,
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
      <ReviewPanelHeader
        model={model({ scope: { value: 'all', onSelect: () => {}, changed: 4, all: 8 }, repo: readyRepo({ live: false, truncated: true }) })}
        width={256}
      />,
    );
    expect(el.querySelector('[data-repo-listing-status="partial"]')?.textContent).toBe('Part of the repository is listed (the platform stopped early).');
  });

  test('while a search runs, Changes | All files steps aside; Go to File stays', async () => {
    const el = await mount(<ReviewPanelHeader model={model({ searching: true, scope: { value: 'all', onSelect: () => {}, changed: 4, all: 8 } })} width={256} />);
    expect(el.querySelector('[data-tree-scope]')).toBeNull();
    expect(el.querySelector('[data-go-to-file-button]')).not.toBeNull();
  });

  test('Go to File names its keys for assistive tech, not the drawn keycaps', async () => {
    expect(ariaKeyShortcut('Mod+P', true)).toBe('Meta+P');
    expect(ariaKeyShortcut('Mod+P', false)).toBe('Control+P');
    const el = await mount(<ReviewPanelHeader model={model()} width={256} />);
    expect(el.querySelector('[data-go-to-file-button]')?.getAttribute('aria-keyshortcuts')).toMatch(/^(Meta|Control)\+P$/);
  });

});
