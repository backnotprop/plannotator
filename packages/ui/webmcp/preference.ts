/**
 * The user's WebMCP opt-out, kept OUT of the settings registry on purpose.
 *
 * `configStore.ensureLoaded` seeds every registry entry's default into a
 * cookie on first settings access, which would write a cookie for every
 * user of every surface (plan, annotate, code review, the guides.show
 * viewer) whether or not their browser has `document.modelContext`. That is
 * a footprint. This module is idle at its default: nothing is read or
 * written until the Settings row (shown only when the API exists) is
 * toggled, and turning the tools back on removes the cookie instead of
 * writing `true`.
 *
 * Cookie: `plannotator-webmcp-tools=false` while opted out; absent otherwise.
 */
import { useSyncExternalStore } from 'react';
import { storage } from '../utils/storage';

export const WEBMCP_TOOLS_COOKIE = 'plannotator-webmcp-tools';

const listeners = new Set<() => void>();
/** Resolved lazily on first read; write-through afterwards so the snapshot is stable for useSyncExternalStore. */
let cached: boolean | null = null;

/** Whether the tools are enabled for this browser (default true; only an explicit opt-out disables). */
export function getWebMcpToolsEnabled(): boolean {
  if (cached === null) cached = storage.getItem(WEBMCP_TOOLS_COOKIE) !== 'false';
  return cached;
}

/** Persist the opt-out. `true` removes the cookie so the default stays cookie-free. */
export function setWebMcpToolsEnabled(enabled: boolean): void {
  if (enabled) {
    if (storage.getItem(WEBMCP_TOOLS_COOKIE) !== null) storage.removeItem(WEBMCP_TOOLS_COOKIE);
  } else {
    storage.setItem(WEBMCP_TOOLS_COOKIE, 'false');
  }
  cached = enabled;
  for (const listener of listeners) listener();
}

export function subscribeWebMcpToolsEnabled(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWebMcpToolsEnabled(): boolean {
  return useSyncExternalStore(subscribeWebMcpToolsEnabled, getWebMcpToolsEnabled, getWebMcpToolsEnabled);
}
