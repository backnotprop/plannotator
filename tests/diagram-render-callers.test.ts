/**
 * Who may start a diagram engine inside packages/ui.
 *
 * A host's source check (`DiagramSourceAcceptContext`) is a React context, so only a component can read it:
 * `useDiagramRender` asks it before it calls `renderDiagram`. A component that called `renderDiagram`, or an engine
 * loader, itself would draw a fence the host refused, and every other test would still pass. So no file under
 * packages/ui names these entry points in its code except the ones listed in ALLOWED, each with its reason. Tests and
 * test setup call the engines directly on purpose and are not scanned.
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

/** The ways into an engine that do not ask the host's source check. */
const ENTRY_POINTS = ['renderDiagram', 'loadMermaidRuntime', 'loadGraphvizRuntime', 'loadPeleRuntime', 'renderPeleSource'] as const;

const ALLOWED: Record<string, string> = {
  // The one caller of renderDiagram: it asks the source check first and skips renderDiagram for a refused fence.
  'packages/ui/components/diagram/useDiagramRender.ts': 'asks DiagramSourceAcceptContext before renderDiagram',
  // Defines renderDiagram; its renderers call the loaders, and are reached only through renderDiagram.
  'packages/ui/utils/diagram-render.ts': 'defines renderDiagram',
  // The engines' own modules, which define the loaders.
  'packages/ui/utils/mermaid.ts': 'defines loadMermaidRuntime',
  'packages/ui/utils/graphviz.ts': 'defines loadGraphvizRuntime',
  'packages/ui/utils/pele.ts': 'defines loadPeleRuntime and renderPeleSource',
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

/** The text without comments, so a doc comment that names an entry point is not a use. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** The entry points a file names in its code: an import, a call, or passing one along all count. */
function named(file: string): string[] {
  const text = code(readFileSync(file, 'utf8'));
  return ENTRY_POINTS.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
}

describe('diagram engines in packages/ui are started only behind the host source check', () => {
  const files = sources(ui);

  test('no file outside the allowed list names an engine entry point', () => {
    const offenders = files
      .filter((file) => !(rel(file) in ALLOWED))
      .map((file) => ({ file: rel(file), names: named(file) }))
      .filter((entry) => entry.names.length > 0);
    expect(offenders).toEqual([]);
  });

  test('the scan sees the one real caller and every allowed file exists (so the guard is not empty)', () => {
    const scanned = new Set(files.map(rel));
    for (const file of Object.keys(ALLOWED)) expect(scanned.has(file)).toBe(true);
    expect(named(join(root, 'packages/ui/components/diagram/useDiagramRender.ts'))).toEqual(['renderDiagram']);
  });
});
