import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { DocBadges, type DocBadgesProps } from './DocBadges';

const hasDom = typeof document !== 'undefined';

const originalFetch = globalThis.fetch;
let host: HTMLElement | null = null;
let root: Root | null = null;

function exactText(text: string): HTMLElement {
  const match = Array.from(host?.querySelectorAll<HTMLElement>('span') ?? [])
    .find((element) => element.textContent === text);
  if (!match) throw new Error(`Expected to find text: ${text}`);
  return match;
}

function openInButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('button[aria-label="Open in Finder"]');
  if (!button) throw new Error('Expected the Finder open-in button to render');
  return button;
}

function appearsBefore(first: Node, second: Node): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

async function renderBadges(props: Partial<DocBadgesProps>): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(<DocBadges layout="column" {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('DocBadges open-in placement', () => {
  beforeEach(() => {
    setStorageBackend({
      getItem: () => 'reveal',
      setItem: () => {},
      removeItem: () => {},
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async () => Response.json({
        available: true,
        apps: [{ id: 'reveal', label: 'Finder', kind: 'file-manager', icon: 'finder' }],
      }),
    });
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    resetStorageBackend();
  });

  test.skipIf(!hasDom)('places the selector after the repository and branch for a local annotate file', async () => {
    await renderBadges({
      repoInfo: { display: 'plannotator/workspaces', branch: 'rooms/resurrect' },
      openInAppPath: '/tmp/runbook.md',
    });

    const repository = exactText('plannotator/workspaces');
    const branch = exactText('rooms/resurrect');
    const button = openInButton();
    const repositoryRow = repository.parentElement;

    expect(repositoryRow).not.toBeNull();
    expect(repositoryRow?.contains(branch)).toBe(true);
    expect(repositoryRow?.contains(button)).toBe(true);
    expect(appearsBefore(repository, branch)).toBe(true);
    expect(appearsBefore(branch, button)).toBe(true);
  });

  test.skipIf(!hasDom)('does not add a selector in plan mode', async () => {
    await renderBadges({
      repoInfo: { display: 'plannotator/workspaces', branch: 'rooms/resurrect' },
      openInAppPath: null,
    });

    expect(exactText('plannotator/workspaces')).toBeInstanceOf(HTMLElement);
    expect(host?.querySelector('button[aria-label="Open in Finder"]')).toBeNull();
  });

  test.skipIf(!hasDom)('keeps the selector after an explicit source filename', async () => {
    await renderBadges({
      repoInfo: { display: 'plannotator/workspaces', branch: 'rooms/resurrect' },
      sourceInfo: 'runbook.html',
      openInAppPath: '/tmp/runbook.html',
    });

    const source = exactText('runbook.html');
    const button = openInButton();

    expect(source.parentElement?.contains(button)).toBe(true);
    expect(appearsBefore(source, button)).toBe(true);
    expect(host?.querySelectorAll('button[aria-label="Open in Finder"]')).toHaveLength(1);
  });

  test.skipIf(!hasDom)('keeps a standalone selector when no repository or file row exists', async () => {
    await renderBadges({ openInAppPath: '/tmp/runbook.md' });

    expect(openInButton()).toBeInstanceOf(HTMLButtonElement);
  });

  test.skipIf(!hasDom)('does not add a selector for a URL annotation', async () => {
    await renderBadges({
      sourceInfo: 'https://example.com/runbook',
      openInAppPath: 'https://example.com/runbook',
    });

    expect(exactText('example.com')).toBeInstanceOf(HTMLElement);
    expect(host?.querySelector('button[aria-label="Open in Finder"]')).toBeNull();
  });

  test.skipIf(!hasDom)('labels the diff badge with its baseline in annotate/folder sessions', async () => {
    await renderBadges({
      planDiffStats: { additions: 3, deletions: 1, modifications: 0 },
      hasPreviousVersion: true,
      onPlanDiffToggle: () => {},
      planDiffBaselineLabel: 'since last review',
      planDiffBaselineTooltip: 'Changes since you last reviewed this file',
    });

    const badge = Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent?.includes('+3'));
    if (!badge) throw new Error('Expected the diff badge to render');
    expect(badge.textContent).toContain('since last review');
    expect(badge.title).toBe('Changes since you last reviewed this file');
  });

  test.skipIf(!hasDom)('plan review diff badge renders exactly as before when no baseline label is passed', async () => {
    await renderBadges({
      planDiffStats: { additions: 3, deletions: 1, modifications: 0 },
      hasPreviousVersion: true,
      onPlanDiffToggle: () => {},
    });

    const badge = Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent?.includes('+3'));
    if (!badge) throw new Error('Expected the diff badge to render');
    expect(badge.textContent).toBe('+3/-1');
    expect(badge.title).toBe('Show what changed from previous version');
  });

  test.skipIf(!hasDom)('keeps folder-file selectors after the active filename', async () => {
    await renderBadges({
      linkedDocInfo: {
        filepath: '/tmp/docs/runbook.md',
        onBack: () => {},
        variant: 'folder-file',
      },
      openInAppPath: '/tmp/docs/runbook.md',
    });

    const filename = exactText('runbook.md');
    const button = openInButton();

    expect(filename.parentElement?.contains(button)).toBe(true);
    expect(appearsBefore(filename, button)).toBe(true);
  });
});
