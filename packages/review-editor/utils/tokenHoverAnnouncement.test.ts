import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { configStore } from '@plannotator/ui/config';
import {
  markTokenHoverAnnouncementSeen,
  needsTokenHoverAnnouncement,
  resolveTokenHoverAnnouncementPending,
  tokenHoverAnnouncementCanShow,
  type TokenHoverAnnouncementGateState,
} from './tokenHoverAnnouncement';

const SEEN_KEY = 'plannotator-token-hover-announcement-seen';
const TRIGGER_KEY = 'plannotator-token-hover-trigger';
const LEGACY_KEY = 'plannotator-token-hover-cards';
let stored: Map<string, string>;

function installBackend(seed: Record<string, string> = {}): void {
  stored = new Map(Object.entries(seed));
  setStorageBackend({
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: key => { stored.delete(key); },
  });
  // The store is a process-global singleton that may already be resolved from
  // another suite's backend; re-hydrate so the trigger it reports is this
  // test's, not a leftover.
  configStore.loadFromBackend();
}

describe('token hover announcement persistence', () => {
  beforeEach(() => { installBackend(); });
  afterEach(() => { resetStorageBackend(); });

  test('is needed until the current announcement is marked seen', () => {
    expect(needsTokenHoverAnnouncement()).toBe(true);

    markTokenHoverAnnouncementSeen();

    expect(needsTokenHoverAnnouncement()).toBe(false);
  });

  test('shows again when a stored announcement version is stale', () => {
    stored.set(SEEN_KEY, '0');
    expect(needsTokenHoverAnnouncement()).toBe(true);
  });

  test('pends for a reviewer who has never chosen a trigger', () => {
    expect(resolveTokenHoverAnnouncementPending()).toBe(true);
    // Latching must not consume the cookie: the dialog has not been shown yet.
    expect(needsTokenHoverAnnouncement()).toBe(true);
  });

  test('never shows to someone who already chose a trigger, and stops asking', () => {
    installBackend({ [TRIGGER_KEY]: 'modifier' });

    expect(resolveTokenHoverAnnouncementPending()).toBe(false);
    expect(needsTokenHoverAnnouncement()).toBe(false);
  });

  test('never shows to the early adopter who turned cards off with the old boolean', () => {
    // The migration resolves that legacy false to `off`, which reads as a
    // choice already made — announcing a feature they declined is the worst
    // version of this dialog.
    installBackend({ [LEGACY_KEY]: 'false' });

    expect(resolveTokenHoverAnnouncementPending()).toBe(false);
  });
});

describe('tokenHoverAnnouncementCanShow (never-stack chain gate)', () => {
  const openState: TokenHoverAnnouncementGateState = {
    announcementPending: true,
    isLoading: false,
    featureAvailable: true,
    guideIntroVisible: false,
    lookAndFeelVisible: false,
    reviewSetupVisible: false,
    editModeVisible: false,
  };

  test('shows when pending and no other chain dialog is open', () => {
    expect(tokenHoverAnnouncementCanShow(openState)).toBe(true);
  });

  test('never shows once the announcement is no longer pending', () => {
    expect(tokenHoverAnnouncementCanShow({ ...openState, announcementPending: false })).toBe(false);
  });

  test('never renders while the initial diff is still loading', () => {
    expect(tokenHoverAnnouncementCanShow({ ...openState, isLoading: true })).toBe(false);
  });

  test('never renders in a session where hover cards cannot run at all', () => {
    expect(tokenHoverAnnouncementCanShow({ ...openState, featureAvailable: false })).toBe(false);
  });

  test('never renders while any earlier chain dialog is open', () => {
    expect(tokenHoverAnnouncementCanShow({ ...openState, guideIntroVisible: true })).toBe(false);
    expect(tokenHoverAnnouncementCanShow({ ...openState, lookAndFeelVisible: true })).toBe(false);
    expect(tokenHoverAnnouncementCanShow({ ...openState, reviewSetupVisible: true })).toBe(false);
    expect(tokenHoverAnnouncementCanShow({ ...openState, editModeVisible: true })).toBe(false);
  });
});
