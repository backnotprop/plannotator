/** The favicon a person picks. */
export type FaviconStyle = 'glass' | 'yellow' | 'totman';

export const DEFAULT_FAVICON_STYLE: FaviconStyle = 'glass';

/** The choices, in the order they are shown, with the names people see. */
export const FAVICON_STYLE_CHOICES: readonly { id: FaviconStyle; label: string }[] = [
  { id: 'glass', label: 'Glass' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'totman', label: 'Face' },
];

export function isFaviconStyle(value: unknown): value is FaviconStyle {
  return value === 'glass' || value === 'yellow' || value === 'totman';
}
