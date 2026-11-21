// The Pele runtime as Plannotator calls it (no DOM needed): what it is told
// to leave out, what it cannot do that the capability map records, and its
// limits.
import { describe, expect, test } from 'bun:test';
import { DIAGRAM_FEATURES } from './diagram-engine';
import { MERMAID_LABEL_WRAP_WIDTH } from './mermaid';
import { loadPeleRuntime, PELE_SOURCE_LIMIT, peleSvgId, renderPeleSource } from './pele';

const fonts = { sans: 'sans-serif', mono: 'monospace' };

describe('Pele runtime', () => {
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

  test('records what Pele does not keep: math labels print as raw text, and an init directive\'s colours are ignored', async () => {
    const runtime = await loadPeleRuntime();
    const { svg: math } = await renderPeleSource(runtime, 'flowchart LR\n  A["$$x^2$$"] --> B', 'math', fonts);
    expect(math).toContain('$$x^2$$');
    expect(DIAGRAM_FEATURES.mathLabels.pele).toBe(false);
    const { svg: init } = await renderPeleSource(
      runtime,
      "%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#ff00aa'}}}%%\nflowchart LR\n  A --> B",
      'init',
      fonts,
    );
    expect(init.toLowerCase()).not.toContain('#ff00aa');
    expect(DIAGRAM_FEATURES.initThemeDirectives.pele).toBe(false);
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
