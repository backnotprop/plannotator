import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { configStore } from '@plannotator/ui/config';
import {
  markTokenHoverAnnouncementSeen,
  needsTokenHoverAnnouncement,
  resolveTokenHoverAnnouncementPending,
  shouldConsumeTokenHoverAnnouncement,
  tokenHoverAnnouncementCanShow,
  type TokenHoverAnnouncementGateState,
} from './tokenHoverAnnouncement';

const SEEN_KEY = 'plannotator-token-hover-announcement-seen';
const TRIGGER_KEY = 'plannotator-token-hover-trigger';
const LEGACY_KEY = 'plannotator-token-hover-cards';
let stored: Map<string, string>;

function installBackend(seed: Record<string, string> = {}): void {
  const speaksForTrigger = TRIGGER_KEY in seed || LEGACY_KEY in seed;
  stored = new Map(Object.entries(speaksForTrigger ? seed : { [TRIGGER_KEY]: 'hover', ...seed }));
  setStorageBackend({
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: key => { stored.delete(key); },
  });
  configStore.loadFromBackend();
}

describe('token hover announcement persistence', () => {
  beforeEach(() => { installBackend(); });
  afterEach(() => {
    resetStorageBackend();
    configStore.loadFromBackend();
  });

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
    expect(needsTokenHoverAnnouncement()).toBe(true);
  });

  test('never shows to someone who already chose a trigger', () => {
    installBackend({ [TRIGGER_KEY]: 'modifier' });

    expect(resolveTokenHoverAnnouncementPending()).toBe(false);
    expect(needsTokenHoverAnnouncement()).toBe(true);

    expect(shouldConsumeTokenHoverAnnouncement()).toBe(true);
    markTokenHoverAnnouncementSeen();
    expect(shouldConsumeTokenHoverAnnouncement()).toBe(false);
  });

  test('never shows to the early adopter who turned cards off with the old boolean', () => {
    installBackend({ [LEGACY_KEY]: 'false' });

    expect(resolveTokenHoverAnnouncementPending()).toBe(false);
    expect(shouldConsumeTokenHoverAnnouncement()).toBe(true);
  });

  test('a reviewer who has not chosen is never retired behind their back', () => {
    expect(shouldConsumeTokenHoverAnnouncement()).toBe(false);
  });
});

describe('tokenHoverAnnouncementCanShow (never-stack chain gate)', () => {
  const openState: TokenHoverAnnouncementGateState = {
    announcementPending: true,
    isLoading: false,
    featureAvailable: true,
    guideIntroVisible: false,
    lookAndFeelVisible: false,
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
    expect(tokenHoverAnnouncementCanShow({ ...openState, editModeVisible: true })).toBe(false);
  });
});
