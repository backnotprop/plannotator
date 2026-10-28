import { afterEach, describe, expect, test } from 'bun:test';
import {
  inboxAnnouncementEligible,
  isVSCodeWebview,
  markInboxAnnouncementSeen,
  needsInboxAnnouncement,
  type InboxAnnouncementGateState,
} from './inboxAnnouncement';
import { resetStorageBackend, setStorageBackend, type StorageBackend } from './storage';

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function eligible(overrides: Partial<InboxAnnouncementGateState> = {}) {
  return inboxAnnouncementEligible({
    announcementPending: true,
    isLoading: false,
    readOnlySession: false,
    vscodeWebview: false,
    otherFirstRunDialogVisible: false,
    earlierAnnouncementTakesThisLoad: false,
    ...overrides,
  });
}

afterEach(() => {
  memory.clear();
  resetStorageBackend();
});

describe('Inbox announcement gate', () => {
  test('marking it seen is what retires it, and reading writes nothing', () => {
    setStorageBackend(memoryBackend);
    expect(needsInboxAnnouncement()).toBe(true);
    expect(memory.size).toBe(0);

    markInboxAnnouncementSeen();
    expect(needsInboxAnnouncement()).toBe(false);
  });

  test('every suppressing condition independently withholds it, and none spends it', () => {
    setStorageBackend(memoryBackend);
    expect(eligible()).toBe(true);
    expect(eligible({ announcementPending: false })).toBe(false);
    expect(eligible({ isLoading: true })).toBe(false);
    expect(eligible({ readOnlySession: true })).toBe(false);
    expect(eligible({ vscodeWebview: true })).toBe(false);
    expect(eligible({ otherFirstRunDialogVisible: true })).toBe(false);
    expect(eligible({ earlierAnnouncementTakesThisLoad: true })).toBe(false);
    expect(needsInboxAnnouncement()).toBe(true);
  });

  test.if(typeof window !== 'undefined')('reads the VS Code webview flag the extension sets', () => {
    const target = window as { __PLANNOTATOR_VSCODE?: unknown };
    try {
      expect(isVSCodeWebview()).toBe(false);
      target.__PLANNOTATOR_VSCODE = true;
      expect(isVSCodeWebview()).toBe(true);
    } finally {
      delete target.__PLANNOTATOR_VSCODE;
    }
  });
});
