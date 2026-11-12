import { useEffect, useState } from 'react';

export interface SystemSetupRequest {
  project: string | null;
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

export function systemSetupLinked(search: string): { project: string | null } | null {
  const params = new URLSearchParams(search);
  if (!params.has('system-setup')) return null;
  return { project: params.get('system-setup') || null };
}
