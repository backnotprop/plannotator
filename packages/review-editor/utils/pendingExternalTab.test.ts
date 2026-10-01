import { describe, expect, test } from 'bun:test';
import {
  closePendingTab,
  openPendingTab,
  settlePendingTab,
  type PendingTabWindow,
  type TabOpener,
} from './pendingExternalTab';

function fakeTab(): PendingTabWindow & { closeCalls: number } {
  const tab = {
    closed: false,
    opener: {} as unknown,
    location: { href: 'about:blank' },
    document: { title: '', body: { textContent: '' as string | null } },
    closeCalls: 0,
    close() {
      tab.closeCalls += 1;
      tab.closed = true;
    },
  };
  return tab;
}

function recordingOpener(result: () => PendingTabWindow | null) {
  const calls: Array<[string | undefined, string | undefined, string | undefined]> = [];
  const opener: TabOpener = {
    open(url, target, features) {
      calls.push([url, target, features]);
      return result();
    },
  };
  return { opener, calls };
}

describe('pending "View on platform" tab (#1583)', () => {
  test('the placeholder is opened at gesture time and cut off from this page', () => {
    const tab = fakeTab();
    const { opener, calls } = recordingOpener(() => tab);
    expect(openPendingTab(opener, 'Bitbucket')).toBe(tab);
    expect(calls).toEqual([['', '_blank', undefined]]);
    expect(tab.opener).toBeNull();
  });

  test('a blocked popup yields no placeholder instead of throwing', () => {
    expect(openPendingTab(recordingOpener(() => null).opener, 'GitHub')).toBeNull();
    const throwing: TabOpener = { open() { throw new Error('blocked'); } };
    expect(openPendingTab(throwing, 'GitHub')).toBeNull();
  });

  // The regression: opening after the async submit is what browsers block.
  // With a placeholder, success navigates it and never calls open() again.
  test('success navigates the placeholder rather than opening a new window', () => {
    const tab = fakeTab();
    const { opener, calls } = recordingOpener(() => null);
    settlePendingTab(tab, ['https://bitbucket.org/ws/repo/pull-requests/1'], opener);
    expect(tab.location.href).toBe('https://bitbucket.org/ws/repo/pull-requests/1');
    expect(calls).toEqual([]);
    expect(tab.closeCalls).toBe(0);
  });

  test('without a placeholder (popup refused, VS Code bridge) success falls back to open()', () => {
    const { opener, calls } = recordingOpener(() => null);
    settlePendingTab(null, ['https://github.com/o/r/pull/2', 'https://github.com/o/r/pull/3'], opener);
    expect(calls.map(([url]) => url)).toEqual(['https://github.com/o/r/pull/2', 'https://github.com/o/r/pull/3']);
  });

  test('a placeholder the user already closed is not navigated', () => {
    const tab = fakeTab();
    tab.closed = true;
    const { opener, calls } = recordingOpener(() => null);
    settlePendingTab(tab, ['https://gitlab.com/g/p/-/merge_requests/4'], opener);
    expect(tab.location.href).toBe('about:blank');
    expect(calls.map(([url]) => url)).toEqual(['https://gitlab.com/g/p/-/merge_requests/4']);
  });

  test('no URL to show, or a failed submission, closes the placeholder', () => {
    const empty = fakeTab();
    settlePendingTab(empty, [], recordingOpener(() => null).opener);
    expect(empty.closeCalls).toBe(1);

    const failed = fakeTab();
    closePendingTab(failed);
    closePendingTab(failed);
    expect(failed.closeCalls).toBe(1);
    closePendingTab(null);
  });
});
