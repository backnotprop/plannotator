import { afterEach, describe, expect, test } from 'bun:test';
import {
  getTouchSelectionToolbar,
  placeTouchToolbar,
  resetTouchSelectionToolbar,
  setTouchSelectionToolbar,
  TOUCH_TOOLBAR_EDGE_MARGIN,
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

  test('flips above only when there is no room below, and stays on screen', () => {
    const anchor = word(100, 800);
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.placement).toBe('above');
    expect(pos.top + toolbar.height).toBeLessThanOrEqual(anchor.top);
    expect(pos.top).toBeGreaterThanOrEqual(TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('a selection taller than the screen pins the toolbar inside the bottom edge', () => {
    const anchor = { left: 20, right: 370, top: -200, bottom: 1200 };
    const pos = placeTouchToolbar({ anchor, toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.top + toolbar.height).toBe(phone.height - TOUCH_TOOLBAR_EDGE_MARGIN);
  });

  test('a selection scrolled above the screen keeps the toolbar inside the top edge', () => {
    const pos = placeTouchToolbar({ anchor: word(100, -120), toolbar, viewport: phone, mode: 'center-above' });
    expect(pos.top).toBe(TOUCH_TOOLBAR_EDGE_MARGIN);
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
