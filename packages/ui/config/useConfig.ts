/**
 * React hook for consuming ConfigStore values.
 *
 * Uses useSyncExternalStore for concurrent-mode-safe subscriptions
 * to the singleton configStore — no context provider needed.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { configStore, type SettingValue } from './configStore';
import type { SettingName } from './settings';

/** Read a config value reactively. Re-renders when the store changes. */
export function useConfigValue<K extends SettingName>(key: K): SettingValue<K> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => configStore.subscribe(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(() => configStore.get(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
