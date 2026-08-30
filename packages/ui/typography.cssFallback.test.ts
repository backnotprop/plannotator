import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `--pn-display-font` / `--pn-mono-font` are DEFINED on `[data-pn-surface]`
 * (theme.css), so they only resolve inside that subtree. Large parts of the UI
 * render outside it: the review annotation toolbar and the Settings dialog
 * portal to document.body, Base UI popovers mount at the body without a
 * container, and the external line-annotation composer is a sibling of the
 * surface div. A bare `var(--pn-mono-font)` in any of those loses monospace
 * entirely — at DEFAULT settings, with no typography configured — because an
 * unresolvable var makes the whole declaration invalid rather than inherited.
 * The same CSS is bundled into the guides.show viewer, so it ships there too.
 *
 * Every reference must therefore carry the palette token as its fallback.
 */
const FILES = [
  join(import.meta.dir, 'theme.css'),
  join(import.meta.dir, '..', 'review-editor', 'index.css'),
];

const BARE = /var\(\s*--pn-(?:display|mono)-font\s*\)/g;

describe('per-surface font vars always carry a palette fallback', () => {
  for (const file of FILES) {
    test(file.split('/').slice(-2).join('/'), () => {
      const css = readFileSync(file, 'utf8');
      // Sanity: this guard is worthless if the vars are not used here at all.
      expect(css).toContain('--pn-mono-font');
      expect([...css.matchAll(BARE)].map(m => m[0])).toEqual([]);
    });
  }

  test('every use resolves to --font-mono or --font-sans when unset', () => {
    for (const file of FILES) {
      const css = readFileSync(file, 'utf8');
      for (const [, role, fallback] of css.matchAll(/var\(\s*--pn-(display|mono)-font\s*,([^)]*\))/g)) {
        expect(fallback!.trim()).toBe(role === 'mono' ? 'var(--font-mono)' : 'var(--font-sans)');
      }
    }
  });
});
