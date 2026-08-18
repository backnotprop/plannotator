import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import {
  editModeAnnouncementCanShow,
  enableEditSuggestionsFromAnnouncement,
  markEditModeAnnouncementSeen,
  needsEditModeAnnouncement,
  type EditModeAnnouncementGateState,
} from './editModeAnnouncement';

const SEEN_KEY = 'plannotator-edit-mode-announcement-seen';
const SETTING_KEY = 'plannotator-experimental-edit-suggestions';
let stored: Map<string, string>;

describe('Edit Mode announcement persistence', () => {
  beforeEach(() => {
    stored = new Map();
    setStorageBackend({
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
      },
      removeItem: key => {
        stored.delete(key);
      },
    });
  });

  afterEach(() => {
    resetStorageBackend();
  });

  test('is needed until the current announcement is marked seen', () => {
    expect(needsEditModeAnnouncement()).toBe(true);

    markEditModeAnnouncementSeen();

    expect(stored.get(SEEN_KEY)).toBe('3');
    expect(needsEditModeAnnouncement()).toBe(false);
  });

  test('shows again when a stored announcement version is stale', () => {
    stored.set(SEEN_KEY, '0');
    expect(needsEditModeAnnouncement()).toBe(true);
  });

  test('enable action persists the real editSuggestions setting and marks seen', () => {
    enableEditSuggestionsFromAnnouncement();

    expect(stored.get(SETTING_KEY)).toBe('true');
    expect(stored.get(SEEN_KEY)).toBe('3');
    expect(needsEditModeAnnouncement()).toBe(false);
  });
});

describe('editModeAnnouncementCanShow (never-stack chain gate)', () => {
  const openState: EditModeAnnouncementGateState = {
    announcementPending: true,
    isLoading: false,
    guideIntroVisible: false,
    lookAndFeelVisible: false,
    reviewSetupVisible: false,
  };

  test('shows when pending and no other chain dialog is open', () => {
    expect(editModeAnnouncementCanShow(openState)).toBe(true);
  });

  test('never shows once the announcement is no longer pending', () => {
    expect(editModeAnnouncementCanShow({ ...openState, announcementPending: false })).toBe(false);
  });

  test('never renders while the initial diff is still loading', () => {
    expect(editModeAnnouncementCanShow({ ...openState, isLoading: true })).toBe(false);
  });

  test('never renders while another chain dialog is open', () => {
    expect(editModeAnnouncementCanShow({ ...openState, guideIntroVisible: true })).toBe(false);
    expect(editModeAnnouncementCanShow({ ...openState, lookAndFeelVisible: true })).toBe(false);
    expect(editModeAnnouncementCanShow({ ...openState, reviewSetupVisible: true })).toBe(false);
  });

  test('shows for an existing user who has already seen every other chain dialog', () => {
    // Existing users have consumed the guide-intro, look-and-feel, and
    // review-setup cookies, so all earlier visibilities are false on load and
    // the announcement stands alone.
    expect(
      editModeAnnouncementCanShow({
        announcementPending: true,
        isLoading: false,
        guideIntroVisible: false,
        lookAndFeelVisible: false,
        reviewSetupVisible: false,
      }),
    ).toBe(true);
  });
});
