import { useSyncExternalStore } from 'react';
import { SERVER_SESSION_FIELD, SERVER_SESSION_MISMATCH_CODE } from '@plannotator/core/server-session';

let nonce: string | null = null;
let replaced = false;
const listeners = new Set<() => void>();

export function adoptServerSession(value: unknown): void {
  if (typeof value === 'string' && value) nonce = value;
}

export function currentServerSession(): string | null {
  return nonce;
}

export function withServerSession<T extends object>(body: T): T & { serverSession?: string } {
  return nonce ? { ...body, [SERVER_SESSION_FIELD]: nonce } : body;
}

export function withServerSessionQuery(url: string): string {
  if (!nonce) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${SERVER_SESSION_FIELD}=${encodeURIComponent(nonce)}`;
}

export async function noteServerSessionMismatch(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  let code: unknown;
  try {
    code = ((await res.clone().json()) as { code?: unknown } | null)?.code;
  } catch {
    return false;
  }
  if (code !== SERVER_SESSION_MISMATCH_CODE) return false;
  markServerSessionReplaced();
  return true;
}

export function markServerSessionReplaced(): void {
  if (replaced) return;
  replaced = true;
  for (const listener of listeners) listener();
}

export function isServerSessionReplaced(): boolean {
  return replaced;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useServerSessionReplaced(): boolean {
  return useSyncExternalStore(subscribe, isServerSessionReplaced, isServerSessionReplaced);
}

export function __resetServerSessionForTests(): void {
  nonce = null;
  replaced = false;
  for (const listener of listeners) listener();
}
