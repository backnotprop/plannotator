import { useEffect, useState } from 'react';

/**
 * Opens System's setup dialog from anywhere in the window: the System button's "Set up a project" (step B2) and
 * Settings → Capabilities' Set up (step B1) call `openSystemSetup()`; App draws the dialog while System is shown.
 */
export interface SystemSetupRequest {
  /** The project to start on; null: the first one. */
  project: string | null;
  /** Counts up per request, so asking again for the same project opens it again. */
  n: number;
}

let current: SystemSetupRequest | null = null;
let count = 0;
const listeners = new Set<(request: SystemSetupRequest | null) => void>();

export function openSystemSetup(project: string | null = null): void {
  count += 1;
  current = { project, n: count };
  for (const listener of listeners) listener(current);
}

export function closeSystemSetup(): void {
  current = null;
  for (const listener of listeners) listener(null);
}

export function useSystemSetupRequest(): SystemSetupRequest | null {
  const [request, setRequest] = useState(current);
  useEffect(() => {
    listeners.add(setRequest);
    setRequest(current);
    return () => {
      listeners.delete(setRequest);
    };
  }, []);
  return request;
}

/** `?system-setup` (or `?system-setup=<project id>`) in the window's address opens the dialog: a link for tests and pictures. */
export function systemSetupLinked(search: string): { project: string | null } | null {
  const params = new URLSearchParams(search);
  if (!params.has('system-setup')) return null;
  return { project: params.get('system-setup') || null };
}
