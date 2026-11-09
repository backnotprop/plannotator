/**
 * Guards the Call Flow tree-line geometry in every mode the stylesheet has.
 *
 * The elbow from a caller's marker into a child row is
 * `indent - toggle - marker / 2` wide. When an override makes that negative,
 * the child's toggle cell starts left of the caller's line: leaf connectors
 * cross the line, elbows vanish and chevrons sit on it. This resolves the
 * `--call-flow-*` variables the way the cascade does for each combination
 * of Dock or Lens, fine or coarse pointer, and wide or narrow viewport.
 *
 * A coarse pointer keeps the toggle column narrow and grows only the toggle
 * button's touch area (`::after`). That area must be placed around the
 * chevron and end where the marker cell ends, so it never covers the call
 * (comment) or its file:line chip (open the file).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Declaration {
  readonly media: string | null;
  readonly selectors: readonly string[];
  readonly name: string;
  readonly value: string;
}

/** Every declaration in a style rule, in file order, with its selectors and @media. */
function declarations(css: string): Declaration[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  const flush = () => {
    const text = buffer.trim();
    buffer = '';
    const selector = stack[stack.length - 1];
    const colon = text.indexOf(':');
    if (!selector || selector.startsWith('@') || colon <= 0) return;
    found.push({
      media: [...stack].reverse().find((prelude) => prelude.startsWith('@media')) ?? null,
      selectors: selector.split(',').map((part) => part.trim()),
      name: text.slice(0, colon).trim(),
      value: text.slice(colon + 1).trim(),
    });
  };
  for (const char of source) {
    if (char === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (char === '}') {
      flush();
      stack.pop();
    } else if (char === ';') {
      flush();
    } else {
      buffer += char;
    }
  }
  return found;
}

function px(value: string): number | null {
  const match = value.match(/^([\d.]+)(px|rem)$/);
  return match ? Number(match[1]) * (match[2] === 'rem' ? 16 : 1) : null;
}

interface Mode {
  readonly compact: boolean;
  readonly coarse: boolean;
  readonly narrow: boolean;
}

function mediaActive(media: string | null, mode: Mode): boolean {
  if (!media) return true;
  return (media.includes('pointer: coarse') && mode.coarse)
    || (media.includes('max-width') && mode.narrow);
}

/** The `--call-flow-*` lengths in effect on a tree in this mode. */
function resolveGeometry(all: readonly Declaration[], mode: Mode): Map<string, number> {
  const values = new Map<string, number>();
  for (const declaration of all) {
    if (!declaration.name.startsWith('--call-flow-')) continue;
    const length = px(declaration.value);
    if (length === null) continue;
    const applies = declaration.selectors.includes('.call-flow-trees')
      || (mode.compact && declaration.selectors.includes('.call-flow-trees-compact'));
    if (!applies || !mediaActive(declaration.media, mode)) continue;
    // Every selector here is one class, so the later declaration wins.
    values.set(declaration.name, length);
  }
  return values;
}

/** Declarations of one exact selector that apply in this mode, later ones winning. */
function ruleFor(all: readonly Declaration[], selector: string, mode: Mode): Map<string, string> {
  const values = new Map<string, string>();
  for (const declaration of all) {
    if (declaration.selectors.includes(selector) && mediaActive(declaration.media, mode)) {
      values.set(declaration.name, declaration.value);
    }
  }
  return values;
}

const all = declarations(readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8'));
const modes: Mode[] = [];
for (const compact of [false, true]) {
  for (const coarse of [false, true]) {
    for (const narrow of [false, true]) modes.push({ compact, coarse, narrow });
  }
}
const label = (mode: Mode) => `${mode.compact ? 'Lens' : 'Dock'}, ${mode.coarse ? 'coarse' : 'fine'} pointer, ${mode.narrow ? 'narrow' : 'wide'}`;

describe('Call Flow tree-line geometry', () => {
  test('the stylesheet declares the geometry the lines are drawn from', () => {
    const dock = resolveGeometry(all, { compact: false, coarse: false, narrow: false });
    for (const name of ['--call-flow-indent', '--call-flow-toggle', '--call-flow-marker-cell', '--call-flow-row-height']) {
      expect(dock.get(name)).toBeGreaterThan(0);
    }
  });

  for (const mode of modes) {
    test(`a child starts right of its caller's line (${label(mode)})`, () => {
      const values = resolveGeometry(all, mode);
      const indent = values.get('--call-flow-indent')!;
      const toggle = values.get('--call-flow-toggle')!;
      const marker = values.get('--call-flow-marker-cell')!;
      // The elbow's width; at or below zero it collapses and the child crosses the line.
      expect(indent - toggle - marker / 2).toBeGreaterThan(0);
    });
  }
});

describe('Call Flow toggle touch area', () => {
  test('the toggle is its own containing block, so the touch area is placed around the chevron', () => {
    for (const mode of modes) {
      expect(ruleFor(all, '.call-flow-expand', mode).get('position')).toBe('relative');
    }
  });

  for (const mode of modes.filter((candidate) => candidate.coarse)) {
    test(`on a coarse pointer it is 44px and ends where the marker cell ends (${label(mode)})`, () => {
      const area = ruleFor(all, 'button.call-flow-expand::after', mode);
      expect(area.get('position')).toBe('absolute');
      // Right edge: the toggle's right edge plus the marker cell, i.e. where
      // the call's comment button starts. Never past it, onto the call or its chip.
      expect(area.get('right')).toBe('calc(-1 * var(--call-flow-marker-cell))');
      expect(area.has('left')).toBe(false);
      expect(px(area.get('width') ?? '')).toBeGreaterThanOrEqual(44);
      // The marker cell under it takes no taps, so they reach the toggle.
      expect(ruleFor(all, '.call-flow-status', mode).get('pointer-events')).toBe('none');
    });
  }

  test('a fine pointer gets no enlarged touch area', () => {
    const area = ruleFor(all, 'button.call-flow-expand::after', { compact: false, coarse: false, narrow: false });
    expect(area.size).toBe(0);
  });
});
