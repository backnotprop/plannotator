/**
 * Token hover cards: how the card is triggered, and how long the pointer has
 * to rest before one is requested.
 *
 * Two settings, deliberately. "Hover cards annoy me" is three complaints with
 * three remedies: never want them (`off`), want them on request rather than
 * while reading (`modifier`), and want them just less eager (a longer dwell).
 * A modifier mode does not serve the third, and a delay does not serve the
 * second. Everything else about the card (the leave grace, the render
 * threshold, the cache) is a correctness constant, not a taste.
 */

/**
 * How a hover card opens.
 *
 * - `hover`: rest the pointer on a symbol. The shipped default.
 * - `modifier`: only while the platform's primary modifier is held, Cmd on
 *   macOS and Ctrl on Windows and Linux. With the key up nothing is armed and
 *   nothing reaches the wire.
 * - `off`: the handlers are never wired, so there are no listeners, no
 *   requests and no card in the tree.
 *
 * Cmd rather than Alt for two reasons. Alt is widely bound to push-to-talk
 * dictation, so an Alt-held gate would open cards while the user is speaking.
 * And Cmd+hover is already VS Code's "tell me about this symbol" gesture, so
 * this rides muscle memory instead of competing with it: the navigable-target
 * underline and the card appearing together under one held key is the
 * composite gesture, not a collision. Cmd+click still supersedes the card,
 * because every References invocation dismisses the hover surface first.
 *
 * The stored value stays `modifier`, deliberately: the setting names the shape
 * of the gate, not which key fills it, so nothing had to migrate.
 */
export type TokenHoverTrigger = "hover" | "modifier" | "off";

/** Every trigger, in the order the Settings control presents them. */
export const TOKEN_HOVER_TRIGGERS = [
  "hover",
  "modifier",
  "off",
] as const satisfies readonly TokenHoverTrigger[];

export function isTokenHoverTrigger(value: unknown): value is TokenHoverTrigger {
  return value === "hover" || value === "modifier" || value === "off";
}

/**
 * Dwell before any request exists, in milliseconds. Three fixed steps rather
 * than a slider: the perceptible granularity here is around 150ms, so offering
 * finer precision would imply a difference nobody can feel.
 */
export type TokenHoverDelay = 150 | 300 | 700;

/** The dwell #1461 shipped, and still the default. */
export const DEFAULT_TOKEN_HOVER_DELAY_MS = 300 satisfies TokenHoverDelay;

/** Every delay, fastest first, in the order the Settings control presents them. */
export const TOKEN_HOVER_DELAYS = [
  150,
  300,
  700,
] as const satisfies readonly TokenHoverDelay[];

export function isTokenHoverDelay(value: unknown): value is TokenHoverDelay {
  return value === 150 || value === 300 || value === 700;
}

/**
 * Read a stored trigger, migrating the pre-#1461-follow-up boolean.
 *
 * `tokenHoverCards` was one on/off switch. Its `false` is a real preference
 * ("I turned these off") and must survive, so the legacy value is READ here
 * and never written back: the new key is seeded on first settings access, and
 * the legacy cookie is left in place so a downgrade does not silently
 * re-enable cards for someone who had turned them off.
 *
 * Returns undefined when neither key says anything, which lets the settings
 * registry apply its own default.
 */
export function resolveStoredTokenHoverTrigger(
  stored: string | null | undefined,
  legacyEnabled: string | null | undefined,
): TokenHoverTrigger | undefined {
  if (isTokenHoverTrigger(stored)) return stored;
  if (legacyEnabled === "false") return "off";
  if (legacyEnabled === "true") return "hover";
  return undefined;
}
