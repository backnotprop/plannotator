import { afterEach, describe, expect, test } from 'bun:test';
import {
  getTouchSelectionToolbar,
  placeTouchToolbar,
  resetTouchSelectionToolbar,
  setTouchSelectionToolbar,
  TOUCH_TOOLBAR_EDGE_MARGIN,
  IOS_MENU_CLEARANCE,
  unionToolbarRect,
  type ToolbarRect,
} from './touchToolbarPlacement';
import { configurePlannotatorUI } from '../configure';

/**
 * The selection toolbar on a phone: iOS Safari draws its own edit menu above a
 * text selection, so the toolbar must go below it, and it must never run off
 * the screen's edge (it did, half off the left edge, with a selection near it).
 */

const phone = { left: 0, top: 0, width: 390, height: 844 };
const narrow = { left: 0, top: 0, width: 320, height: 568 };
const toolbar = { width: 210, height: 54 };

function word(left: number, top: number, width = 30, height = 22): ToolbarRect {
  return { left, right: left + width, top, bottom: top + height };
}

function insideHorizontally(left: number, width: number, viewport: { left: number; width: number }) {
  expect(left).toBeGreaterThanOrEqual(viewport.left + TOUCH_TOOLBAR_EDGE_MARGIN);
  expect(left + width).toBeLessThanOrEqual(viewport.left + viewport.width - TOUCH_TOOLBAR_EDGE_MARGIN);
}

afterEach(() => resetTouchSelectionToolbar());

describe('placeTouchToolbar', () => {
  test('a selection near the left edge keeps the toolbar inside, with the margin', () => {
    const pos = placeTouchToolbar({ anchor: word(4, 300), toolbar, viewport: phone, mode: 'center-above' });
    insideHorizontally(pos.left, toolbar.width, phone);
    expect(pos.left).toBe(TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('a selection near the right edge keeps the toolbar inside, with the margin', () => {
    const pos = placeTouchToolbar({ anchor: word(360, 300), toolbar, viewport: phone, mode: 'center-above' });
    insideHorizontally(pos.left, toolbar.width, phone);
    expect(pos.left + toolbar.width).toBe(phone.width - TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('a selection in the middle centers the toolbar under it', () => {
    const anchor = word(150, 300, 90);
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.left + toolbar.width / 2).toBe((anchor.left + anchor.right) / 2);
  });

  test('a 320 px screen with a wide toolbar still keeps both edges on screen', () => {
    const wide = { width: 300, height: 54 };
    for (const anchor of [word(2, 200), word(160, 200), word(300, 200)]) {
      const pos = placeTouchToolbar({ anchor, toolbar: wide, viewport: narrow, mode: 'center-above' });
      insideHorizontally(pos.left, wide.width, narrow);
    }
  });

  test('goes below the selection, clear of it, where iOS does not put its menu', () => {
    const anchor = word(100, 300);
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.placement).toBe('below');
    expect(pos.top).toBeGreaterThan(anchor.bottom);
  });

  test('flips above only when there is no room below, over the band where iOS draws its menu', () => {
    const anchor = word(100, 800);
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.placement).toBe('above');
    // iOS's menu sits about 8px above the selection and is about 44px tall: the toolbar clears it.
    expect(anchor.top - (pos.top + toolbar.height)).toBeGreaterThanOrEqual(52);
    expect(pos.top).toBeGreaterThanOrEqual(TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('near the bottom of a short screen without room for both, it goes right above the selection', () => {
    const short = { left: 0, top: 0, width: 390, height: 140 };
    const anchor = word(100, 80);
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: short, mode: 'center-above' });
    expect(pos.placement).toBe('above');
    expect(pos.top + toolbar.height).toBeLessThanOrEqual(anchor.top);
    expect(pos.top).toBeGreaterThanOrEqual(TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('with room neither below nor above, it is pinned inside the bottom edge', () => {
    const short = { left: 0, top: 0, width: 390, height: 100 };
    const anchor = { left: 100, right: 200, top: 20, bottom: 70 };
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: short, mode: 'center-above' });
    expect(pos.placement).toBe('pinned');
    expect(pos.top + toolbar.height).toBe(short.height - TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('a selection taller than the screen pins the toolbar inside the bottom edge', () => {
    const anchor = { left: 20, right: 370, top: -200, bottom: 1200 };
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.top + toolbar.height).toBe(phone.height - TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('a selection scrolled out of sight hides the toolbar instead of sticking it to an edge', () => {
    expect(placeTouchToolbar({ anchor: word(100, -120), toolbar, viewport: phone, mode: 'center-above' }).placement).toBe('hidden');
    expect(placeTouchToolbar({ anchor: word(100, 900), toolbar, viewport: phone, mode: 'center-above' }).placement).toBe('hidden');
    const block = { left: 16, right: 374, top: -400, bottom: -10 };
    expect(placeTouchToolbar({ anchor: block, toolbar, viewport: phone, mode: 'top-right' }).placement).toBe('hidden');
  });

  test('a selection running above the top edge still gets the toolbar under its visible end', () => {
    const anchor = { left: 20, right: 300, top: -120, bottom: 40 };
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.placement).toBe('below');
    expect(pos.top).toBeGreaterThan(anchor.bottom);
  });

  test('a two-piece selection puts the toolbar below its last piece, not its first', () => {
    // From the end of one line to the start of the next: the first piece is on top.
    const first = word(300, 300, 70);
    const last = word(16, 330, 60);
    const anchor = unionToolbarRect([first, last])!;
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.top).toBeGreaterThanOrEqual(last.bottom + 28);
  });

  test('the gap below clears the end selection handle', () => {
    const anchor = word(100, 300);
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.top - anchor.bottom).toBeGreaterThanOrEqual(28);
  });

  test('a selection near the top leaves room for iOS\'s menu, which then goes below it', () => {
    const nearTop = word(100, 20);
    const pos = placeTouchToolbar({ anchor: nearTop, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.placement).toBe('below');
    expect(pos.top - nearTop.bottom).toBeGreaterThanOrEqual(28 + IOS_MENU_CLEARANCE);
    // Further down there is room above for iOS's menu: the plain gap.
    const lower = word(100, 200);
    const plain = placeTouchToolbar({ anchor: lower, toolbar, viewport: phone, mode: 'center-above' });
    expect(plain.top - lower.bottom).toBeLessThan(28 + IOS_MENU_CLEARANCE);
  });

  test('near the top of a short screen without room for both, the toolbar still goes below', () => {
    const short = { left: 0, top: 0, width: 390, height: 150 };
    const anchor = word(100, 20);
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: short, mode: 'center-above' });
    expect(pos.placement).toBe('below');
    expect(pos.top + toolbar.height).toBeLessThanOrEqual(short.height - TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('keeps clear of the notch and the home indicator (safe-area insets)', () => {
    const landscape = { left: 0, top: 0, width: 844, height: 390 };
    const insets = { left: 47, right: 47, bottom: 21, top: 0 };
    const atLeft = placeTouchToolbar({ anchor: word(50, 150), toolbar, viewport: landscape, mode: 'center-above', insets });
    expect(atLeft.left).toBe(47 + TOUCH_TOOLBAR_EDGE_MARGIN);
    const atRight = placeTouchToolbar({ anchor: word(780, 150), toolbar, viewport: landscape, mode: 'center-above', insets });
    expect(atRight.left + toolbar.width).toBe(844 - 47 - TOUCH_TOOLBAR_EDGE_MARGIN);
    const tall = { left: 100, right: 700, top: -100, bottom: 1000 };
    const pinned = placeTouchToolbar({ anchor: tall, toolbar, viewport: landscape, mode: 'center-above', insets });
    expect(pinned.top + toolbar.height).toBe(390 - 21 - TOUCH_TOOLBAR_EDGE_MARGIN);
    expect(atLeft.maxWidth).toBe(844 - 2 * 47 - 2 * TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('follows the visible viewport when the page is zoomed or panned', () => {
    const zoomed = { left: 100, top: 400, width: 195, height: 422 };
    const wide = { width: 170, height: 54 };
    const pos = placeTouchToolbar({ anchor: word(102, 500), toolbar: wide, viewport: zoomed, mode: 'center-above' });
    insideHorizontally(pos.left, wide.width, zoomed);
    expect(pos.top).toBeGreaterThanOrEqual(zoomed.top + TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('a hovered block (top-right) keeps its place over the block, inside the screen', () => {
    const block = { left: 16, right: 374, top: 300, bottom: 420 };
    const pos = placeTouchToolbar({ anchor: block, toolbar, viewport: phone, mode: 'top-right' });
    expect(pos.top + toolbar.height).toBeLessThanOrEqual(block.top);
    expect(pos.left + toolbar.width).toBe(block.right);
  });
});

describe('unionToolbarRect', () => {
  test('spans every piece and skips empty ones', () => {
    const empty = { left: 50, right: 50, top: 900, bottom: 900 };
    expect(unionToolbarRect([word(300, 300, 70), empty, word(16, 330, 60)])).toEqual({ left: 16, right: 370, top: 300, bottom: 352 });
    expect(unionToolbarRect([])).toBeNull();
  });
});

describe('touchSelectionToolbar seam', () => {
  test('is off unless a host opts in, and configurePlannotatorUI turns it on and off', () => {
    expect(getTouchSelectionToolbar()).toBe(false);
    configurePlannotatorUI({ touchSelectionToolbar: true });
    expect(getTouchSelectionToolbar()).toBe(true);
    configurePlannotatorUI({ touchSelectionToolbar: false });
    expect(getTouchSelectionToolbar()).toBe(false);
    setTouchSelectionToolbar(true);
    resetTouchSelectionToolbar();
    expect(getTouchSelectionToolbar()).toBe(false);
  });
});
