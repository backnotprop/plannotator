/**
 * computeMenuPlacement's optional seams (a host's box and its preferred side), used by the
 * Inbox's compose dialog, where the picker opens at the caret and must stay above the dialog's
 * footer.
 */
import { describe, expect, test } from 'bun:test';
import { computeMenuPlacement } from './SkillReferenceMenu';

// GAP 6 + MARGIN 8 = 14 px between the anchor and the box edge, plus the 2 px border chrome.
const CHROME = 2;

describe('computeMenuPlacement with a boundary and a preferred side', () => {
  test('with no options it prefers above, against the viewport (unchanged)', () => {
    expect(computeMenuPlacement({ top: 400, bottom: 420 }, 200, CHROME, 900)).toEqual({ direction: 'above', maxListHeight: 256 });
    expect(computeMenuPlacement({ top: 100, bottom: 120 }, 200, CHROME, 900)).toEqual({ direction: 'below', maxListHeight: 256 });
  });

  test('prefer below opens below the caret line when the list fits above the footer', () => {
    // A dialog from 100 to 700 (the footer's top); the caret line at 300-324.
    const placed = computeMenuPlacement({ top: 300, bottom: 324 }, 480, CHROME, 700, { boundaryTop: 100, prefer: 'below' });
    expect(placed.direction).toBe('below');
    expect(placed.maxListHeight).toBe(256);
  });

  test('prefer below flips above when there is no room above the footer', () => {
    // The caret line near the footer: 620-644 with the footer at 700, the dialog top at 100.
    const placed = computeMenuPlacement({ top: 620, bottom: 644 }, 480, CHROME, 700, { boundaryTop: 100, prefer: 'below' });
    expect(placed.direction).toBe('above');
    expect(placed.maxListHeight).toBe(256);
  });

  test('when neither side fits, the roomier side wins and the list is clamped to the box, never past the footer', () => {
    const placed = computeMenuPlacement({ top: 260, bottom: 284 }, 480, CHROME, 520, { boundaryTop: 100, prefer: 'below' });
    expect(placed).toEqual({ direction: 'below', maxListHeight: 220 });
    expect(284 + 6 + CHROME + placed.maxListHeight).toBeLessThanOrEqual(520 - 8);
  });

  test('a host cap (a phone: 4½ rows of 44 px) limits the list', () => {
    expect(computeMenuPlacement({ top: 160, bottom: 186 }, 480, CHROME, 800, { prefer: 'above', boundaryTop: 52, maxListHeight: 198 })).toEqual({
      direction: 'below',
      maxListHeight: 198,
    });
  });
});
