import { describe, expect, test } from 'bun:test';
import { instance } from '@viz-js/viz';
import { isGraphvizLanguage, isMermaidLanguage } from './diagramLanguages';

describe('diagramLanguages', () => {
  test('matches mermaid fences case-insensitively', () => {
    expect(isMermaidLanguage('mermaid')).toBe(true);
    expect(isMermaidLanguage('Mermaid')).toBe(true);
    expect(isMermaidLanguage('mermaid align=center')).toBe(true);
    expect(isMermaidLanguage('graphviz')).toBe(false);
  });

  test('matches supported graphviz aliases case-insensitively', () => {
    expect(isGraphvizLanguage('graphviz')).toBe(true);
    expect(isGraphvizLanguage('dot')).toBe(true);
    expect(isGraphvizLanguage('GV')).toBe(true);
    expect(isGraphvizLanguage('dot rankdir=LR')).toBe(true);
    expect(isGraphvizLanguage('mermaid')).toBe(false);
    expect(isGraphvizLanguage(undefined)).toBe(false);
  });

  test('renders a simple dot graph to svg', async () => {
    const viz = await instance();
    const svg = await viz.renderString('digraph { Plan -> Review }', { format: 'svg' });

    expect(svg).toContain('<svg');
    expect(svg).toContain('Plan');
    expect(svg).toContain('Review');
  });
});
