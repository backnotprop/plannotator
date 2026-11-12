export const STALE_PREFERENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isStalePreference(savedAt: unknown, now: number): boolean {
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return true;
  return now - savedAt > STALE_PREFERENCE_TTL_MS;
}
