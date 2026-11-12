import { describe, expect, test } from 'bun:test';
import { shouldRepairPanelPair } from './panelPairRepair';

describe('shouldRepairPanelPair', () => {
  const conflictedPair = {
    openStatePinned: false,
    sectionsCapable: true,
    persistedPanelView: 'sections',
    defaultDiffType: 'uncommitted',
  };

  test('a caller-pinned session never repairs (no settings write, no diff override)', () => {
    expect(shouldRepairPanelPair({ ...conflictedPair, openStatePinned: true })).toBe(false);
  });

  test('an unpinned conflicted pair still self-heals', () => {
    expect(shouldRepairPanelPair(conflictedPair)).toBe(true);
  });

  test('a consistent pair or a sections-incapable session does not repair', () => {
    expect(shouldRepairPanelPair({ ...conflictedPair, defaultDiffType: 'since-base' })).toBe(false);
    expect(shouldRepairPanelPair({ ...conflictedPair, sectionsCapable: false })).toBe(false);
    expect(shouldRepairPanelPair({ ...conflictedPair, persistedPanelView: 'tree' })).toBe(false);
  });

  test('the Tree default never trips the repair', () => {
    expect(shouldRepairPanelPair({ ...conflictedPair, persistedPanelView: undefined })).toBe(false);
  });
});
