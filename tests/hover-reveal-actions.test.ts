import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// #2062: Tailwind v4 compiles `group-hover:` (and `hover:`) inside
// `@media (hover: hover)`. A control written `opacity-0 group-hover:opacity-100`
// therefore never shows on a device that reports `(hover: none)`: phones,
// tablets, and some desktop Chrome builds with a plain mouse. Comment cards in
// code review lost Edit / Copy / Delete that way.
//
// The rule: a class string that reveals something on group hover must also
// reveal it under `[@media(hover:none)]` (same opacity) and to the keyboard
// (`focus-within` or `focus-visible`). Purely decorative hover effects are
// listed below with the reason they are exempt.

const root = resolve(import.meta.dir, '..');
const SCANNED = ['packages/review-editor', 'packages/ui/components', 'packages/editor', 'packages/guide-viewer'];

/** file → a substring of the exempt class string, and why. */
const DECORATIVE: Array<{ file: string; marker: string; why: string }> = [
  { file: 'packages/ui/components/KeyboardShortcuts.tsx', marker: 'pointer-events-none group-hover:opacity-100', why: 'an explanatory tooltip, not a control' },
  { file: 'packages/review-editor/components/PRChecksTab.tsx', marker: 'text-muted-foreground/30 ml-auto', why: 'an external-link glyph inside a row that is itself the link' },
  { file: 'packages/ui/components/ResizeHandle.tsx', marker: 'group-hover/handle:opacity-100', why: 'a grip drawing on the panel edge; the edge drags and Mod+B hides the panel without it' },
];

const GROUP_HOVER_OPACITY = /\bgroup-hover(?:\/[\w-]+)?:opacity-(\d+)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

/** Every quoted or template string on a line that carries a group-hover reveal. */
function revealStrings(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split('\n')) {
    for (const match of line.matchAll(/(["'`])((?:(?!\1).)*)\1/g)) {
      if (GROUP_HOVER_OPACITY.test(match[2])) found.push(match[2]);
    }
  }
  return found;
}

describe('controls revealed on hover have a path without hover (#2062)', () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(resolve(root, dir)));
  const reveals = files.flatMap((path) => {
    const file = relative(root, path);
    return revealStrings(readFileSync(path, 'utf8')).map((classes) => ({ file, classes }));
  });

  test('the scan finds the controls it guards', () => {
    // A rename or a reformatting that hides the class strings from the scan
    // would otherwise turn this whole file into a silent pass.
    expect(reveals.some((r) => r.file.endsWith('CommentActions.tsx'))).toBe(true);
    expect(reveals.length).toBeGreaterThan(10);
  });

  test('every decorative exemption still matches a class string', () => {
    for (const { file, marker } of DECORATIVE) {
      expect(reveals.some((r) => r.file === file && r.classes.includes(marker))).toBe(true);
    }
  });

  test('each one is also shown under (hover: none) and on keyboard focus', () => {
    const missing: string[] = [];
    for (const { file, classes } of reveals) {
      if (DECORATIVE.some((d) => d.file === file && classes.includes(d.marker))) continue;
      const opacity = classes.match(GROUP_HOVER_OPACITY)![1];
      const noHover = classes.includes(`[@media(hover:none)]:opacity-${opacity}`);
      const keyboard = /\b(?:group-)?focus-(?:within|visible)(?:\/[\w-]+)?:opacity-\d+/.test(classes);
      if (!noHover || !keyboard) {
        missing.push(`${file}: ${!noHover ? 'no (hover: none) reveal' : 'no keyboard reveal'} in "${classes}"`);
      }
    }
    expect(missing).toEqual([]);
  });
});
