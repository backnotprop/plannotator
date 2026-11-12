import { afterEach, describe, expect, test } from 'bun:test';
import {
  markTerminalToolsAnnouncementSeen,
  needsTerminalToolsAnnouncement,
  terminalToolsAnnouncementCanShow,
  type TerminalToolsAnnouncementGateState,
} from './terminalToolsAnnouncement';
import { resetStorageBackend, setStorageBackend, type StorageBackend } from './storage';

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function showable(overrides: Partial<TerminalToolsAnnouncementGateState> = {}) {
  return terminalToolsAnnouncementCanShow({
    announcementPending: true,
    isLoading: false,
    readOnlySession: false,
    compact: false,
    otherFirstRunDialogVisible: false,
    ...overrides,
  });
}

afterEach(() => {
  memory.clear();
  resetStorageBackend();
});

describe('terminal tools announcement gate', () => {
  test('marking it seen is what retires it, and nothing else writes', () => {
    setStorageBackend(memoryBackend);

    expect(needsTerminalToolsAnnouncement()).toBe(true);
    expect(memory.size).toBe(0);

    markTerminalToolsAnnouncementSeen();
    expect(needsTerminalToolsAnnouncement()).toBe(false);
  });

  test('a value from a different announcement version does not count as seen', () => {
    setStorageBackend(memoryBackend);
    memory.set('plannotator-announce-tui-herdr-seen', 'true');

    expect(needsTerminalToolsAnnouncement()).toBe(true);
  });

  test('every suppressing condition independently withholds the dialog', () => {
    expect(showable()).toBe(true);
    expect(showable({ announcementPending: false })).toBe(false);
    expect(showable({ isLoading: true })).toBe(false);
    expect(showable({ readOnlySession: true })).toBe(false);
    expect(showable({ compact: true })).toBe(false);
    expect(showable({ otherFirstRunDialogVisible: true })).toBe(false);
  });

  test('suppression is deferral: the gate never touches the cookie', () => {
    setStorageBackend(memoryBackend);

    showable({ readOnlySession: true });
    showable({ compact: true });
    showable({ otherFirstRunDialogVisible: true });

    expect(needsTerminalToolsAnnouncement()).toBe(true);
  });
});
