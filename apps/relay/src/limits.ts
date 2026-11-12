export const SIGNAL_LIMIT = 20;
export const SIGNAL_WINDOW_MS = 60_000;
export const HELD_COMMANDS_MAX = 50;
export const HELD_COMMAND_BYTES_MAX = 64 * 1024 * 1024;
export const HELD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function heldMaxAgeMs(configured: string | undefined): number {
  const seconds = Number(configured);
  return Number.isFinite(seconds) && seconds > 0 && seconds * 1000 < HELD_MAX_AGE_MS ? seconds * 1000 : HELD_MAX_AGE_MS;
}
