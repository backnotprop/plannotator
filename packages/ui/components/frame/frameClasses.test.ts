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
    expect(reduced).toMatch(/\.frame-card-fan,\s*\[data-frame-card-hero\],\s*\.frame-card-arrive \{\s*transition: none;\s*\}/);
    expect(reduced).toMatch(/::view-transition-new\(\*\.frame-card-open\) \{\s*animation: none;\s*\}/);
    const animated = [...reduced.matchAll(/([^{}]+)\{\s*animation: none;/g)].map(([, selectors]) => selectors).join(',');
    for (const name of ['frame-card-breathe', 'frame-card-settle', 'frame-card-arrive-tint']) expect(animated).toContain(name);
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
