export const SIGNAL_LIMIT = 20;
export const SIGNAL_WINDOW_MS = 60_000;
export const HELD_COMMANDS_MAX = 50;
export const HELD_COMMAND_BYTES_MAX = 64 * 1024 * 1024;
export const HELD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function heldMaxAgeMs(configured: string | undefined): number {
  const seconds = Number(configured);
  return Number.isFinite(seconds) && seconds > 0 && seconds * 1000 < HELD_MAX_AGE_MS ? seconds * 1000 : HELD_MAX_AGE_MS;
}

/** The hard brake on mailbox creation (src/create-brake.ts): 20 per client address in a fixed 60 s window, the binding's rule. */
export const CREATE_LIMIT = 20;
export const CREATE_WINDOW_MS = 60_000;

export interface CreateWindow {
  since: number;
  count: number;
}

/** One creation against a client's window: the window to keep, and whether it is allowed (with the seconds until it is, when not). */
export function takeCreate(window: CreateWindow | null, now: number): { window: CreateWindow; allowed: boolean; retryAfter: number } {
  if (!window || now < window.since || now - window.since >= CREATE_WINDOW_MS) return { window: { since: now, count: 1 }, allowed: true, retryAfter: 0 };
  if (window.count >= CREATE_LIMIT) return { window, allowed: false, retryAfter: Math.max(1, Math.ceil((window.since + CREATE_WINDOW_MS - now) / 1000)) };
  return { window: { since: window.since, count: window.count + 1 }, allowed: true, retryAfter: 0 };
}
