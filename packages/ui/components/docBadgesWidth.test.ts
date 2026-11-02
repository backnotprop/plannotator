import { describe, expect, test } from 'bun:test';
import { legacyBadgesMaxWidth, type BoxEdges } from './docBadgesWidth';

const badges: BoxEdges = { left: 380, right: 600, top: 150, bottom: 166 };
const card: BoxEdges = { left: 360, right: 1200, top: 130, bottom: 900 };

describe('legacyBadgesMaxWidth', () => {
  test('stops the badges short of actions on the same row', () => {
    const actions: BoxEdges = { left: 850, right: 1170, top: 146, bottom: 182 };
    expect(legacyBadgesMaxWidth(badges, actions, card)).toBe(850 - 380 - 8);
  });

  test('keeps the badges inside the card when the actions sit on a row below them', () => {
    const actions: BoxEdges = { left: 200, right: 340, top: 190, bottom: 226 };
    expect(legacyBadgesMaxWidth(badges, actions, card)).toBe(1200 - 380 - 20);
  });

  test('keeps the badges inside the card until the actions have a measured width', () => {
    const unmeasured: BoxEdges = { left: 1170, right: 1170, top: 146, bottom: 146 };
    expect(legacyBadgesMaxWidth(badges, unmeasured, card)).toBe(1200 - 380 - 20);
    expect(legacyBadgesMaxWidth(badges, null, card)).toBe(1200 - 380 - 20);
  });

  test('a 390px phone: the badges stop inside the card, with the same inset on both sides', () => {
    // Measured on the phone layout: the card spans 8..382, the badges start at 21.
    const phoneCard: BoxEdges = { left: 8, right: 382, top: 120, bottom: 800 };
    const phoneBadges: BoxEdges = { left: 21, right: 438, top: 132, bottom: 150 };
    expect(legacyBadgesMaxWidth(phoneBadges, null, phoneCard)).toBe(382 - 21 - 13);
  });

  test('leaves the badges unbounded while the card has no width', () => {
    const hidden: BoxEdges = { left: 0, right: 0, top: 0, bottom: 0 };
    expect(legacyBadgesMaxWidth(badges, null, hidden)).toBeNull();
  });

  test('never returns a negative width when the actions overlap the badges', () => {
    const actions: BoxEdges = { left: 370, right: 500, top: 146, bottom: 182 };
    expect(legacyBadgesMaxWidth(badges, actions, card)).toBe(0);
  });
});
