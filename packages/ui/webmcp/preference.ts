import { useSyncExternalStore } from 'react';
import { storage } from '../utils/storage';

export const WEBMCP_TOOLS_COOKIE = 'plannotator-webmcp-tools';

const listeners = new Set<() => void>();
let cached: boolean | null = null;

/** Whether the tools are enabled for this browser (default true; only an explicit opt-out disables). */
export function getWebMcpToolsEnabled(): boolean {
  if (cached === null) cached = storage.getItem(WEBMCP_TOOLS_COOKIE) !== 'false';
  return cached;
}

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
