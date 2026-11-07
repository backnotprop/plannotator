import { afterEach, describe, expect, test } from 'bun:test';
import {
  getTouchSelectionToolbar,
  placeTouchToolbar,
  resetTouchSelectionToolbar,
  setTouchSelectionToolbar,
  TOUCH_TOOLBAR_EDGE_MARGIN,
  TOUCH_TOOLBAR_BOTTOM_BAND,
  unionToolbarRect,
  type ToolbarRect,
} from './touchToolbarPlacement';
import { configurePlannotatorUI } from '../configure';

/**
 * The selection toolbar on a phone, docked: iOS Safari draws its own edit
 * menu beside a selection, above or below it, and the side cannot be
 * predicted. So the toolbar docks to the bottom edge of the visible screen,
 * never beside the selection, and to the top edge when the selection reaches
 * into the bottom of the screen. It never leaves the screen.
 */

const phone = { left: 0, top: 0, width: 390, height: 844 };
const narrow = { left: 0, top: 0, width: 320, height: 568 };
const toolbar = { width: 276, height: 54 };
const M = TOUCH_TOOLBAR_EDGE_MARGIN;

function word(left: number, top: number, width = 30, height = 22): ToolbarRect {
  return { left, right: left + width, top, bottom: top + height };
}

afterEach(() => resetTouchSelectionToolbar());

describe('placeTouchToolbar (docked)', () => {
  test('a selection anywhere above the bottom band docks the toolbar to the bottom edge, centered', () => {
    for (const anchor of [word(4, 120), word(180, 400), word(360, 600)]) {
      const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
      expect(pos.placement).toBe('dock-bottom');
      expect(pos.top + toolbar.height).toBe(phone.height - M);
      expect(pos.left).toBe((phone.width - toolbar.width) / 2);
    }
  });

  test('the docked toolbar is never beside the selection, whichever side iOS puts its menu on', () => {
    // iOS's menu: about 44px tall, about 8px above or below the selection.
    const anchor = word(150, 300);
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    const menuAbove = { top: anchor.top - 52, bottom: anchor.top - 8 };
    const menuBelow = { top: anchor.bottom + 8, bottom: anchor.bottom + 52 };
    for (const menu of [menuAbove, menuBelow]) {
      expect(pos.top >= menu.bottom || pos.top + toolbar.height <= menu.top).toBe(true);
    }
  });

  test('a selection reaching into the bottom band docks it to the top edge instead', () => {
    const anchor = word(150, phone.height - TOUCH_TOOLBAR_BOTTOM_BAND + 10);
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.placement).toBe('dock-top');
    expect(pos.top).toBe(M);
    // A multi-line selection whose LAST line reaches the band counts too.
    const tall = unionToolbarRect([word(150, 500), word(16, 760)])!;
    expect(placeTouchToolbar({ anchor: tall, toolbar, viewport: phone, mode: 'center-above' }).placement).toBe('dock-top');
  });

  test('follows the visible viewport: the keyboard shortens it, pinch zoom moves it', () => {
    const withKeyboard = { left: 0, top: 0, width: 390, height: 500 };
    const above = placeTouchToolbar({ anchor: word(100, 200), toolbar, viewport: withKeyboard, mode: 'center-above' });
    expect(above.top + toolbar.height).toBe(500 - M);
    const zoomed = { left: 100, top: 400, width: 195, height: 422 };
    const small = { width: 170, height: 54 };
    const pos = placeTouchToolbar({ anchor: word(150, 500), toolbar: small, viewport: zoomed, mode: 'center-above' });
    expect(pos.left).toBeGreaterThanOrEqual(100 + M);
    expect(pos.left + small.width).toBeLessThanOrEqual(295 - M);
    expect(pos.top + small.height).toBe(822 - M);
  });

  test('stays inside the safe area (notch, home indicator) with the margin', () => {
    const landscape = { left: 0, top: 0, width: 844, height: 390 };
    const insets = { left: 47, right: 47, bottom: 21, top: 0 };
    const pos = placeTouchToolbar({ anchor: word(60, 100), toolbar, viewport: landscape, mode: 'center-above', insets });
    expect(pos.top + toolbar.height).toBe(390 - 21 - M);
    expect(pos.maxWidth).toBe(844 - 2 * 47 - 2 * M);
    expect(pos.left).toBe(47 + M + (pos.maxWidth - toolbar.width) / 2);
  });

  test('a toolbar wider than a 320 screen starts at the left margin', () => {
    const wide = { width: 330, height: 54 };
    const pos = placeTouchToolbar({ anchor: word(100, 200), toolbar: wide, viewport: narrow, mode: 'center-above' });
    expect(pos.left).toBe(M);
  });

  test('a selection scrolled out of sight hides the toolbar', () => {
    expect(placeTouchToolbar({ anchor: word(100, -120), toolbar, viewport: phone, mode: 'center-above' }).placement).toBe('hidden');
    expect(placeTouchToolbar({ anchor: word(100, 900), toolbar, viewport: phone, mode: 'center-above' }).placement).toBe('hidden');
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
