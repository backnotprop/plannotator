import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarContainer } from './SidebarContainer';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;

const baseProps: React.ComponentProps<typeof SidebarContainer> = {
  activeTab: 'toc',
  onTabChange: () => {},
  onClose: () => {},
  width: 'var(--toc-w, 240px)',
  blocks: [],
  annotations: [],
  activeSection: null,
  onTocNavigate: () => {},
  versionInfo: null,
  versions: [],
  selectedBaseVersion: null,
  onSelectBaseVersion: () => {},
  isPlanDiffActive: false,
  hasPreviousVersion: false,
  onActivatePlanDiff: () => {},
  isLoadingVersions: false,
  isSelectingVersion: false,
  fetchingVersion: null,
  onFetchVersions: () => {},
  archivePlans: [],
  selectedArchiveFile: null,
  onArchiveSelect: () => {},
  isLoadingArchive: false,
};

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe('SidebarContainer compact presentation', () => {
  test('preserves the incumbent desktop rail geometry by default', () => {
    const html = renderToStaticMarkup(<SidebarContainer {...baseProps} />);

    expect(html).toContain('hidden lg:flex flex-col sticky top-12 h-[calc(100vh-3rem)]');
    expect(html).toContain('style="width:var(--toc-w, 240px)"');
    expect(html).not.toContain('data-pn-plan-navigator');
    expect(html).not.toContain('Close navigator');
  });

  test('renders a full visible-viewport stage with touch-safe navigation', () => {
    const html = renderToStaticMarkup(
      <SidebarContainer
        {...baseProps}
        presentation="overlay"
        showContentsTab={false}
        activeTab="archive"
        showArchiveTab
        pendingFileLabel="alpha.md"
      />,
    );

    expect(html).toContain('id="pn-compact-plan-navigator"');
    expect(html).toContain('data-pn-plan-navigator="true"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Opening alpha.md…');
    expect(html).toContain('pn-visible-viewport-stage');
    expect(html).toContain('aria-label="Close navigator"');
    expect(html).toContain('data-pn-touch-target="true"');
    expect(html).not.toContain('sticky top-12');
    expect(html).not.toContain('>Contents<');
    expect(html).toContain('>Archive<');

    const theme = readFileSync(resolve(import.meta.dir, '../../theme.css'), 'utf8');
    expect(theme).toContain('.pn-visible-viewport-stage');
    expect(theme).toContain('top: var(--pn-viewport-offset-top, 0px)');
    expect(theme).toContain('height: var(--pn-viewport-height, 100vh)');
    expect(theme).toContain('[data-pn-plan-navigator="true"] button');
    expect(theme).toContain('min-block-size: var(--pn-touch-target)');
  });

  test('keeps every contextual browser in the single shared navigator', () => {
    const html = renderToStaticMarkup(
      <SidebarContainer
        {...baseProps}
        presentation="overlay"
        showVersionsTab
        showMessagesTab
        messages={[]}
        showFilesTab
        showArchiveTab
      />,
    );

    for (const label of ['Contents', 'Versions', 'Messages', 'Files', 'Archive']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html.match(/data-pn-touch-target="true"/g)?.length).toBe(6);
  });

  test.skipIf(!hasDom)('moves focus inside and exposes explicit close/tab actions', async () => {
    const onClose = mock(() => {});
    const onTabChange = mock(() => {});
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <SidebarContainer
          {...baseProps}
          presentation="overlay"
          showFilesTab
          onClose={onClose}
          onTabChange={onTabChange}
        />,
      );
    });

    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close navigator"]');
    const files = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Files');

    expect(document.activeElement).toBe(close);
    await act(async () => files?.click());
    expect(onTabChange).toHaveBeenCalledWith('files');

    const reverseTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => close?.dispatchEvent(reverseTab));
    expect(reverseTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(files);

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => files?.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => close?.click());
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
