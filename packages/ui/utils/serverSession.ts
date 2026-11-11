import { useSyncExternalStore } from 'react';
import { SERVER_SESSION_FIELD, SERVER_SESSION_MISMATCH_CODE } from '@plannotator/core/server-session';

let nonce: string | null = null;
let replaced = false;
const listeners = new Set<() => void>();

/** Adopt the nonce a payload advertised (absent from an older server: no guard). */
export function adoptServerSession(value: unknown): void {
  if (typeof value === 'string' && value) nonce = value;
}

/** The nonce this tab holds, or null when the server never advertised one. */
export function currentServerSession(): string | null {
  return nonce;
}

/** A decision body with the nonce added (unchanged when none is held). */
export function withServerSession<T extends object>(body: T): T & { serverSession?: string } {
  return nonce ? { ...body, [SERVER_SESSION_FIELD]: nonce } : body;
}

/** A decision URL with the nonce as a query parameter (exit posts carry no body). */
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

/** React: true once a decision was refused because this tab's server was replaced. */
export function useServerSessionReplaced(): boolean {
  return useSyncExternalStore(subscribe, isServerSessionReplaced, isServerSessionReplaced);
}

export function __resetServerSessionForTests(): void {
  nonce = null;
  replaced = false;
  for (const listener of listeners) listener();
}
