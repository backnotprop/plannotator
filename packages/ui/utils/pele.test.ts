import { describe, expect, test } from 'bun:test';
import {
  loadPeleRuntime,
  PELE_MAX_EDGES,
  PELE_OUTPUT_LIMIT,
  PELE_SOURCE_LIMIT,
  peleSvgId,
  peleThemeStyle,
  renderPeleSource,
} from './pele';

describe('Pele runtime', () => {
  test('renders Mermaid flowchart syntax into an SVG and disables links and images', async () => {
    const runtime = await loadPeleRuntime();
    const { svg } = renderPeleSource(
      runtime,
      'flowchart TD\n  A[Start] --> B[Finish]\n  click A "https://example.com"',
      'pele-test',
    );

    expect(svg).toContain('class="pele pele-flowchart"');
    expect(svg).toContain('data-id="L_A_B_0"');
    expect(svg).not.toContain('<a ');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('https://example.com');
  });

  test('a malformed Mermaid source is reported as a renderer error', async () => {
    const runtime = await loadPeleRuntime();
    expect(() => renderPeleSource(runtime, 'not a diagram', 'bad-source')).toThrow();
  });

  test('keeps explicit resource limits and unique root ids for renderer instances', () => {
    expect(PELE_SOURCE_LIMIT).toBeGreaterThan(0);
    expect(PELE_OUTPUT_LIMIT).toBeGreaterThan(0);
    expect(PELE_MAX_EDGES).toBeGreaterThan(0);
    expect(peleSvgId('one/diagram')).not.toBe(peleSvgId('two/diagram'));
    expect(peleThemeStyle()).toContain('--pele-bg:var(--background)');
    expect(peleThemeStyle()).toContain('--pele-font:var(--font-sans)');
  });
});
