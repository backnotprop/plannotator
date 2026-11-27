/**
 * Who may start a diagram engine inside packages/ui.
 *
 * A host's source check (`DiagramSourceAcceptContext`) is a React context, so only a component can read it:
 * `useDiagramRender` asks it before it calls `renderDiagram`. A component that called `renderDiagram`, an engine
 * loader, a loaded engine (`getMermaidRuntime`, `getGraphvizRuntime`) or imported an engine package itself would draw
 * a fence the host refused, and every other test would still pass. So no file under packages/ui names any of these
 * except the files listed in ALLOWED, each with its reason. Tests and test setup call the engines directly on purpose
 * and are not scanned.
 *
 * The scan reads the whole file, comments included: a comment cannot hide code from it. A mention in a comment of a
 * file outside ALLOWED fails too; reword the comment.
 *
 * What regresses if this fails: a new caller in packages/ui reaches an engine without the host's source check.
 * If you add a caller, route it through `useDiagramRender` (or a component that uses it); do not add it to ALLOWED
 * unless it cannot draw a fence on its own.
 *
 * A source scan, since the repo has no linter to say it (no Oxlint or ESLint config).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const ui = join(root, 'packages/ui');

/** The ways into an engine that do not ask the host's source check: functions, and the engine packages' dynamic imports. */
const ENTRY_POINTS: readonly { name: string; pattern: RegExp }[] = [
  ...['renderDiagram', 'loadMermaidRuntime', 'loadGraphvizRuntime', 'loadPeleRuntime', 'renderPeleSource', 'getMermaidRuntime', 'getGraphvizRuntime'].map(
    (name) => ({ name, pattern: new RegExp(`\\b${name}\\b`) }),
  ),
  ...['mermaid', '@viz-js/viz', 'pele', 'pele/lazy'].map((spec) => ({
    name: `import('${spec}')`,
    pattern: new RegExp(`\\bimport\\s*\\(\\s*['"\`]${spec.replace(/[/.@-]/g, '\\$&')}['"\`]\\s*\\)`),
  })),
];

const ALLOWED: Record<string, string> = {
  // The one caller of renderDiagram: it asks the source check first and skips renderDiagram for a refused fence.
  'packages/ui/components/diagram/useDiagramRender.ts': 'asks DiagramSourceAcceptContext before renderDiagram',
  // Defines renderDiagram; its renderers call the loaders, and are reached only through renderDiagram.
  'packages/ui/utils/diagram-render.ts': 'defines renderDiagram',
  // The engines' own modules: they define the loaders and getters and hold the engine packages' imports.
  'packages/ui/utils/mermaid.ts': "defines loadMermaidRuntime and getMermaidRuntime; holds import('mermaid')",
  'packages/ui/utils/graphviz.ts': "defines loadGraphvizRuntime and getGraphvizRuntime; holds import('@viz-js/viz')",
  'packages/ui/utils/pele.ts': "defines loadPeleRuntime and renderPeleSource; holds import('pele/lazy')",
};

const rel = (file: string) => relative(root, file).split('\\').join('/');

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test-setup') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

/** The entry points a file names anywhere in its text: an import, a call, passing one along, or a comment. */
function named(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return ENTRY_POINTS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

describe('diagram engines in packages/ui are started only behind the host source check', () => {
  const files = sources(ui);

  test('no file outside the allowed list names an engine entry point (route it through useDiagramRender; reword a comment that names one)', () => {
    const offenders = files
      .filter((file) => !(rel(file) in ALLOWED))
      .map((file) => ({ file: rel(file), names: named(file) }))
      .filter((entry) => entry.names.length > 0);
    expect(offenders).toEqual([]);
  });

  test('the scan sees the real callers and every allowed file exists (so the guard is not empty)', () => {
    const scanned = new Set(files.map(rel));
    for (const file of Object.keys(ALLOWED)) expect(scanned.has(file)).toBe(true);
    expect(named(join(root, 'packages/ui/components/diagram/useDiagramRender.ts'))).toEqual(['renderDiagram']);
    expect(named(join(root, 'packages/ui/utils/graphviz.ts'))).toContain("import('@viz-js/viz')");
    expect(named(join(root, 'packages/ui/utils/mermaid.ts'))).toContain("import('mermaid')");
    expect(named(join(root, 'packages/ui/utils/pele.ts'))).toContain("import('pele/lazy')");
  });
});
