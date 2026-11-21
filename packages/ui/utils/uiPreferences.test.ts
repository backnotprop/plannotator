import { afterEach, describe, expect, test } from 'bun:test';
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

afterEach(() => resetStorageBackend());

describe('document width preferences', () => {
  test('persists unlimited as a supported width', () => {
    setStorageBackend(memoryStorage());

    saveUIPreferences({ tocEnabled: true, stickyActionsEnabled: true, planWidth: 'unlimited' });

    expect(getUIPreferences().planWidth).toBe('unlimited');
    expect(getPlanMaxWidth('unlimited')).toBeNull();
    expect(PLAN_WIDTH_OPTIONS.at(-1)).toMatchObject({ id: 'unlimited', label: 'Unlimited', px: null });
  });

  test('keeps the compact fallback for unknown stored values', () => {
    setStorageBackend(memoryStorage({ 'plannotator-plan-width': 'edge-to-edge' }));

    expect(getUIPreferences().planWidth).toBe('compact');
    expect(getPlanMaxWidth('compact')).toBe(832);
  });
});
