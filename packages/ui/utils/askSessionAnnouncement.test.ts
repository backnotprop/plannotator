import { afterEach, describe, expect, test } from 'bun:test';
import {
  askSessionAnnouncementEligible,
  askSessionAnnouncementPendingThisLoad,
  connectedAskSessionAgent,
  markAskSessionAnnouncementSeen,
  needsAskSessionAnnouncement,
  type AskSessionAnnouncementGateState,
} from './askSessionAnnouncement';
import { markTerminalToolsAnnouncementSeen } from './terminalToolsAnnouncement';
import { resetStorageBackend, setStorageBackend, type StorageBackend } from './storage';

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function showable(overrides: Partial<AskSessionAnnouncementGateState> = {}) {
  return askSessionAnnouncementEligible({
    announcementPending: true,
    isLoading: false,
    connectedAgent: 'claude-code',
    askAIUsable: true,
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

describe('Ask this session announcement gate', () => {
  test('marking it seen is what retires it, and reading writes nothing', () => {
    setStorageBackend(memoryBackend);

    expect(needsAskSessionAnnouncement()).toBe(true);
    expect(memory.size).toBe(0);

    markAskSessionAnnouncementSeen();
    expect(needsAskSessionAnnouncement()).toBe(false);
    // Its own key: dismissing it must not retire the terminal-tools one.
    expect(memory.has('plannotator-announce-tui-herdr-seen')).toBe(false);
  });

  test('a value from another announcement version does not count as seen', () => {
    setStorageBackend(memoryBackend);
    memory.set('plannotator-announce-ask-session-seen', 'true');
    expect(needsAskSessionAnnouncement()).toBe(true);
  });

  test('never on the same load as a pending terminal-tools announcement', () => {
    setStorageBackend(memoryBackend);

    // A fresh browser: the terminal-tools announcement takes this load.
    expect(askSessionAnnouncementPendingThisLoad()).toBe(false);

    // Once that one is dismissed (an earlier load), this one is next.
    markTerminalToolsAnnouncementSeen();
    expect(askSessionAnnouncementPendingThisLoad()).toBe(true);

    markAskSessionAnnouncementSeen();
    expect(askSessionAnnouncementPendingThisLoad()).toBe(false);
  });

  test('only a live session bridge counts as connected', () => {
    const bridge = (host: string, status: 'ready' | 'busy' | 'blocked' | 'gone') => ({
      name: 'session-bridge',
      sessionBridge: { host, status, modes: { turn: true, transient: false } },
    });
    const sdk = { name: 'claude-agent-sdk' };

    expect(connectedAskSessionAgent([bridge('claude-code', 'ready')])).toBe('claude-code');
    expect(connectedAskSessionAgent([bridge('pi', 'busy')])).toBe('pi');
    expect(connectedAskSessionAgent([bridge('opencode', 'blocked')])).toBe('opencode');
    // No bridge: remote, --tailscale, Windows, mod off, -p, OpenCode 1...
    expect(connectedAskSessionAgent([])).toBeNull();
    expect(connectedAskSessionAgent([sdk])).toBeNull();
    // Listed but gone: telling the reader it is connected would be false.
    expect(connectedAskSessionAgent([bridge('claude-code', 'gone')])).toBeNull();
    // A host this copy cannot name.
    expect(connectedAskSessionAgent([bridge('amp', 'ready')])).toBeNull();
    // The provider row without its live status.
    expect(connectedAskSessionAgent([{ name: 'session-bridge' }])).toBeNull();
  });

  test('every suppressing condition independently withholds the dialog', () => {
    expect(showable()).toBe(true);
    expect(showable({ announcementPending: false })).toBe(false);
    expect(showable({ isLoading: true })).toBe(false);
    expect(showable({ connectedAgent: null })).toBe(false);
    expect(showable({ askAIUsable: false })).toBe(false);
    expect(showable({ readOnlySession: true })).toBe(false);
    expect(showable({ compact: true })).toBe(false);
    expect(showable({ otherFirstRunDialogVisible: true })).toBe(false);
  });
});
