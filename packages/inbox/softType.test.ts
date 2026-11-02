/**
 * The Inbox's one type knob, --ib-type (inbox.css): the window's body size in
 * px, the person's Settings → General → Text size (12, 13, 14 or 15, 14 by
 * default; textSize.ts sets `--inbox-text-size` on the document, and nothing
 * at 14). Every size the window sets goes through one scale token,
 * `var(--ib-fs-N, Npx)` with `--ib-fs-N: max(<floor>, calc(Npx * var(--ib-type) / 14))`,
 * so the setting moves the whole window together and, at 14, each size is
 * exactly today's.
 *
 * What this catches: a rule added with a bare `font-size: 13px` (it would not
 * follow the setting), a token whose number differs from its fallback (14
 * would no longer be today's), a token without its floor (11 px, or its own
 * size when that is smaller), a default other than 14, and a phone input
 * scaled under 16 px (iOS zooms). The same file holds the layout corners' one
 * scale and the rows' switch, checked at the end.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
/** inbox.css with its comments blanked, offsets kept. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));

/** For each offset, whether it sits inside an @media block. */
function mediaMask(code: string): boolean[] {
  const mask: boolean[] = new Array(code.length).fill(false);
  const stack: boolean[] = [];
  let headerStart = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') {
      stack.push(code.slice(headerStart, i).trim().startsWith('@media'));
      headerStart = i + 1;
    } else if (ch === '}') {
      stack.pop();
      headerStart = i + 1;
    } else if (ch === ';') headerStart = i + 1;
    mask[i] = stack.includes(true);
  }
  return mask;
}

/** A token's definition worked out at body size `type`, in px (the `max(Apx, calc(Bpx * var(--ib-type) / 14))` shape only). */
function sizeAt(token: string, type: number): number {
  const def = new RegExp(`${token}:\\s*max\\(([\\d.]+)px,\\s*calc\\(([\\d.]+)px \\* var\\(--ib-type\\) / 14\\)\\);`).exec(CODE);
  if (!def) throw new Error(`${token} is not a scale token`);
  return Math.max(Number(def[1]), (Number(def[2]) * type) / 14);
}

test('the body size is 14 unless the page sets one: today\'s sizes', () => {
  expect(CODE).toMatch(/--ib-type:\s*var\(--inbox-text-size,\s*14\);/);
  // The Soft type switch it replaced is gone, so nothing else moves the type.
  expect(CODE).not.toMatch(/--ib-soft-type/);
});

test('every size goes through its scale token, and the fallback is the same size', () => {
  const mask = mediaMask(CODE);
  const bare: string[] = [];
  for (const m of CODE.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px(\s*!important)?/g)) {
    if (m[2]) continue;
    bare.push(`${m[0]} at ${CODE.slice(0, m.index).split('\n').length}`);
  }
  expect(bare).toEqual([]);
  const uses = [...CODE.matchAll(/font-size:\s*var\(--ib-fs-([\d-]+),\s*([\d.]+)px\)/g)];
  expect(uses.length).toBeGreaterThan(350);
  for (const use of uses) expect(use[1]!.replace('-', '.')).toBe(use[2]);
  // A phone's 16 px controls take the token that never goes under 16 px, inside @media only.
  for (const use of CODE.matchAll(/var\(--ib-fs-16-in, 16px\)/g)) expect(mask[use.index!]).toBe(true);
});

test('each scale token is its own size at 14, scales with the body size, and never goes under 11 px (or its own size)', () => {
  const used = new Set([...CODE.matchAll(/var\(--ib-fs-([\d]+(?:-\d+)?),/g)].map((m) => m[1]!));
  expect(used.size).toBeGreaterThan(15);
  for (const name of used) {
    const size = Number(name.replace('-', '.'));
    expect(sizeAt(`--ib-fs-${name}`, 14)).toBe(size);
    expect(sizeAt(`--ib-fs-${name}`, 15)).toBeCloseTo((size * 15) / 14, 6);
    for (const type of [12, 13]) {
      expect(sizeAt(`--ib-fs-${name}`, type)).toBeCloseTo(Math.max(Math.min(size, 11), (size * type) / 14), 6);
    }
  }
  // A timestamp's 12 px is 11 at 12 (floored), 13 px is 12 at 13 (scaled).
  expect(sizeAt('--ib-fs-12', 12)).toBe(11);
  expect(sizeAt('--ib-fs-13', 13)).toBeCloseTo(12.07, 2);
  // Phone inputs: 16 px at 12, 13 and 14, larger at 15.
  for (const type of [12, 13, 14]) expect(sizeAt('--ib-fs-16-in', type)).toBe(16);
  expect(sizeAt('--ib-fs-16-in', 15)).toBeGreaterThan(16);
});

test("ui's drawing follows the knob: Tailwind's type scale and its fixed sizes, in a layer after the utilities", () => {
  for (const [name, rem] of [['sm', '0.875'], ['base', '1'], ['lg', '1.0625'], ['xl', '1.1875'], ['2xl', '1.375']] as const) {
    expect(CODE).toMatch(new RegExp(`--text-${name}:\\s*calc\\(${rem.replace('.', '\\.')}rem \\* var\\(--ib-type\\) / 14\\);`));
  }
  // text-xs scales too, never under 11 px.
  expect(CODE).toMatch(/--text-xs:\s*max\(11px,\s*calc\(0\.75rem \* var\(--ib-type\) \/ 14\)\);/);
  // Code blocks (Plannotator's fence, copied here) follow it too.
  expect(CODE).toMatch(/pre code\.pn-code \{[^}]*font-size: var\(--ib-fs-13, 0\.8125rem\);/);
  const layer = /@layer ib-type \{([\s\S]*?)\n\}/.exec(CODE)?.[1] ?? '';
  for (const size of ['12.5', '13', '13.5', '14', '15']) {
    const cls = size.replace('.', '\\\\.');
    expect(layer).toMatch(new RegExp(`\\.pn-inbox \\.text-\\\\\\[${cls}px\\\\\\] \\{ font-size: var\\(--ib-fs-${size.replace('.', '-')}, ${size.replace('.', '\\.')}px\\); \\}`));
  }
});

test('layout corners are one scale; buttons keep their own', () => {
  for (const [token, px] of [['pane', 10], ['xl', 12], ['lg', 10], ['md', 9], ['sm', 8], ['xs', 7]] as const) {
    expect(CODE).toMatch(new RegExp(`--ib-lr-${token}:\\s*${px}px;`));
  }
  expect(CODE).toMatch(/--ib-pane-r-s:\s*var\(--ib-soft-panes\)\s*var\(--ib-lr-pane\);/);
  // The list's row pills, a section band, a tile and a dialog read the scale.
  expect(CODE).toMatch(/:is\(\.ib-row, \.ib-nrow\)::before \{ border-radius: var\(--ib-rl-sm-s, 8px\); \}/);
  expect(CODE).toMatch(/--ib-band-r-s:\s*var\(--ib-soft-band\)\s*var\(--ib-lr-sm\);/);
  expect(CODE).toMatch(/--ib-sf-r14-s:\s*var\(--ib-soft-surfaces\)\s*var\(--ib-lr-lg\);/);
  expect(CODE).toMatch(/dialog\.ib-dlg \{[^}]*border-radius: var\(--ib-rl-xl-s, 12px\)/);
  // The header's buttons, the foot's pills and the window's buttons keep theirs.
  expect(CODE).toMatch(/\.pn-inbox \.ib-hbtn \{[^}]*border-radius: var\(--ib-r10-s, 7px\)/);
  expect(CODE).toMatch(/--ib-ft-r-s:\s*var\(--ib-soft-foot\)\s*999px;/);
  expect(CODE).toMatch(/--ib-bt-r-s:\s*var\(--ib-soft-buttons\)\s*10px;/);
});

test("a phone's bottom sheet has the dialog corner on top (owner's ruling q8), from one token", () => {
  expect(CODE).toMatch(/--ib-sheet-corner:\s*var\(--ib-lr-xl\);/);
  // A sheet from the bottom edge (in the phone query) rounds only its top corners: it reads the token, never a
  // literal (it was 16), so a new sheet cannot bring another corner back.
  const media = mediaMask(CODE);
  const literalTop = [...CODE.matchAll(/border-radius:\s*(\d+px\s+\d+px\s+0(?:px)?\s+0(?:px)?)/g)]
    .filter((m) => media[m.index!])
    .map((m) => m[1]);
  expect(literalTop).toEqual([]);
  expect(CODE.match(/border-radius: var\(--ib-sheet-corner, 12px\) var\(--ib-sheet-corner, 12px\) 0 0/g)?.length).toBeGreaterThanOrEqual(3);
});

test('rows part with no line between them in both modes (the prototype\'s rows); other lines keep today\'s colour', () => {
  // The window's token blocks also name the list options dialog's light picture (`.ib-lightscope`).
  expect(CODE).toMatch(/\.pn-inbox, \.ib-lightscope \{[^}]*--ib-soft-rows:\s*;/);
  const light = /:root\.light \.pn-inbox,\s*\.ib-lightscope\.light \{([^}]*)\}/.exec(CODE)?.[1] ?? '';
  expect(light).toContain('--ib-soft-nav');
  expect(light).not.toContain('--ib-soft-rows');
  expect(CODE).toMatch(/--ib-row-line-s:\s*var\(--ib-soft-rows\)\s*transparent;/);
  expect(CODE).toMatch(/\.ib-row, \.ib-nrow \{ border-bottom-color: var\(--ib-row-line\); \}/);
  // Every other line keeps today's colour: its faint fill has a switch of its own, off.
  expect(CODE).toMatch(/--ib-soft-lines:\s*initial;/);
  expect(CODE).toMatch(/--ib-sep-s:\s*var\(--ib-soft-lines\)\s*var\(--ib-fill\);/);
  expect(CODE).not.toMatch(/var\(--ib-soft-rows\)\s*var\(--ib-fill\)/);
});
