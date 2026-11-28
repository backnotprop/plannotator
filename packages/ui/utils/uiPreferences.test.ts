/**
 * Settings → Display → Plan Width. Wide fills the space between the side
 * panels (no cap); Compact and Default keep their caps; a person who saved
 * Wide before keeps that choice and simply gets the wider document.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { configStore, ConfigStoreForTest } from '../config/configStore';
import { resetStorageBackend, setStorageBackend } from './storage';
import { getPlanMaxWidth, getUIPreferences, PLAN_WIDTH_OPTIONS, saveUIPreferences } from './uiPreferences';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

/** The preferences live in the config store (config.json `displayOptions`): it reads the new storage, and writes go nowhere. */
function withStorage(initial: Record<string, string> = {}) {
  const backend = memoryStorage(initial);
  setStorageBackend(backend);
  configStore.setServerSync(() => {});
  configStore.loadFromBackend();
  return backend;
}

afterEach(() => {
  configStore.resetServerSync();
  resetStorageBackend();
});

describe('plan width', () => {
  test('Wide has no cap; Compact and Default keep theirs', () => {
    expect(getPlanMaxWidth('wide')).toBeNull();
    expect(getPlanMaxWidth('compact')).toBe(832);
    expect(getPlanMaxWidth('default')).toBe(1040);
  });

  test('still three choices, the third one fills', () => {
    expect(PLAN_WIDTH_OPTIONS.map((o) => o.id)).toEqual(['compact', 'default', 'wide']);
    expect(PLAN_WIDTH_OPTIONS.filter((o) => o.fills).map((o) => o.id)).toEqual(['wide']);
  });

  test('a Wide saved before this change still loads as Wide and fills', () => {
    withStorage({ 'plannotator-plan-width': 'wide' });
    const prefs = getUIPreferences();
    expect(prefs.planWidth).toBe('wide');
    expect(getPlanMaxWidth(prefs.planWidth)).toBeNull();
  });

  test('choosing Wide saves the same value as before', () => {
    const backend = withStorage();
    saveUIPreferences({ tocEnabled: true, stickyActionsEnabled: true, planWidth: 'compact' });
    saveUIPreferences({ tocEnabled: true, stickyActionsEnabled: true, planWidth: 'wide' });
    expect(backend.getItem('plannotator-plan-width')).toBe('wide');
  });

  test('an unknown saved value falls back to Compact', () => {
    setStorageBackend(memoryStorage({ 'plannotator-plan-width': 'edge-to-edge' }));
    // A store that has not resolved yet, as on page load.
    expect(getPlanMaxWidth(new ConfigStoreForTest().get('planWidth'))).toBe(832);
  });
});
