import { describe, expect, test } from 'bun:test';
import { hidesDockHeader } from './loneTabHeader';
import { REVIEW_ALL_FILES_PANEL_ID, REVIEW_PR_OVERVIEW_PANEL_ID } from './reviewPanelTypes';

describe('the dock tab strip with one tab', () => {
  test('hides while All changes is the only tab', () => {
    expect(hidesDockHeader(1, [REVIEW_ALL_FILES_PANEL_ID])).toBe(true);
  });

  test('shows again as soon as a second tab or group opens', () => {
    expect(hidesDockHeader(1, [REVIEW_ALL_FILES_PANEL_ID, 'review-file:a.ts'])).toBe(false);
    expect(hidesDockHeader(2, [REVIEW_ALL_FILES_PANEL_ID])).toBe(false);
  });

  test('stays for a lone panel that is not a diff, whose tab names it', () => {
    expect(hidesDockHeader(1, [REVIEW_PR_OVERVIEW_PANEL_ID])).toBe(false);
  });
});
