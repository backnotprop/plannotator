import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const uiRoot = resolve(import.meta.dir, '..');

const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  ['@codemirror/', 'the Source pane editor'],
  ['cm-editor', "CodeMirror's own class name (it landed even if the specifier was rewritten)"],
  ['DiagramSourcePane', 'the Source pane'],
  ['DiagramPopout', 'the full-size popout'],
  ['data-diagram-canvas', 'the diagram canvas'],
  ['getScreenCTM', 'the diagram projection'],
];

let entryClosure = '';
let offEntry = '';

beforeAll(async () => {
  const { build } = await import('vite');
  const result = (await build({
    root: uiRoot,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      target: 'esnext',
      minify: false,
      lib: { entry: resolve(uiRoot, 'components/Viewer.tsx'), formats: ['es'], fileName: 'viewer' },
      rollupOptions: {
        external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
        output: { inlineDynamicImports: false },
      },
    },
  })) as unknown as { output: ReadonlyArray<Record<string, unknown>> };

  const outputs = (Array.isArray(result) ? result[0] : result).output;
  const chunks = new Map<string, { code: string; imports: readonly string[] }>();
  for (const output of outputs) {
    if (output['type'] !== 'chunk') continue;
    chunks.set(output['fileName'] as string, {
      code: output['code'] as string,
      imports: output['imports'] as readonly string[],
    });
  }
  const entry = outputs.find((output) => output['type'] === 'chunk' && output['isEntry'] === true);
  expect(entry).toBeDefined();

  const reached = new Set<string>();
  const queue = [entry!['fileName'] as string];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (reached.has(current)) continue;
    reached.add(current);
    for (const imported of chunks.get(current)?.imports ?? []) {
      if (chunks.has(imported)) queue.push(imported);
    }
  }

  entryClosure = [...reached].map((name) => chunks.get(name)?.code ?? '').join('\n');
  offEntry = [...chunks.entries()]
    .filter(([name]) => !reached.has(name))
    .map(([, chunk]) => chunk.code)
    .join('\n');
}, 120_000);

describe('document-read closure of the Viewer entry', () => {
  test('walked a real entry chunk', () => {
    expect(entryClosure.length).toBeGreaterThan(100_000);
    expect(entryClosure).toContain('data-block-id');
  });

  test.each(FORBIDDEN)('does not statically reach %s (%s)', (marker) => {
    expect(entryClosure).not.toContain(marker);
  });

  test('still reaches the diagram engine through dynamic chunks', () => {
    for (const [marker] of FORBIDDEN) {
      expect(offEntry).toContain(marker);
    }
  });

  test('keeps the diagram fence pending state in the entry chunk', () => {
    expect(entryClosure).toContain('data-mermaid-pending');
    expect(entryClosure).toContain('Rendering diagram');
  });
});
