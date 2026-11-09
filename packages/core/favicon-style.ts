/**
 * The favicon styles, without their icons (those are in favicon.ts, which
 * re-exports everything here). Kept apart so code that only stores or checks
 * the choice (the settings store) does not pull every icon into its bundle.
 */

/**
 * The favicon a person picks. The ids are what cookies (`plannotator-favicon`)
 * and config.json (`favicon`) store:
 * - 'glass': the Glass icon, the default for anyone with nothing stored.
 * - 'totman': the Face icon. The id is older than the name: it is what people
 *   picked when this icon was the default, so it keeps meaning this icon.
 * - 'classic': the P icon. The id is older than this icon: it named the navy P,
 *   which the P icon replaced, so anyone who chose Classic gets the P icon.
 */
export type FaviconStyle = 'glass' | 'totman' | 'classic';

export const DEFAULT_FAVICON_STYLE: FaviconStyle = 'glass';

/** The choices, in the order they are shown, with the names people see. */
export const FAVICON_STYLE_CHOICES: readonly { id: FaviconStyle; label: string }[] = [
  { id: 'glass', label: 'Glass' },
  { id: 'totman', label: 'Face' },
  { id: 'classic', label: 'P' },
];

export function isFaviconStyle(value: unknown): value is FaviconStyle {
  return value === 'glass' || value === 'totman' || value === 'classic';
}
