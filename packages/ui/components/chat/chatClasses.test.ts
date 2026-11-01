/**
 * Every class this folder writes must mean something in the Inbox's real
 * stylesheet. A class with no rule fails silently in a browser: the window
 * draws, with a corner, a hover or a focus halo missing. The folder's classes
 * are read from the source, then compiled one at a time through Tailwind with
 * the Inbox's own entry, the mapping in `apps/inbox/index.css` included.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'tailwindcss';
import ts from 'typescript';

const folder = import.meta.dir;
const entry = resolve(folder, '../../../../apps/inbox/index.css');

/** The app's stylesheet graph, with fonts (no rules a class could use) left out. */
async function loadStylesheet(id: string, base: string) {
  if (id.startsWith('@fontsource')) return { path: id, base, content: '' };
  const path = id.startsWith('.')
    ? resolve(base, id)
    : Bun.resolveSync(id === 'tailwindcss' ? 'tailwindcss/index.css' : id, folder);
  return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
}

/** A `@plugin` the entry names, resolved from the entry's own folder. */
async function loadModule(id: string, base: string) {
  const path = Bun.resolveSync(id, base);
  return { path, base: dirname(path), module: (await import(path)).default };
}

async function compileInbox() {
  return compile(readFileSync(entry, 'utf8'), { base: dirname(entry), loadStylesheet, loadModule });
}

function sources(): ts.SourceFile[] {
  return readdirSync(folder)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) =>
      ts.createSourceFile(name, readFileSync(join(folder, name), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    );
}

/** Top-level `const NAME = ...` across the folder, for classes held in constants. */
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

interface ClassText {
  readonly text: string;
  /** The file the string is written in, not the one that uses it. */
  readonly file: string;
}

/** The string literals an expression can evaluate to, following constants. */
function literals(node: ts.Node, named: Map<string, ts.Expression>, seen: Set<string>, out: ClassText[]) {
  if (ts.isStringLiteralLike(node)) {
    out.push({ text: node.text, file: node.getSourceFile().fileName });
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
  // The condition of a ternary or && is no class; its branches are.
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

/** Every string of classes in a `className` attribute or a `cn()` call. */
function classTexts(): ClassText[] {
  const files = sources();
  const named = constants(files);
  const out: ClassText[] = [];
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
  return out;
}

/** The classes that compile to no rule: each must add something to the sheet. */
async function classesWithNoRule(classes: Iterable<string>) {
  const { build } = await compileInbox();
  let sheet = build([]);
  const missing: string[] = [];
  for (const name of classes) {
    const next = build([name]);
    if (next === sheet) missing.push(name);
    sheet = next;
  }
  return missing;
}

describe('every chat class has a rule in the Inbox', () => {
  const texts = classTexts();
  const classes = new Set(texts.flatMap(({ text }) => text.split(/\s+/)).filter(Boolean));

  test('the source reader sees the folder, constants and conditional branches included', () => {
    expect(classes.size).toBeGreaterThan(60);
    // Through a constant in another file, a cn() and a template of branches:
    expect(classes).toContain('rounded-dialog');
    expect(classes).toContain('focus-visible:ring-ring-soft');
    expect(classes).toContain('inset-0');
    expect(classes).toContain('cursor-grab');
    // A word that is not a class must stay out, or the check below would be noise.
    expect(classes).not.toContain('Message');
  });

  test('a made-up class is caught, so a pass below means something', async () => {
    expect(await classesWithNoRule(['chat-no-such-class', 'text-tertiary-nope'])).toEqual([
      'chat-no-such-class',
      'text-tertiary-nope',
    ]);
  });

  test('none is left without a rule', async () => {
    expect(await classesWithNoRule(classes)).toEqual([]);
  });

  // Compiling a class by hand says nothing about whether an app's build ever
  // sees it: `@source` takes these folders as `**/*.tsx`, so a class written in
  // a .ts file compiles here and is missing from the real stylesheet.
  test('every class is written in a file the apps\' @source globs reach', () => {
    const entrySource = readFileSync(entry, 'utf8');
    expect(entrySource).toContain('@source "../../packages/ui/components/**/*.tsx"');
    expect(texts.map(({ file }) => file).filter((file) => !file.endsWith('.tsx'))).toEqual([]);
  });
});
