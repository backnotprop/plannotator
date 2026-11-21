/**
 * Every class the frame writes must make a rule once a host imports theme.css
 * and frame.css: a `frame-*` theme name Tailwind does not accept fails silently
 * in a browser. The classes are read from the folder's source (constants, cva
 * variants and conditional branches included) and compiled one at a time.
 * Also: the frame's `cn` must keep a `text-frame-*` size next to a text colour.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'tailwindcss';
import ts from 'typescript';
import { cn } from './lib/utils';
import { fileIcon } from './rail/fileIcons';
import { CARD_MOTIONS } from './card/motions';

const folder = import.meta.dir;
const frameCss = readFileSync(join(folder, 'frame.css'), 'utf8');
const motionsCss = readFileSync(join(folder, 'card', 'motions.css'), 'utf8');

/** Plain classes frame.css styles itself, and Tailwind group markers: no utility rule is expected. */
const NOT_UTILITIES = new Set([
  'frame-scrim',
  'frame-sheet',
  'frame-sheet-overlay',
  'frame-tooltip',
  'collapsible-edge',
  'frame-card-sheet',
  'frame-card-window',
  'frame-card-window-bar',
  'frame-card-window-body',
  'frame-card-panel',
  'frame-card-panel-rows',
  'frame-card-document',
  'frame-card-arrive',
  'frame-card-arrive-tint',
  'frame-card-breathe',
  'frame-card-settle',
  'frame-card-fan',
  'frame-card-open',
]);

async function loadStylesheet(id: string, base: string) {
  const path = id.startsWith('.')
    ? resolve(base, id)
    : Bun.resolveSync(id === 'tailwindcss' ? 'tailwindcss/index.css' : id, folder);
  return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
}

async function compileHost() {
  const entry = '@import "tailwindcss";\n@import "../../theme.css";\n@import "./frame.css";\n';
  return compile(entry, { base: folder, loadStylesheet });
}

function sources(): ts.SourceFile[] {
  return readdirSync(folder, { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) =>
      ts.createSourceFile(name, readFileSync(join(folder, name), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    );
}

function constants(files: ts.SourceFile[]): Map<string, ts.Expression> {
  const found = new Map<string, ts.Expression>();
  for (const file of files) {
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          found.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  return found;
}

function literals(node: ts.Node, named: Map<string, ts.Expression>, seen: Set<string>, out: string[]) {
  if (ts.isStringLiteralLike(node)) {
    out.push(node.text);
    return;
  }
  if (ts.isIdentifier(node)) {
    const value = named.get(node.text);
    if (value && !seen.has(node.text)) {
      seen.add(node.text);
      literals(value, named, seen, out);
    }
    return;
  }
  // cva's defaults name variants, not classes.
  if (ts.isPropertyAssignment(node) && node.name.getText() === 'defaultVariants') return;
  if (ts.isConditionalExpression(node)) {
    literals(node.whenTrue, named, seen, out);
    literals(node.whenFalse, named, seen, out);
    return;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    literals(node.right, named, seen, out);
    return;
  }
  ts.forEachChild(node, (child) => literals(child, named, seen, out));
}

function frameClasses(): Set<string> {
  const files = sources();
  const named = constants(files);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText() === 'className' && node.initializer) {
      literals(node.initializer, named, new Set(), out);
    }
    if (ts.isCallExpression(node) && node.expression.getText() === 'cn') {
      literals(node, named, new Set(), out);
    }
    ts.forEachChild(node, visit);
  };
  files.forEach(visit);
  return new Set(out.flatMap((text) => text.split(/\s+/)).filter(Boolean));
}

async function classesWithNoRule(classes: Iterable<string>) {
  const { build } = await compileHost();
  let sheet = build([]);
  const missing: string[] = [];
  for (const name of classes) {
    const next = build([name]);
    if (next === sheet) missing.push(name);
    sheet = next;
  }
  return missing;
}

describe('frame classes compile with theme.css and frame.css', () => {
  const classes = frameClasses();
  const utilities = [...classes].filter((name) => !NOT_UTILITIES.has(name) && !name.startsWith('group/'));

  test('the reader sees the folder, through constants, cva and branches', () => {
    expect(classes.size).toBeGreaterThan(100);
    expect(classes).toContain('text-frame-sm');
    expect(classes).toContain('h-frame-row');
    expect(classes).toContain('rounded-t-frame-dialog');
    expect(classes).toContain('frame-dark:bg-background/80');
    expect(classes).not.toContain('default');
  });

  test('the plain classes left out above are styled by frame.css', () => {
    for (const name of NOT_UTILITIES) expect(frameCss + motionsCss).toContain(`.${name}`);
  });

  test('a made-up frame class is caught, so a pass below means something', async () => {
    expect(await classesWithNoRule(['text-frame-nope', 'rounded-frame-nope'])).toEqual(['text-frame-nope', 'rounded-frame-nope']);
  });

  test('none is left without a rule', async () => {
    expect(await classesWithNoRule(utilities)).toEqual([]);
  }, 60_000);
});

describe('the frame cn', () => {
  test('keeps a frame text size next to a text colour, and the later of two sizes', () => {
    expect(cn('text-frame-sm', 'text-muted-foreground')).toBe('text-frame-sm text-muted-foreground');
    expect(cn('text-frame-sm', 'text-frame-xs')).toBe('text-frame-xs');
    expect(cn('rounded-frame-pane', 'rounded-md')).toBe('rounded-md');
  });
});

describe('theme colours opt-in', () => {
  const MIXED_TOKENS = ['--frame-border-subtle', '--frame-selected', '--frame-surface-hover'];
  const OPT_IN_TOKENS = [...MIXED_TOKENS, '--frame-selected-fg'].sort();

  /** The custom properties a rule with exactly this selector list sets in frame.css. */
  function declared(selector: string): Record<string, string> {
    const rule = frameCss.split('}').find((block) => block.split('{')[0].replace(/\/\*[\s\S]*?\*\//g, '').trim() === selector);
    expect(rule).toBeDefined();
    const body = rule!.split('{')[1];
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
  }

  test('dark and light each derive the same tokens from the theme, selected text on the foreground, and the fixed defaults stay on :root', () => {
    const dark = declared('[data-frame-colors="theme"]');
    const light = declared('.light[data-frame-colors="theme"],\n.light [data-frame-colors="theme"]');
    for (const tokens of [dark, light]) {
      expect(Object.keys(tokens).sort()).toEqual(OPT_IN_TOKENS);
      for (const name of MIXED_TOKENS) {
        expect(tokens[name]).toMatch(/^color-mix\(in oklch, var\(--(primary|foreground)\) [\d.]+%, transparent\)$/);
      }
      // Only the fill carries the accent: a theme's primary as text can fall under 4.5:1.
      expect(tokens['--frame-selected-fg']).toBe('var(--foreground)');
    }
    const root = declared(':root');
    for (const name of MIXED_TOKENS) expect(root[name]).toMatch(/^oklch\(/);
    expect(root['--frame-selected-fg']).toBe('oklch(0.72 0.15 280)');
    expect(declared('.light')['--frame-selected-fg']).toBe('oklch(0.50 0.25 280)');
  });
});

describe('the versions sheet', () => {
  test('a panel inside it fills the sheet at every width: the sheet rule outranks the panel\'s md:w-72', async () => {
    const sheet = readFileSync(join(folder, 'sheets', 'VersionsSheet.tsx'), 'utf8');
    expect(sheet).toContain('[&_[data-versions-panel]]:w-full');
    expect(sheet).toContain('[&_[data-versions-panel]]:border-l-0');
    const { build } = await compileHost();
    const css = build(['[&_[data-versions-panel]]:w-full', 'md:w-72']);
    const fill = css.match(/\.\\\[\\&_\\\[data-versions-panel\\\]\\\]\\:w-full \[data-versions-panel\] \{\s*width: 100%;/);
    expect(fill).not.toBeNull();
  });
});

describe('card motions', () => {
  const css = motionsCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));

  test('every named motion is a class in motions.css, and under reduced motion none of them moves', () => {
    expect(reduced.length).toBeGreaterThan(100);
    for (const name of Object.values(CARD_MOTIONS)) {
      expect(css).toContain(`.${name}`);
      expect(reduced).toContain(name);
    }
    expect(reduced).toMatch(/\.frame-card-breathe,[\s\S]*?\{\s*animation: none;\s*\}/);
    expect(reduced).toMatch(/\.frame-card-fan,\s*\[data-frame-card-hero\],\s*\[data-frame-card\] \{\s*transition: none;\s*\}/);
    expect(reduced).toMatch(/::view-transition-new\(\*\.frame-card-open\) \{\s*animation: none;\s*\}/);
    const animated = [...reduced.matchAll(/([^{}]+)\{\s*animation: none;/g)].map(([, selectors]) => selectors).join(',');
    for (const name of ['.frame-card-breathe', '.frame-card-settle', '.frame-card-arrive,', '.frame-card-arrive > *', '.frame-card-arrive-tint']) expect(animated).toContain(name);
  });

  test('arrive ends at the line\'s own state: it is shown by default and only its animations start hidden', () => {
    const rule = (selector: string) => css.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*>]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.frame-card-arrive')).toContain('grid-template-rows: 1fr;');
    expect(rule('.frame-card-arrive')).toMatch(/animation: frame-card-arrive-open [^;]* both;/);
    expect(rule('.frame-card-arrive > *')).not.toContain('opacity');
    expect(rule('.frame-card-arrive > *')).toMatch(/animation: frame-card-fade-in [^;]* both;/);
    expect(css).not.toMatch(/\.frame-card-arrive[^{]*\{[^}]*(opacity: 0|grid-template-rows: 0fr)/);
  });

  test('idle, only breathe loops, and its timings are custom properties in one place', () => {
    const loops = [...css.matchAll(/animation:[^;]*infinite/g)];
    expect(loops.length).toBe(1);
    expect(loops[0]![0]).toContain('frame-card-breathe');
    for (const name of ['--frame-card-ease', '--frame-card-fan-duration', '--frame-card-breathe-duration', '--frame-card-arrive-open-duration', '--frame-card-arrive-tint-duration', '--frame-card-settle-duration', '--frame-card-open-duration']) {
      expect([...css.matchAll(new RegExp(`${name}:`, 'g'))].length).toBe(1);
    }
    expect(css).toContain('--frame-card-ease: cubic-bezier(0.22, 1, 0.36, 1);');
  });

  test('the card styles only its own data-frame-card attributes, so a host attribute such as data-card-back is left alone', () => {
    expect(frameCss + motionsCss).not.toMatch(/\[data-card[-\]=]/);
    expect(frameCss + motionsCss).toContain('[data-frame-card-back]');
  });

  test('frame.css brings the card styles and motions with it, so a host scanning only frame.css gets them', async () => {
    const { build } = await compileHost();
    const out = build([]);
    expect(out).toContain('frame-card-breathe');
    expect(out).toContain('.frame-card-document');
    expect(out).toContain('[data-frame-card-back]');
  });
});

describe('host tokens', () => {
  test('frame.css sets only --frame-* properties and frame-* theme names, never a host token', () => {
    const names = [...(frameCss + motionsCss).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name);
    expect(names.length).toBeGreaterThan(40);
    const foreign = names.filter((name) => !/^--frame-/.test(name) && !/^--(text|spacing|ease|color|shadow|radius)-frame-/.test(name));
    expect(foreign).toEqual([]);
  });
});

describe('layout and icons for host requests', () => {
  test('the rail tab column is not drawn as a card', () => {
    expect(frameCss).toMatch(/\[data-frame-row\] > :not\([^)]*\[data-rail-flags\][^)]*\)/);
  });

  test('html, mermaid and graphviz files get their own neutral marks, by kind or by extension', () => {
    const plain = fileIcon({ path: 'notes.txt' });
    const marks = ['html', 'mermaid', 'graphviz'].map((kind) => fileIcon({ kind }));
    for (const mark of marks) expect(mark).not.toBe(plain);
    expect(new Set(marks).size).toBe(3);
    expect(fileIcon({ path: 'site/index.html' })).toBe(marks[0]);
    expect(fileIcon({ path: 'flow.mmd' })).toBe(marks[1]);
    expect(fileIcon({ path: 'graph.dot' })).toBe(marks[2]);
  });
});

describe('card layout rules in frame.css', () => {
  const css = frameCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (selector: string, from = css) => {
    const at = from.indexOf(`${selector} {`);
    return at < 0 ? '' : from.slice(at, from.indexOf('}', at));
  };
  const phone = (() => {
    const blocks = [...css.matchAll(/@media \(max-width: 767px\) \{([\s\S]*?\n)\}/g)].map(([, body]) => body!);
    return blocks.join('\n');
  })();

  test('a row keeps its title: at least 40% of the row (112 px at the least), the project gives way first, then the trailing text', () => {
    expect(block('[data-frame-card-row]')).toContain('--frame-card-row-title-min: max(112px, 40%);');
    expect(block('[data-frame-card-row]')).toContain('grid-template-columns: 36px minmax(var(--frame-card-row-title-min), 1fr) minmax(clamp(0px, 100% - 64px - var(--frame-card-row-title-min), 180px), 180px);');
    expect(block('[data-frame-card-row][data-frame-card-columns~="secondary"]')).toContain('grid-template-columns: 36px minmax(var(--frame-card-row-title-min), 1fr) minmax(20px, 160px) minmax(clamp(0px, 100% - 98px - var(--frame-card-row-title-min), 180px), 180px);');
    const columns = [...css.matchAll(/([^{}]+)\{[^{}]*grid-template-columns: ([^;]+);[^{}]*\}/g)].filter(([, selector]) => selector!.includes('[data-frame-card-row]')).map(([, , value]) => value!);
    for (const value of columns) expect(value).toMatch(/^36px minmax\((0|var\(--frame-card-row-title-min\)), 1fr\) /);
    for (const value of columns) expect(value).not.toMatch(/ (160|180)px( |$)/);
  });

  test('a list shows a project whole or not at all: under the width where 160 px of project and the title at 40% fit, it drops the project and keeps the trailing text aligned', () => {
    expect(block('[data-frame-card-rows]')).toContain('container: frame-card-rows / inline-size;');
    const rowPadding = 6 + 10, thumb = 36, project = 160, trailing = 180, gaps = 3 * 14, titleShare = 0.4;
    const threshold = Math.ceil(rowPadding + (thumb + project + trailing + gaps) / (1 - titleShare));
    expect(threshold).toBe(713);
    const at = css.indexOf(`@media (min-width: 768px) {\n  @container frame-card-rows (width < ${threshold}px) {`);
    expect(at).toBeGreaterThan(-1);
    const narrow = css.slice(at, css.indexOf('\n}\n', at));
    expect(block('    [data-frame-card-row][data-frame-card-columns~="secondary"]', narrow)).toContain('grid-template-columns: 36px minmax(var(--frame-card-row-title-min), 1fr) minmax(clamp(0px, 100% - 64px - var(--frame-card-row-title-min), 180px), 180px);');
    expect(block('[data-frame-card-row]')).toContain('grid-template-columns: 36px minmax(var(--frame-card-row-title-min), 1fr) minmax(clamp(0px, 100% - 64px - var(--frame-card-row-title-min), 180px), 180px);');
    expect(narrow).not.toMatch(/fit-content|auto\b|min-content|max-content/);
    expect(block('    [data-frame-card-row] [data-frame-card-secondary]', narrow)).toContain('display: none;');
    expect(block('    [data-frame-card-row][data-frame-card-columns~="action"] > :nth-child(2)', narrow)).toContain('padding-inline-end: 20px;');
    expect(narrow).not.toMatch(/hover|focus|pinned|action-rest/);
    expect(css.indexOf('@container')).toBeLessThan(css.indexOf('@media (max-width: 767px) {\n  [data-frame-card-row] {'));
  });

  test('a row is 44 px tall and 52 on a phone; under 768 px the secondary text is hidden', () => {
    expect(block('[data-frame-card-row]')).toContain('height: 44px;');
    expect(block('[data-frame-card-row]', phone)).toContain('height: 52px;');
    expect(block('[data-frame-card-row] [data-frame-card-secondary]', phone)).toContain('display: none;');
    expect(block('  [data-frame-card-row]', phone)).toContain('grid-template-columns: 36px minmax(0, 1fr) fit-content(50%);');
    expect(block('  [data-frame-card-row][data-frame-card-columns~="secondary"]', phone)).toContain('grid-template-columns: 36px minmax(0, 1fr) fit-content(50%);');
    expect(css).not.toMatch(/max-width: 639px|max-width: 640px/);
  });

  test('a card title takes two lines then an ellipsis; a row title one line', () => {
    expect(block('[data-frame-card] [data-frame-card-title]')).toContain('-webkit-line-clamp: 2;');
    const row = block('[data-frame-card-row] [data-frame-card-title]');
    expect(row).toContain('white-space: nowrap;');
    expect(row).toContain('text-overflow: ellipsis;');
  });

  test('cards fill fluid columns with a minimum width, and a phone shows one column', () => {
    expect(block('[data-frame-card-grid="large"]')).toMatch(/repeat\(auto-fill, minmax\(280px, 1fr\)\)/);
    expect(block('[data-frame-card-grid="regular"]')).toMatch(/repeat\(auto-fill, minmax\(230px, 1fr\)\)/);
    expect(phone).toMatch(/\[data-frame-card-groups\] \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(block('[data-frame-card-groups]')).toContain('gap: 44px 24px;');
    expect(block('[data-frame-card-groups]')).toContain('--frame-card-column-min: 230px;');
    expect(block('[data-frame-card-groups]')).toContain('grid-auto-flow: row;');
    expect(css).not.toMatch(/grid-auto-flow:[^;]*dense/);
    expect(block('[data-frame-card-groups]')).toMatch(/repeat\(auto-fill, minmax\(var\(--frame-card-column-min\), 1fr\)\)/);
  });

  test('focus on the link draws a 2 px gap in the card colour, then a 2 px primary ring', () => {
    expect(block('[data-frame-card]:has(:focus-visible:not([data-frame-card-action] *))')).toContain('box-shadow: 0 0 0 2px var(--card), 0 0 0 4px var(--primary);');
  });

  test('focus on the host action draws no card ring and does not fan the sheet', () => {
    const ring = /\[data-frame-card\]:has\(:focus-visible:not\(\[data-frame-card-action\] \*\)\) \{/;
    expect(css).toMatch(ring);
    expect(css).not.toMatch(/\[data-frame-card\]:has\(:focus-visible\)/);
    expect(motionsCss).not.toMatch(/:has\(:focus-visible\)/);
    expect(motionsCss).toContain('\n[data-frame-card]:has(:focus-visible:not([data-frame-card-action] *)) .frame-card-fan {');
  });

  test('the updates pill shows a pointer and is 20 px tall, the heading line, with a 24 px hit area that takes no room', () => {
    expect(block('[data-frame-card-updates]')).toContain('cursor: pointer;');
    expect(block('[data-frame-card-updates]')).toContain('height: 20px;');
    expect(block('[data-frame-card-updates]')).toContain('position: relative;');
    expect(block('[data-frame-card-updates]::after')).toContain('inset: -2px 0;');
    expect(block('[data-frame-card-updates]::after')).toContain('position: absolute;');
  });

  test('the kind tints apply only to a ready face, so an empty card well or row thumbnail stays on the neutral ground', () => {
    const tints = [...css.matchAll(/([^{}]*)\{[^{}]*--frame-card-ground: color-mix\(in (oklab|oklch), var\(--(primary|warning|success)|([^{}]*)\{[^{}]*--frame-card-ground: color-mix\(in oklch, var\(--foreground\) 5%/g)].map(([rule]) => rule!);
    expect(tints.length).toBe(7);
    for (const rule of tints) expect(rule).toContain('[data-frame-card-face="ready"]');
    expect(block('[data-frame-card-well]')).toContain('--frame-card-ground: color-mix(in oklch, var(--foreground) 4%, var(--card));');
  });

  test('a row title is regular weight; a card title stays medium', () => {
    expect(block('[data-frame-card-row] [data-frame-card-title]')).toContain('font-weight: 400;');
    expect(block('[data-frame-card-title]')).toContain('font-weight: 500;');
  });

  test('a row thumbnail keeps the card well geometry, so a sheet, window or table runs off its bottom edge', () => {
    expect(block('.frame-card-sheet')).toContain('inset: 10% 10% -14px;');
    expect(block('.frame-card-window')).toContain('inset: 9% 8% -10px;');
    expect(block('.frame-card-panel-rows')).toContain('bottom: -10px;');
    expect(block('[data-frame-card-thumb] .frame-card-sheet')).toContain('bottom: -2px;');
    expect(css).not.toMatch(/\[data-frame-card-thumb\][^{]*\{[^}]*\binset:/);
  });

  test('in rows the page window keeps its bar but hides the dots; on cards the bar and dots stay', () => {
    expect(block('.frame-card-window-bar')).toContain('height: 16px;');
    expect(block('.frame-card-window-bar > i')).toContain('width: 5px;');
    expect(block('[data-frame-card-thumb] .frame-card-window-bar')).toContain('height: 3px;');
    expect(block('[data-frame-card-thumb] .frame-card-window-bar > i')).toContain('display: none;');
  });

  test('a row never moves: no rule changes its columns for a pin, and the action shows just before the trailing text on hover or keyboard focus only', () => {
    const columnRules = [...css.matchAll(/([^{}]+)\{([^{}]*grid-template-columns[^{}]*)\}/g)].map(([, selector]) => selector!).filter((selector) => selector.includes('[data-frame-card-row]'));
    for (const selector of columnRules) {
      expect(selector).not.toContain('pinned');
      expect(selector).not.toContain('data-frame-card-columns~="action"');
    }
    expect(block('[data-frame-card-trail] > [data-frame-card-action]')).toContain('position: absolute;');
    expect(block('[data-frame-card-trail] > [data-frame-card-action]')).toContain('right: calc(100% + 6px);');
    expect(css).not.toMatch(/\[data-frame-card-(line|end|trail)\][^{]*\{[^}]*opacity: 0;/);
    expect(block('[data-frame-card-row]:has(:focus-visible) [data-frame-card-action]')).toContain('opacity: 1;');
    const hoverOnly = [...css.matchAll(/@media \(hover: hover\) \{([\s\S]*?\n)\}/g)].map(([, body]) => body!).join('\n');
    expect(block('  [data-frame-card]:hover [data-frame-card-action],\n  [data-frame-card-row]:hover [data-frame-card-action]', hoverOnly)).toContain('opacity: 1;');
    const actionRules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(([, selector]) => selector!).filter((selector) => selector.includes('[data-frame-card-action]') && selector.includes('[data-frame-card-row]'));
    for (const selector of actionRules) expect(selector).not.toContain(':focus-within');
    expect(block('[data-frame-card-row][data-frame-card-columns~="action"] [data-frame-card-secondary],\n[data-frame-card-row][data-frame-card-columns~="action"]:not([data-frame-card-columns~="secondary"]) > :nth-child(2)')).toContain('padding-inline-end: 20px;');
    expect(block('  [data-frame-card-row][data-frame-card-columns~="action"] > :nth-child(2)', phone)).toContain('padding-inline-end: 20px;');
    const clearance = [...css.matchAll(/([^{}]+)\{[^{}]*padding-inline-end: 20px[^{}]*\}/g)].map(([, selector]) => selector!);
    for (const selector of clearance) expect(selector).not.toMatch(/hover|focus|pinned|action-rest/);
  });

  test('a host focus outline of ordinary weight does not draw a second ring on a card or row link', () => {
    const rule = ':is([data-frame-card], [data-frame-card-row]) :focus-visible:not([data-frame-card-action] *)';
    expect(block(rule)).toContain('outline: none;');
    expect(frameCss).not.toMatch(/@layer/);
    const weight = (selector: string): number => {
      let rest = selector;
      let total = 0;
      for (;;) {
        const at = rest.search(/:(is|not|has|where)\(/);
        if (at < 0) break;
        const open = rest.indexOf('(', at);
        let depth = 1;
        let end = open + 1;
        while (depth > 0) {
          if (rest[end] === '(') depth++;
          if (rest[end] === ')') depth--;
          end++;
        }
        const name = rest.slice(at + 1, open);
        const inner = rest.slice(open + 1, end - 1).split(',').map((part) => weight(part.trim()));
        if (name !== 'where') total += Math.max(...inner);
        rest = rest.slice(0, at) + ' ' + rest.slice(end);
      }
      const ids = (rest.match(/#[\w-]+/g) ?? []).length;
      const classes = (rest.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
      const types = (rest.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
      return total + ids * 10000 + classes * 100 + types;
    };
    for (const host of [':focus-visible', '*:focus-visible', 'a:focus-visible', '.link:focus-visible', 'a.link:focus-visible', 'body a:focus-visible', '.app a:focus-visible']) {
      expect(weight(rule)).toBeGreaterThan(weight(host));
    }
    expect(weight(rule)).toBe(300);
  });

  test('keyboard focus on a row fills it more than hover and underlines its title; hover is unchanged', () => {
    const focused = '[data-frame-card-row]:has(:focus-visible:not([data-frame-card-action] *))';
    expect(block(focused)).toContain('background: color-mix(in oklch, var(--primary) 16%, transparent);');
    const title = block(`${focused} [data-frame-card-title]`);
    expect(title).toContain('text-decoration: underline;');
    expect(title).toContain('text-underline-offset: 3px;');
    expect(title).not.toContain('color:');
    expect(css).toContain('@media (hover: hover) {\n  [data-frame-card-row]:hover {\n    background: var(--frame-surface-hover);\n  }\n}');
  });

  test('no row ever draws an edge: no shadow but the thumbnail ring, no border, outline, gradient or drawn pseudo-element on any part of a row, in frame.css, motions.css or the row code', () => {
    const rules = (source: string) => [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector!.trim(), body!] as const);
    const rowish = /\[data-frame-card-(row|rows|trail|end|line|title|secondary|dot|thumb|pinned-mark|action)\]/;
    const checked = [...rules(frameCss), ...rules(motionsCss)].filter(([selector]) => rowish.test(selector) && !/(^|,\s*)\[data-frame-card\]/.test(selector));
    expect(checked.length).toBeGreaterThan(20);
    for (const [selector, body] of checked) {
      for (const [, shadow] of body.matchAll(/\bbox-shadow:\s*([^;]*);/g)) {
        let flat = shadow!;
        while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, '');
        expect(flat).toMatch(/^inset 0 0 0 1px [^,]+$/);
      }
      expect(body).not.toMatch(/\b(border(?![a-z-]*radius)|outline)(-[a-z]+)?:(?!\s*none;)/);
      expect(body).not.toMatch(/gradient\(/);
      expect(selector).not.toMatch(/::?(before|after)/);
    }
    const tsx = readFileSync(join(folder, 'card', 'Card.tsx'), 'utf8');
    const rowSource = ['export function CardRow(', 'export function CardRows(', 'function GreyLine(', 'function Dot(', 'function Thumb(', 'function Glyph(', 'function PinnedMark(', 'function Blank('].map((start) => {
      const at = tsx.indexOf(start);
      expect(at).toBeGreaterThan(-1);
      return tsx.slice(at, tsx.indexOf('\n}\n', at));
    });
    expect(rowSource.join('\n')).toContain('before:absolute');
    for (const source of rowSource) {
      const literals = [...source.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map(([, plain, template]) => plain ?? template ?? '');
      for (const classes of literals) {
        for (const word of classes.split(/\s+/)) {
          expect(word).not.toMatch(/^(?:[a-z0-9-]+:)*(border|ring|shadow|inset-shadow|outline-(?!none)|bg-(linear|radial|conic|gradient)|from-|via-|to-)/);
          expect(word).not.toMatch(/^(?:[a-z0-9-]+:)*bg-\[[^\]]*gradient/);
          expect(word).not.toMatch(/^(?:[a-z0-9-]+:)*\[(box-shadow|border|outline|background)/);
          expect(word).not.toMatch(/^(?:[a-z0-9-]+:)*after:/);
          expect(word).not.toMatch(/^(?:[a-z0-9-]+:)*before:(bg|border|shadow|ring|from|via|to|w-|h-|inset-y|left-|right-|\[)/);
        }
      }
    }
  });

  test('hover styles of cards, rows and the pill apply only on screens with hover, so a tap leaves none behind', () => {
    const outside = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media \((hover: hover|prefers-reduced-motion: reduce)\) \{[\s\S]*?\n\}/g, '');
    for (const source of [frameCss, motionsCss]) {
      const hovered = [...outside(source).matchAll(/([^{}]+)\{/g)].map(([, selector]) => selector!.trim()).filter((selector) => selector.includes(':hover') && selector.includes('[data-frame-card'));
      expect(hovered).toEqual([]);
    }
    expect(css).toContain('@media (hover: hover) {\n  [data-frame-card]:hover {');
    expect(css).toContain('@media (hover: hover) {\n  [data-frame-card-updates]:hover {');
    expect(motionsCss).toContain('@media (hover: hover) {\n  [data-frame-card]:hover .frame-card-fan {');
  });

  test('a row shows one pin at a time: the card\'s mark is hidden whenever the action shows, with hover or without', () => {
    expect(block('[data-frame-card-row][data-frame-card-columns~="action"]:has(:focus-visible) [data-frame-card-pinned-mark]')).toContain('visibility: hidden;');
    const hoverOnly = [...css.matchAll(/@media \(hover: hover\) \{([\s\S]*?\n)\}/g)].map(([, body]) => body!).join('\n');
    expect(block('  [data-frame-card-row][data-frame-card-columns~="action"]:hover [data-frame-card-pinned-mark]', hoverOnly)).toContain('visibility: hidden;');
    const noHover = css.slice(css.indexOf('@media (hover: none) {\n  [data-frame-card-row]'));
    expect(block('[data-frame-card-row][data-frame-card-columns~="action"]:not([data-frame-card-rows][data-frame-card-action-rest=\"never\"] *) [data-frame-card-pinned-mark]', noHover)).toContain('visibility: hidden;');
  });

  test('without hover, actionAtRest touch (the default) shows each row action at rest with 20 px clear before it; never shows none until keyboard focus and keeps the pin', () => {
    const never = '[data-frame-card-rows][data-frame-card-action-rest=\"never\"] *';
    const noHover = [...css.matchAll(/@media \(hover: none\) \{([\s\S]*?\n)\}/g)].map(([, body]) => body!).join('\n');
    expect(block(`  [data-frame-card] [data-frame-card-action],\n  [data-frame-card-row]:not(${never}) [data-frame-card-action]`, noHover)).toContain('opacity: 1;');
    expect(block(`[data-frame-card-row]:is(${never}):not(:has(:focus-visible)) [data-frame-card-action]`, noHover)).toContain('pointer-events: none;');
    expect(noHover).not.toMatch(/\[data-frame-card-row\]:is\(\[data-frame-card-rows\]\[data-frame-card-action-rest="never"\] \*\)[^{]*\{[^}]*(opacity: 1|visibility: hidden)/);
    expect(block('\n[data-frame-card-action]')).toContain('opacity: 0;');
    expect(block('[data-frame-card-row]:has(:focus-visible) [data-frame-card-action]')).toContain('opacity: 1;');
  });
});
