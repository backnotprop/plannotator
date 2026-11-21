/**
 * The comment card's place with `keepAbove` (a live html block in a message:
 * the block's caption and its pen sit right under the frame). What would
 * regress: the card covering the caption and the pen, the card covering the
 * element it is about when there is room beside it, or the card leaving the
 * thread's pane.
 */
import { describe, expect, test } from 'bun:test';
import { COMMENT_CARD_WIDTH, computeCommentCardGeometry } from './CommentPopover';

const VIEW = 900;
const bounds = { top: 16, left: 16, right: 1424, bottom: 884, width: 1408, height: 868 };
/** The thread's pane, and a block's frame in it: the caption starts at the frame's foot. */
const pane = { left: 628, right: 1432, bottom: 892, width: 804 };
const frame = { left: 692, right: 1396, top: 180, bottom: 480 };
const place = (anchor: { left: number; top: number; width: number; height: number }, over: Partial<Parameters<typeof computeCommentCardGeometry>[2]> = {}) => {
  const geo = computeCommentCardGeometry(
    { left: anchor.left, right: anchor.left + anchor.width, top: anchor.top, bottom: anchor.top + anchor.height, width: anchor.width },
    bounds,
    { phone: false, expanded: false, pane, viewportHeight: VIEW, placement: 'side', floor: frame.bottom, ...over },
  );
  const style = geo.style as { left: number; width: number; top?: number; bottom?: number; maxHeight: number };
  // Where the card can reach: from its top (or as far up as it may grow) to its bottom edge.
  const bottom = style.bottom !== undefined ? VIEW - style.bottom : style.top! + style.maxHeight;
  const top = style.top ?? bottom - style.maxHeight;
  return { geo, left: style.left, right: style.left + style.width, top, bottom, held: style.bottom !== undefined ? 'bottom' : 'top' };
};
const bar = { width: 22, height: 60 };
const corners = {
  topLeft: { left: frame.left + 4, top: frame.top + 4, ...bar },
  topRight: { left: frame.right - 26, top: frame.top + 4, ...bar },
  bottomLeft: { left: frame.left + 4, top: frame.bottom - 64, ...bar },
  bottomRight: { left: frame.right - 26, top: frame.bottom - 64, ...bar },
  middle: { left: 1030, top: 300, ...bar },
};

describe('comment card with keepAbove', () => {
  test('at each corner of the frame and in its middle: beside the element, inside the pane, never past the foot', () => {
    for (const [name, anchor] of Object.entries(corners)) {
      const card = place(anchor);
      expect(card.geo.docked).toBe(false);
      expect(card.bottom).toBeLessThanOrEqual(frame.bottom);
      expect(card.left).toBeGreaterThanOrEqual(pane.left);
      expect(card.right).toBeLessThanOrEqual(pane.right);
      // Beside it: the card and the element share no column.
      const beside = card.left >= anchor.left + anchor.width || card.right <= anchor.left;
      expect([name, beside]).toEqual([name, true]);
    }
  });

  test('an element low in the frame opens the card upward, held by its bottom edge at the foot; one high in it opens downward from its top', () => {
    const low = place(corners.bottomLeft);
    expect(low.held).toBe('bottom');
    expect(low.geo.above).toBe(true);
    expect(low.bottom).toBe(frame.bottom - 6);
    const high = place(corners.topLeft);
    expect(high.held).toBe('top');
    expect(high.top).toBe(corners.topLeft.top);
  });

  test('right of the element when it fits in the pane, else left', () => {
    expect(place(corners.middle).left).toBeGreaterThan(corners.middle.left);
    expect(place(corners.topRight).right).toBeLessThan(corners.topRight.left);
  });

  test('an element as wide as the frame: over it, else under it while that ends above the foot, else on it above the foot', () => {
    const wide = { left: frame.left, width: frame.right - frame.left, height: 40 };
    const over = place({ ...wide, top: 320 });
    expect(over.bottom).toBeLessThanOrEqual(320);
    const under = place({ ...wide, top: 60 });
    expect(under.top).toBeGreaterThanOrEqual(100);
    expect(under.bottom).toBeLessThanOrEqual(frame.bottom);
    const on = place({ ...wide, top: 60, height: 400 });
    expect(on.bottom).toBe(frame.bottom - 6);
    for (const card of [over, under, on]) expect(card.right - card.left).toBe(COMMENT_CARD_WIDTH);
  });

  test('a phone docks the card at the foot of the screen, as without keepAbove', () => {
    const phone = place(corners.middle, { phone: true });
    expect(phone.geo.docked).toBe(true);
    expect(phone.geo).toEqual(computeCommentCardGeometry({ left: 1030, right: 1052, top: 300, bottom: 360, width: 22 }, bounds, { phone: true, expanded: false, pane, viewportHeight: VIEW, placement: 'side' }));
  });

  test('without keepAbove the side placement is as before', () => {
    const before = computeCommentCardGeometry({ left: 1030, right: 1052, top: 440, bottom: 500, width: 22 }, bounds, { phone: false, expanded: false, pane, viewportHeight: VIEW, placement: 'side' });
    expect(before.style).toEqual({ left: 1066, width: COMMENT_CARD_WIDTH, top: 440, maxHeight: 444 });
  });
});
