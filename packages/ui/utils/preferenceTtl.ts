/**
 * Staleness window for raw-HTML session preferences (input method, chrome
 * visibility, drawer state). An explicit choice sticks while the user is
 * actively annotating HTML; after this long without a refresh the preference
 * expires and the session opens on the product defaults again (Pinpoint,
 * tools hidden, drawer closed). Timestamps refresh on explicit changes and on
 * annotation activity, so regulars keep their setup and lapsed sessions reset.
 */
export const STALE_PREFERENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** True when a persisted `savedAt` is missing, malformed, or older than the TTL. */
export function isStalePreference(savedAt: unknown, now: number): boolean {
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return true;
  return now - savedAt > STALE_PREFERENCE_TTL_MS;
}
