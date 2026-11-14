import { describe, expect, test } from 'bun:test';
import { EMPTY_LAYOUT, activeTabId, addTab, closeTab, collapseToOnePane, referencesPlacement, type PaneTab } from './paneLayout';
import { browseView, paneFileView } from './paneFileView';
import { removedOldLines } from '../utils/wholeFileMarks';

const tab = (id: string): PaneTab => ({ id, component: 'c', title: id, params: {} });

describe('two panes at most', () => {
  test('opening to the side makes a second pane; a third request goes to the other pane, never a third one', () => {
    let layout = addTab(EMPTY_LAYOUT, tab('all'), { kind: 'active' });
    layout = addTab(layout, tab('a.ts'), { kind: 'beside', referenceId: 'all' });
    expect(layout.panes.map((pane) => pane.tabs.map((t) => t.id))).toEqual([['all'], ['a.ts']]);
    layout = addTab(layout, tab('b.ts'), { kind: 'beside', referenceId: 'a.ts' });
    expect(layout.panes.length).toBe(2);
    expect(layout.panes[0]!.tabs.map((t) => t.id)).toEqual(['all', 'b.ts']);
    expect(activeTabId(layout)).toBe('b.ts');
  });

  test('a phone keeps one pane: to the side opens in the same pane, and two panes fold into one', () => {
    let layout = addTab(EMPTY_LAYOUT, tab('all'), { kind: 'active' });
    expect(addTab(layout, tab('a.ts'), { kind: 'beside' }, true).panes.length).toBe(1);
    layout = addTab(layout, tab('a.ts'), { kind: 'beside' });
    expect(collapseToOnePane(layout).panes[0]!.tabs.map((t) => t.id)).toEqual(['all', 'a.ts']);
  });

  test('closing the last tab of the side pane removes the pane; closing the active tab activates its neighbour', () => {
    let layout = addTab(EMPTY_LAYOUT, tab('all'), { kind: 'active' });
    layout = addTab(layout, tab('one'), { kind: 'active' });
    layout = addTab(layout, tab('side'), { kind: 'beside', referenceId: 'all' });
    layout = closeTab(layout, 'side');
    expect(layout.panes.length).toBe(1);
    layout = closeTab(layout, 'one');
    expect(activeTabId(layout)).toBe('all');
  });
});

describe('where References opens', () => {
  test('beside the code in a wide window, in the right panel in a narrow one or on a phone', () => {
    expect(referencesPlacement(1280, false)).toBe('pane');
    expect(referencesPlacement(1099, false)).toBe('panel');
    expect(referencesPlacement(1600, true)).toBe('panel');
  });
});

describe('a file tab remembers its own view', () => {
  test('the view holds for the file it was chosen on and resets for the next file in the same tab', () => {
    expect(paneFileView({ view: 'original', viewPath: 'a.ts' }, 'a.ts')).toBe('original');
    expect(paneFileView({ view: 'original', viewPath: 'a.ts' }, 'b.ts')).toBe('changes');
  });

  test('the original side marks the lines the diff removed, by their old line numbers', () => {
    const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -10,4 +10,3 @@\n ctx\n-gone\n-also\n+new\n ctx\n';
    expect(removedOldLines(patch)).toEqual([11, 12]);
  });
});

describe('browsing All files', () => {
  test('a changed file met while browsing opens whole, with its change bars; any other file stays plain', () => {
    expect(paneFileView(browseView('a.ts', true), 'a.ts')).toBe('whole');
    expect(paneFileView(browseView('b.ts', false), 'b.ts')).toBe('changes');
  });
});
