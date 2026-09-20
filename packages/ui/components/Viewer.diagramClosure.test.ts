/**
 * What a host pays to read a document.
 *
 * `Viewer` is the entry every host that renders a Plannotator document
 * imports statically, so everything reachable from it through STATIC
 * imports sits in that host's document-read chunk — diagram or no diagram.
 * The diagram engine is not small: the canvas with its zoom/pan surface and
 * its projection, the comment overlay, the full-size popout, and through the
 * viewer's Source pane the whole of CodeMirror.
 *
 * The regression this catches is the one 0.41.0 shipped: `Viewer` imported
 * the two diagram blocks statically, `DiagramBlock` imported `DiagramPopout`
 * and `DiagramViewer` statically, and `DiagramViewer` imported
 * `DiagramSourcePane` statically — so a chunked host carried CodeMirror and
 * the whole viewer on every markdown document, about 100 KB gzip of it, and
 * no host passes `onSave` for a fence today so none of it could ever run.
 * Plannotator's own single-file builds inline everything and never notice,
 * which is exactly why a test has to.
 *
 * Method: bundle `Viewer` with the chunking bundler the portal build uses
 * and walk the ENTRY chunk's STATIC imports only (rollup reports `imports`
 * and `dynamicImports` separately, so a lazy edge is a chunk boundary by
 * construction, not by parsing). Then assert the engine is still REACHABLE
 * off-entry: a lazy edge that loads nothing would pass the first half and
 * break every diagram.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const uiRoot = resolve(import.meta.dir, '..');

/** One marker per edge of the chain, so a partial fix cannot pass. */
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
      // Unminified: the markers above are read back out of the chunk text.
      minify: false,
      lib: { entry: resolve(uiRoot, 'components/Viewer.tsx'), formats: ['es'], fileName: 'viewer' },
      rollupOptions: {
        // React is the host's; leaving it out keeps the graph to our code.
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
    // Guards the check itself: a walk that found nothing would satisfy every
    // "does not contain" assertion below while proving nothing.
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
    // The Suspense fallback is the block's own pending state, so the source
    // fence under "Rendering diagram…" paints with the document and waiting
    // for the diagram chunk is not a blank gap or a second layout.
    expect(entryClosure).toContain('data-mermaid-pending');
    expect(entryClosure).toContain('Rendering diagram');
  });
});
