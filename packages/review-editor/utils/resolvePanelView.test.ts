import { describe, expect, test } from 'bun:test';
import { resolvePanelView } from './resolvePanelView';

describe('resolvePanelView', () => {
  test('a sections selection on a session without sections resolves to tree', () => {
    // The no-segment-highlighted bug: sections memo on a repo with no
    // resolvable base (sections gone, commits offered) must light Tree,
    // not a hidden Git status segment.
    expect(
      resolvePanelView('sections', { sectionsAvailable: false, commitsCapable: true }),
    ).toBe('tree');
    // Sections merely unavailable for the active diff (classic diff default):
    // the tree renders, so Tree must be the highlighted segment.
    expect(
      resolvePanelView('sections', { sectionsAvailable: false, commitsCapable: false }),
    ).toBe('tree');
  });

  test('sections selected and available resolves to sections', () => {
    expect(
      resolvePanelView('sections', { sectionsAvailable: true, commitsCapable: true }),
    ).toBe('sections');
  });

  test('commits resolves to commits only when the session offers it', () => {
    expect(
      resolvePanelView('commits', { sectionsAvailable: true, commitsCapable: true }),
    ).toBe('commits');
    expect(
      resolvePanelView('commits', { sectionsAvailable: true, commitsCapable: false }),
    ).toBe('tree');
  });
});
