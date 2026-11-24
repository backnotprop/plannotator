/**
 * Grid's switch in the window (approval "inbox-agent-grid"; Settings → Capabilities → Experimental, off by default),
 * and the list reads Grid needs.
 *
 * Off, nothing of Grid is written: its sidebar row stays out of the cookie (sidebarLayout.ts) as the server leaves
 * it out of config.json, and no look is sent (the page is never drawn).
 *
 * Grid draws from the list the window holds, so the only reads it adds are the list's own, coalesced: when a look
 * changed anywhere (`event: grid-seen`), and, while the page shows, when a PR's checks or review changed
 * (`event: thread-pulls`, which reads no list for the rows' marks).
 */
import { useEffect } from 'react';
import type { SettingsModel } from '../api';
import { listGridAsked, setListGrid } from '../listRead';
import { setSidebarUnsaved } from '../sidebarLayout';

const AGAIN_MS = 150;
let reader: (() => unknown) | null = null;
let isOn = false;
let shown = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Whether Grid is on, from the settings read; the window's list reader for Grid's events. */
export function useGridOn(settings: Pick<SettingsModel, 'experimental'> | null, refreshList: (adopt: boolean) => unknown): boolean {
  const on = settings?.experimental?.grid?.on === true;
  setSidebarUnsaved('grid', !on);
  isOn = on;
  useEffect(() => {
    const read = () => refreshList(false);
    reader = read;
    askGrid();
    return () => {
      if (reader === read) reader = null;
    };
  }, [refreshList, on]);
  return on;
}

/** The page is on screen (counted: a remount overlaps its unmount). */
export function gridShown(on: boolean): void {
  shown = Math.max(0, shown + (on ? 1 : -1));
  askGrid();
}

/** The list reads ask for Grid's fields only while it is on and shows; when they start to, the list is read again. */
function askGrid(): void {
  const ask = isOn && shown > 0;
  if (ask === listGridAsked()) return;
  setListGrid(ask);
  if (ask) listAgain();
}

/** One list read for a burst of events. */
function listAgain(): void {
  if (timer || !reader) return;
  timer = setTimeout(() => {
    timer = null;
    reader?.();
  }, AGAIN_MS);
}

export function gridHeard(event: 'grid-seen' | 'thread-pulls'): void {
  if (isOn && (event === 'grid-seen' || shown > 0)) listAgain();
}
