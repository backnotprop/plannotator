import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from './storage';
import {
  markVimModeAnnouncementSeen,
  needsVimModeAnnouncement,
} from './vimModeAnnouncement';

const STORAGE_KEY = 'plannotator-vim-mode-announcement-seen';
let stored: Map<string, string>;

describe('Vim mode announcement persistence', () => {
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
    expect(needsVimModeAnnouncement()).toBe(true);

    markVimModeAnnouncementSeen();

    expect(stored.get(STORAGE_KEY)).toBe('2');
    expect(needsVimModeAnnouncement()).toBe(false);
  });

  test('shows again when a stored announcement version is stale', () => {
    stored.set(STORAGE_KEY, '1');
    expect(needsVimModeAnnouncement()).toBe(true);
  });
});
