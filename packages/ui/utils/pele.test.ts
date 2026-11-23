// The Pele runtime as Plannotator calls it (no DOM needed): what it is told
// to leave out, what it cannot do that the capability map records, and its
// limits.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadRealPele } from '../test-setup/pele';
import { DIAGRAM_ENGINE_MODE, DIAGRAM_FEATURES } from './diagram-engine';
import { MERMAID_LABEL_WRAP_WIDTH } from './mermaid';
import { __setPeleRuntimeLoaderForTests, loadPeleRuntime, PELE_IN_BUILD, PELE_SOURCE_LIMIT, peleSvgId, renderPeleSource } from './pele';

const fonts = { sans: 'sans-serif', mono: 'monospace' };

// What regresses if this fails: a build with the shipped switch carries
// Pele's library again, or a fence reaches it (tests/entry-assets.test.ts
// reads the built files for the same promise).
describe('Pele under the shipped switch', () => {
  test("is not part of the build while the switch is 'mermaid': its loader refuses", async () => {
    __setPeleRuntimeLoaderForTests(undefined);
    expect(DIAGRAM_ENGINE_MODE).toBe('mermaid');
    expect(PELE_IN_BUILD).toBe(false);
    await expect(loadPeleRuntime()).rejects.toThrow(/not part of this build/u);
  });
});

describe('Pele runtime', () => {
  beforeAll(() => __setPeleRuntimeLoaderForTests(loadRealPele));
  afterAll(() => __setPeleRuntimeLoaderForTests(undefined));

  test('draws a flowchart with no link and no image, whatever the source asks', async () => {
    const runtime = await loadPeleRuntime();
    const { svg } = await renderPeleSource(
      runtime,
      'flowchart TD\n  A[Start] --> B[Finish]\n  click A "https://example.com"',
      'pele-test',
      fonts,
    );
    expect(svg).toContain('class="pele pele-flowchart"');
    expect(svg).toContain('data-id="L_A_B_0"');
    expect(svg).not.toContain('<a ');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('https://example.com');
    expect(DIAGRAM_FEATURES.clickLinks.pele).toBe(false);
  });

  test('says which sources it can draw, loading only what it needs', async () => {
    const runtime = await loadPeleRuntime();
    expect(await runtime.supports('sequenceDiagram\n  A->>B: hi')).toBe(true);
    expect(await runtime.supports('not a diagram')).toBe(false);
  });

  test('a malformed source is an error that carries a source line', async () => {
    const runtime = await loadPeleRuntime();
    const failure = await renderPeleSource(runtime, 'flowchart TD\n  A --> B\n  C -->', 'bad', fonts).then(
      () => null,
      (error: unknown) => error as { line?: number },
    );
    expect(failure).not.toBeNull();
    // Pele reports where its parser stopped (past the dangling arrow here), one-based.
    expect(failure?.line).toBeGreaterThan(1);
  });

  test('wraps a long label at the width Mermaid wraps it', async () => {
    const runtime = await loadPeleRuntime();
    const label = 'a label long enough that it has to wrap onto more than one line';
    const { svg } = await renderPeleSource(runtime, `flowchart TD\n  A["${label}"]`, 'wrap', fonts);
    // Wrapped text is several <tspan> lines; at Pele's own 200 px default this label is fewer.
    const lines = svg.match(/<tspan/gu)?.length ?? 0;
    const { svg: wide } = await runtime.render(`flowchart TD\n  A["${label}"]`, { fontFamily: 'sans-serif', config: { flowchart: { wrappingWidth: 400 } } });
    expect(MERMAID_LABEL_WRAP_WIDTH).toBe(140);
    expect(lines).toBeGreaterThan(wide.match(/<tspan/gu)?.length ?? 0);
  });

  test('Pele alone prints math as TeX and ignores an init directive: the label step and the author theme around it do those', async () => {
    const runtime = await loadPeleRuntime();
    // Math labels are typeset by the label step around this call (`pele-labels.test.ts`); Pele alone prints the TeX.
    const { svg: math } = await renderPeleSource(runtime, 'flowchart LR\n  A["$$x^2$$"] --> B', 'math', fonts);
    expect(math).toContain('$$x^2$$');
    expect(DIAGRAM_FEATURES.mathLabels.pele).toBe(true);
    const { svg: init } = await renderPeleSource(
      runtime,
      "%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#ff00aa'}}}%%\nflowchart LR\n  A --> B",
      'init',
      fonts,
    );
    expect(init.toLowerCase()).not.toContain('#ff00aa');
    expect(DIAGRAM_FEATURES.initThemeDirectives.pele).toBe(true);
  });

  test('two renders of one source on one page share no id', async () => {
    expect(peleSvgId('one/diagram')).not.toBe(peleSvgId('two/diagram'));
    const runtime = await loadPeleRuntime();
    const source = 'flowchart TD\naccTitle: Review\n A --> B';
    const ids = async (renderId: string) => new Set(Array.from((await renderPeleSource(runtime, source, renderId, fonts)).svg.matchAll(/ id="([^"]+)"/gu), (m) => m[1]));
    const first = await ids('first');
    const second = await ids('second');
    expect(first.size).toBeGreaterThan(0);
    expect([...second].some((id) => first.has(id))).toBe(false);
  });

  test('refuses a source over the limit', async () => {
    const runtime = await loadPeleRuntime();
    const huge = `flowchart TD\n${'  A --> B\n'.repeat(PELE_SOURCE_LIMIT / 10 + 10)}`;
    await expect(renderPeleSource(runtime, huge, 'huge', fonts)).rejects.toThrow();
  });
});
