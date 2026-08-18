import { describe, expect, test } from 'bun:test';
import {
  COMPACT_PLAN_ARTIFACT,
  openCompactPlanNavigator,
  shouldPresentDesktopPlanPanel,
  toggleCompactPlanNavigator,
} from './compactPlanSurface';

describe('compact Plan foreground state', () => {
  test('opens the requested navigator tab from the reading surface', () => {
    expect(openCompactPlanNavigator('files')).toEqual({ type: 'navigator', tab: 'files' });
    expect(toggleCompactPlanNavigator(COMPACT_PLAN_ARTIFACT, 'toc')).toEqual({
      type: 'navigator',
      tab: 'toc',
    });
  });

  test('keeps tab changes inside the navigator', () => {
    expect(toggleCompactPlanNavigator({ type: 'navigator', tab: 'toc' }, 'files')).toEqual({
      type: 'navigator',
      tab: 'files',
    });
  });

  test('returns to the artifact when the header toggles the active tab', () => {
    expect(toggleCompactPlanNavigator({ type: 'navigator', tab: 'versions' }, 'versions'))
      .toBe(COMPACT_PLAN_ARTIFACT);
  });

  test('keeps the remembered desktop panel out of compact arrival', () => {
    expect(shouldPresentDesktopPlanPanel(true, true)).toBe(false);
    expect(shouldPresentDesktopPlanPanel(false, true)).toBe(true);
    expect(shouldPresentDesktopPlanPanel(false, false)).toBe(false);
  });
});
