/**
 * Where a file's tab lands and what shows when one closes (files/tabs.ts,
 * approval "inbox-files-tabs"). What this catches: a file opened on purpose
 * landing at the end instead of right of the tab on screen, a second tab for
 * a file already open, `]`/`[` adding tabs instead of stepping inside one,
 * and closing the tab on screen showing the wrong neighbour (or a file when
 * none is left, instead of the Artifacts tab).
 */
import { expect, test } from 'bun:test';
import { closeOtherTabs, closeTab, keepKnownTabs, openTab, stepTab, threadTabs } from './tabs';

test('a file opened on purpose gets a tab right of the one on screen; an open one keeps its own tab', () => {
  expect(openTab([], 'a', null)).toEqual(['a']);
  expect(openTab(['a', 'b', 'c'], 'x', 'a')).toEqual(['a', 'x', 'b', 'c']);
  // From the Artifacts tab (nothing on screen): at the end.
  expect(openTab(['a', 'b'], 'x', null)).toEqual(['a', 'b', 'x']);
  const tabs = ['a', 'b'];
  expect(openTab(tabs, 'b', 'a')).toBe(tabs);
});

test('] and [ step inside the tab on screen; a file with its own tab is not doubled', () => {
  expect(stepTab(['a', 'b', 'c'], 'b', 'x')).toEqual(['a', 'x', 'c']);
  const tabs = ['a', 'b', 'c'];
  expect(stepTab(tabs, 'b', 'c')).toBe(tabs);
  expect(stepTab(['a'], null, 'x')).toEqual(['a', 'x']);
});

test('closing the tab on screen shows its right neighbour, else its left, else the Artifacts tab', () => {
  expect(closeTab(['a', 'b', 'c'], 'b', 'b')).toEqual({ tabs: ['a', 'c'], current: 'c' });
  expect(closeTab(['a', 'b', 'c'], 'c', 'c')).toEqual({ tabs: ['a', 'b'], current: 'b' });
  expect(closeTab(['a'], 'a', 'a')).toEqual({ tabs: [], current: null });
  // Another tab closes: what is on screen stays.
  expect(closeTab(['a', 'b', 'c'], 'a', 'c')).toEqual({ tabs: ['b', 'c'], current: 'c' });
  expect(closeOtherTabs(['a', 'b', 'c'], 'b')).toEqual(['b']);
  expect(closeOtherTabs(['a', 'b'], null)).toEqual([]);
});

test('tabs of a file the thread no longer has go; the others keep their order', () => {
  const tabs = ['a', 'pf:src/x.ts', 'gone'];
  expect(keepKnownTabs(tabs, (id) => id !== 'gone')).toEqual(['a', 'pf:src/x.ts']);
  expect(keepKnownTabs(tabs, () => true)).toBe(tabs);
});

test('each thread keeps its own tabs for the window', () => {
  threadTabs.clear();
  threadTabs.set('thr_1', ['a', 'b']);
  threadTabs.set('thr_2', ['c']);
  expect(threadTabs.get('thr_1')).toEqual(['a', 'b']);
  threadTabs.set('thr_1', []);
  expect(threadTabs.get('thr_1')).toEqual([]);
  expect(threadTabs.get('thr_2')).toEqual(['c']);
  threadTabs.clear();
});
