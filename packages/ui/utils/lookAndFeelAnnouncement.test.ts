import { afterEach, describe, expect, test } from 'bun:test';
import {
  markLookAndFeelChoiceResolved,
  needsLookAndFeelAnnouncement,
} from './lookAndFeelAnnouncement';
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from './storage';

const values = new Map<string, string>();
const memoryStorage: StorageBackend = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => void values.set(key, value),
  removeItem: (key) => void values.delete(key),
};

describe('plan look choice gate', () => {
  afterEach(() => {
    values.clear();
    resetStorageBackend();
  });

  test('asks until the Grid/Clean decision is explicitly resolved', () => {
    setStorageBackend(memoryStorage);

    expect(needsLookAndFeelAnnouncement()).toBe(true);
    // ConfigStore seeds this default before the chooser initializes. It must
    // not be mistaken for a user decision.
    values.set('plannotator-grid-enabled', 'true');
    expect(needsLookAndFeelAnnouncement()).toBe(true);

    markLookAndFeelChoiceResolved();
    expect(needsLookAndFeelAnnouncement()).toBe(false);
  });

  test('migrates the old Grid/Clean chooser dismissal without another prompt', () => {
    setStorageBackend(memoryStorage);
    values.set('plannotator-look-feel-announcement-seen', '2');

    expect(needsLookAndFeelAnnouncement()).toBe(false);
  });

  test('does not treat an earlier release-only announcement as this decision', () => {
    setStorageBackend(memoryStorage);
    values.set('plannotator-look-feel-announcement-seen', '1');

    expect(needsLookAndFeelAnnouncement()).toBe(true);
  });
});
