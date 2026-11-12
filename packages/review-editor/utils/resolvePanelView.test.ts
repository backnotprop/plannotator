import { describe, expect, test } from 'bun:test';
import { resolvePanelView } from './resolvePanelView';

describe('resolvePanelView', () => {
  test('a sections selection on a session without sections resolves to tree', () => {
    expect(
      resolvePanelView('sections', { sectionsAvailable: false, commitsCapable: true }),
    ).toBe('tree');
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
