/**
 * Reading the live theme tokens off the document, for code that derives
 * colours from the palette on screen (Mermaid's theme, the review sidebar's
 * +/- counts). Browser-only, and free of any diagram code, so a bundle that
 * only needs the tokens never pulls a diagram runtime in.
 */
import { parseCssColor } from './cssColor';

/**
 * Read the custom properties `names` off `el` (default: the document element,
 * where `ThemeProvider` puts the `theme-*` / `light` classes). Colours the
 * parser does not understand as written (`color-mix()`, a `var()` chain) are
 * resolved through a throwaway probe element so the engine does the
 * substitution; names in `raw` are returned as written (a font stack).
 * Returns `undefined` outside a browser; a token that does not resolve is
 * left out.
 */
export function readThemeTokenValues<N extends string>(
  names: readonly N[],
  el?: Element | null,
  raw: readonly N[] = [],
): Partial<Record<N, string>> | undefined {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return undefined;
  const target = el ?? document.documentElement;
  if (!target) return undefined;
  let computed: CSSStyleDeclaration;
  try {
    computed = getComputedStyle(target);
  } catch {
    return undefined;
  }
  const tokens: Partial<Record<N, string>> = {};
  let probe: HTMLElement | null = null;
  try {
    for (const name of names) {
      let value = '';
      try {
        value = computed.getPropertyValue(`--${name}`).trim();
      } catch {
        value = '';
      }
      if (!value) continue;
      if (raw.includes(name)) {
        tokens[name] = value;
        continue;
      }
      if (parseCssColor(value)) {
        tokens[name] = value;
        continue;
      }
      // Unparsable as written: let the engine resolve it to a colour.
      try {
        if (!probe) {
          probe = document.createElement('span');
          probe.setAttribute('aria-hidden', 'true');
          probe.style.position = 'absolute';
          probe.style.width = '0';
          probe.style.height = '0';
          probe.style.overflow = 'hidden';
          probe.style.pointerEvents = 'none';
          target.appendChild(probe);
        }
        probe.style.color = `var(--${name})`;
        const resolved = getComputedStyle(probe).color.trim();
        if (resolved && parseCssColor(resolved)) tokens[name] = resolved;
      } catch {
        // leave the token absent
      }
    }
  } finally {
    probe?.remove();
  }
  return tokens;
}
