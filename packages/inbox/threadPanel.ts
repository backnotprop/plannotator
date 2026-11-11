import { useCallback, useState } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

export const THREAD_PANEL_COOKIE = 'plannotator-inbox-thread-panel';

export const THREAD_PANEL_LABEL = 'Keep thread panel open';

export function readThreadPanel(): boolean {
  return storage.getItem(THREAD_PANEL_COOKIE) === '1';
}

export function writeThreadPanel(on: boolean): void {
  if (on) storage.setItem(THREAD_PANEL_COOKIE, '1');
  else storage.removeItem(THREAD_PANEL_COOKIE);
}

export function threadPanelShows(on: boolean, window: { phone: boolean; stacked: boolean }): boolean {
  return on && !window.phone && !window.stacked;
}

export function useThreadPanel(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readThreadPanel);
  const set = useCallback((next: boolean) => {
    writeThreadPanel(next);
    setOn(next);
  }, []);
  return [on, set];
}
