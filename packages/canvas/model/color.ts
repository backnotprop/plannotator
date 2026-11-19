/**
 * Colour on any object. A person or an agent can set either a named colour
 * (it follows the theme, light and dark) or any CSS colour they like.
 *
 * A custom colour is a string an agent can send, so it is checked against a
 * closed grammar before it reaches a style attribute: hex, or one colour
 * function with numbers. No `url()`, no `var()`, no semicolons.
 */

export const NAMED_COLORS = ['neutral', 'blue', 'green', 'amber', 'red', 'violet'] as const;
export type NamedColor = (typeof NAMED_COLORS)[number];

/** A named colour, or `{ custom }` holding a checked CSS colour. */
export type CanvasColor = NamedColor | { custom: string };

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_RE = /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(\s*[-+0-9.%a-z/,\s]{1,80}\)$/i;
/** Only units and `none` may appear as letters inside a colour function. */
const FUNCTION_WORDS_RE = /[a-z]+/gi;
const ALLOWED_WORDS = new Set(['deg', 'rad', 'turn', 'grad', 'none', 'e']);

export function isCustomColor(value: string): boolean {
  if (typeof value !== 'string' || value.length > 96) return false;
  const v = value.trim();
  if (HEX_RE.test(v)) return true;
  if (!FUNCTION_RE.test(v)) return false;
  const inner = v.slice(v.indexOf('(') + 1, -1);
  for (const word of inner.match(FUNCTION_WORDS_RE) ?? []) {
    if (!ALLOWED_WORDS.has(word.toLowerCase())) return false;
  }
  return true;
}

export const isNamedColor = (value: unknown): value is NamedColor =>
  typeof value === 'string' && (NAMED_COLORS as readonly string[]).includes(value);

/** Null when the value is not a colour this canvas takes. */
export function parseColor(value: unknown): CanvasColor | null {
  if (isNamedColor(value)) return value;
  if (typeof value === 'string') return isCustomColor(value) ? { custom: value.trim() } : null;
  if (value && typeof value === 'object' && 'custom' in value) {
    const custom = (value as { custom: unknown }).custom;
    return typeof custom === 'string' && isCustomColor(custom) ? { custom: custom.trim() } : null;
  }
  return null;
}

export function colorsEqual(a: CanvasColor | undefined, b: CanvasColor | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a === 'object' && typeof b === 'object') return a.custom === b.custom;
  return false;
}
