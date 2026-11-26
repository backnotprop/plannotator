/**
 * Dynamic font loading for code review diff viewer.
 *
 * Injects Google Fonts / CDN stylesheet links on demand when the user
 * selects a custom diff font. Each font is loaded at most once. The table
 * lives in @plannotator/core/diff-fonts, next to the places it loads from,
 * which the Inbox window's CSP allows.
 */

import { DIFF_FONT_URLS as FONT_URLS } from '@plannotator/core/diff-fonts';

const loaded = new Set<string>();

export function loadDiffFont(fontFamily: string): void {
  if (!fontFamily || loaded.has(fontFamily)) return;
  // Own keys only: a typed custom name such as `constructor` or `__proto__`
  // must never resolve to something inherited from Object.prototype.
  if (!Object.hasOwn(FONT_URLS, fontFamily)) return;
  const url = FONT_URLS[fontFamily];
  if (typeof url !== 'string') return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.dataset.diffFont = fontFamily;
  document.head.appendChild(link);
  loaded.add(fontFamily);
}
