import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { SETTINGS } from './settings';

afterEach(() => {
  resetStorageBackend();
});

function installBackend() {
  const values = new Map<string, string>();
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

const SIDE_COOKIE = 'plannotator-annotate-agent-terminal-side';
const AGENT_COOKIE = 'plannotator-annotate-agent-terminal-default';

describe('agentTerminalSide setting', () => {
  test('keeps the pre-registry cookie key so an upgrade preserves the placement', () => {
    // The cookie name is the contract with releases that stored a side before
    // this setting joined the registry; renaming it silently resets users.
    const values = installBackend();
    values.set(SIDE_COOKIE, 'right');
    expect(SETTINGS.agentTerminalSide.fromCookie()).toBe('right');
  });

  test('defaults to left and round-trips every valid side', () => {
    const values = installBackend();
    expect(SETTINGS.agentTerminalSide.defaultValue).toBe('left');
    expect(SETTINGS.agentTerminalSide.fromCookie()).toBeUndefined();

    for (const side of ['left', 'right', 'hidden'] as const) {
      SETTINGS.agentTerminalSide.toCookie(side);
      expect(values.get(SIDE_COOKIE)).toBe(side);
      expect(SETTINGS.agentTerminalSide.fromCookie()).toBe(side);
    }
  });

  test('ignores an unrecognized stored side instead of adopting it', () => {
    const values = installBackend();
    values.set(SIDE_COOKIE, 'bottom');
    expect(SETTINGS.agentTerminalSide.fromCookie()).toBeUndefined();
  });

  test('syncs both directions with ~/.plannotator/config.json', () => {
    // The durability fix: annotate runs on a fresh random port each time, so a
    // cookie-only preference is effectively per-session. Without the server
    // leg the placement silently resets on the next annotate.
    expect(SETTINGS.agentTerminalSide.serverKey).toBe('agentTerminalSide');
    expect(SETTINGS.agentTerminalSide.toServer('hidden')).toEqual({ agentTerminalSide: 'hidden' });
    expect(SETTINGS.agentTerminalSide.fromServer({ agentTerminalSide: 'right' })).toBe('right');
    expect(SETTINGS.agentTerminalSide.fromServer({ agentTerminalSide: 'sideways' })).toBeUndefined();
    expect(SETTINGS.agentTerminalSide.fromServer({})).toBeUndefined();
  });
});

describe('agentTerminalDefaultAgent setting', () => {
  test('keeps the pre-registry cookie key and round-trips an agent id', () => {
    const values = installBackend();
    values.set(AGENT_COOKIE, 'codex');
    expect(SETTINGS.agentTerminalDefaultAgent.fromCookie()).toBe('codex');

    SETTINGS.agentTerminalDefaultAgent.toCookie('claude');
    expect(values.get(AGENT_COOKIE)).toBe('claude');
    expect(SETTINGS.agentTerminalDefaultAgent.fromCookie()).toBe('claude');
  });

  test('an empty choice clears the cookie rather than storing a blank agent id', () => {
    // Otherwise resolveAnnotateAgentId is handed "" as if it were a saved
    // preference instead of falling through to the first available agent.
    const values = installBackend();
    values.set(AGENT_COOKIE, 'claude');
    SETTINGS.agentTerminalDefaultAgent.toCookie('');
    expect(values.has(AGENT_COOKIE)).toBe(false);
    expect(SETTINGS.agentTerminalDefaultAgent.fromCookie()).toBeUndefined();
  });

  test('syncs both directions with ~/.plannotator/config.json', () => {
    expect(SETTINGS.agentTerminalDefaultAgent.serverKey).toBe('agentTerminalDefaultAgent');
    expect(SETTINGS.agentTerminalDefaultAgent.toServer('codex')).toEqual({
      agentTerminalDefaultAgent: 'codex',
    });
    expect(SETTINGS.agentTerminalDefaultAgent.fromServer({ agentTerminalDefaultAgent: 'codex' })).toBe('codex');
    expect(SETTINGS.agentTerminalDefaultAgent.fromServer({ agentTerminalDefaultAgent: '' })).toBeUndefined();
    expect(SETTINGS.agentTerminalDefaultAgent.fromServer({ agentTerminalDefaultAgent: 7 })).toBeUndefined();
  });
});
