import { parseCssColor } from './cssColor';

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
      }
    }
  } finally {
    probe?.remove();
  }
  return tokens;
}
