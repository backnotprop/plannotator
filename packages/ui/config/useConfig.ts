import { useCallback, useSyncExternalStore } from 'react';
import { configStore, type SettingValue } from './configStore';
import type { SettingName } from './settings';

export function useConfigValue<K extends SettingName>(key: K): SettingValue<K> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => configStore.subscribe(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(() => configStore.get(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
