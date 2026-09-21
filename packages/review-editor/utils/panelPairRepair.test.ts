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
    // Failure caught: a config.json write and a handleDiffSwitch('since-base')
    // triggered by a session defined by writing nothing.
    expect(shouldRepairPanelPair({ ...conflictedPair, openStatePinned: true })).toBe(false);
  });

  test('an unpinned conflicted pair still self-heals', () => {
    // Failure caught: over-broad guards silently disabling the repair for
    // everyone.
    expect(shouldRepairPanelPair(conflictedPair)).toBe(true);
  });

  test('a consistent pair or a sections-incapable session does not repair', () => {
    expect(shouldRepairPanelPair({ ...conflictedPair, defaultDiffType: 'since-base' })).toBe(false);
    expect(shouldRepairPanelPair({ ...conflictedPair, sectionsCapable: false })).toBe(false);
    expect(shouldRepairPanelPair({ ...conflictedPair, persistedPanelView: 'tree' })).toBe(false);
  });

  test('the Tree default never trips the repair', () => {
    // Failure caught: the repair firing for the new default profile — a
    // reviewer who never chose anything has no persisted view at all, and
    // `tree` is not the half of the pair that forces since-base.
    expect(shouldRepairPanelPair({ ...conflictedPair, persistedPanelView: undefined })).toBe(false);
  });
});
