import { describe, expect, test } from 'bun:test';
import { BACK_LABEL_FLOOR, PHONE_HEAD_FITS, phoneHeadFits, subjectHasRoom, SUBJECT_FLOOR } from './headFit';

describe("a phone's thread header", () => {
  test('"Inbox" fits only whole: one pixel short of its words is "I…" on an iPhone', () => {
    expect(phoneHeadFits({ overflow: 0, label: { shown: 42, whole: 42 } })).toBe(true);
    expect(phoneHeadFits({ overflow: 0, label: { shown: 33, whole: 42 } })).toBe(false);
    expect(phoneHeadFits({ overflow: 0, label: { shown: 18, whole: 42 } })).toBe(false);
  });

  test("a long project name may end in … once it shows its floor, and not before", () => {
    expect(phoneHeadFits({ overflow: 0, label: { shown: BACK_LABEL_FLOOR, whole: 228 } })).toBe(true);
    expect(phoneHeadFits({ overflow: 0, label: { shown: 120, whole: 228 } })).toBe(true);
    expect(phoneHeadFits({ overflow: 0, label: { shown: BACK_LABEL_FLOOR - 4, whole: 228 } })).toBe(false);
  });

  test('a control past the edge never fits, whatever the label shows', () => {
    expect(phoneHeadFits({ overflow: 6, label: { shown: 42, whole: 42 } })).toBe(false);
    expect(phoneHeadFits({ overflow: 6, label: null })).toBe(false);
    // The chevron alone fits once nothing is past the edge.
    expect(phoneHeadFits({ overflow: 0, label: null })).toBe(true);
  });

  test("Mark read's words go before the way back's label, and the count before Mark read's words", () => {
    const first = (step: string) => PHONE_HEAD_FITS.findIndex((fit) => fit.includes(step as never));
    expect(first('count')).toBeLessThan(first('mark'));
    expect(first('mark')).toBeLessThan(first('back'));
    // The way back keeps its label in every way but the last.
    expect(PHONE_HEAD_FITS.filter((fit) => fit.includes('back'))).toHaveLength(1);
    expect(PHONE_HEAD_FITS.at(-1)).toContain('back');
  });

  test('the scrolled-away subject is drawn only with room to read it', () => {
    expect(subjectHasRoom(8)).toBe(false);
    expect(subjectHasRoom(54)).toBe(false);
    expect(subjectHasRoom(SUBJECT_FLOOR)).toBe(true);
    expect(subjectHasRoom(200)).toBe(true);
  });
});
