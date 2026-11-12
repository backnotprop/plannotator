export type FaviconStyle = 'glass' | 'yellow' | 'totman';

export const DEFAULT_FAVICON_STYLE: FaviconStyle = 'glass';

export const FAVICON_STYLE_CHOICES: readonly { id: FaviconStyle; label: string }[] = [
  { id: 'glass', label: 'Glass' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'totman', label: 'Face' },
];

export function isFaviconStyle(value: unknown): value is FaviconStyle {
  return value === 'glass' || value === 'yellow' || value === 'totman';
}
