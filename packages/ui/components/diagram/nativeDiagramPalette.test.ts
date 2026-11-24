import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCssColor, contrastRatio } from '../../utils/cssColor';
import { renderDiagram, type DiagramSpec } from '@plannotator/diagrams';
import { nativeDiagramPalette, nativeReviewSpec } from './nativeDiagramPalette';

const dark = nativeDiagramPalette({ background: '#101820', foreground: '#fafafa', primary: '#44bbee' });
const states = ['live', 'building', 'trial', 'planned', 'retiring'];
const source: DiagramSpec = {
  title: 'Release stages',
  columns: [states.map((status) => ({
    id: status, title: status, status, tone: 'accent',
    refs: [{ kind: 'file' as const, title: 'Stages', path: 'stages.ts' }],
    tiles: [{ label: 'Readiness', status }],
  }))],
};
const geometry = (svg: string) => svg.replace(/ (?:fill|stroke)="#[0-9a-f]{6}"/gi, '');

test('theme changes only SVG colors, including for every built-in status', async () => {
  const authored = JSON.stringify(source);
  const original = await renderDiagram(source);
  const compiled = await renderDiagram(nativeReviewSpec(source, dark) as DiagramSpec);
  expect(compiled.svg).toContain('fill="#101820"');
  expect(compiled.svg).toContain('fill="#44bbee"');
  expect(compiled.svg).not.toBe(original.svg);
  expect(geometry(compiled.svg)).toBe(geometry(original.svg));
  expect(compiled.parts).toEqual(original.parts);
  expect(compiled.description).toBe(original.description);
  expect(compiled.problems).toEqual(original.problems);
  expect(JSON.stringify(source)).toBe(authored);
  expect((await renderDiagram(source)).svg).toBe(original.svg);
});

test('individual author style choices survive, including a named tone and a custom status', () => {
  const customStatus = { label: 'Paused', fill: '#173720', stroke: '#99ccaa' };
  const theme = { lid: 2, line: '#aaccee', tones: { accent: '#bf6622' }, statuses: { planned: customStatus } };
  const adapted = nativeReviewSpec({ ...source, theme }, dark) as DiagramSpec;
  expect(adapted.theme).toMatchObject({ paper: '#101820', lid: 2, line: '#aaccee',
    tones: { accent: '#bf6622', neutral: dark?.tones?.neutral },
    statuses: { planned: customStatus, trial: dark?.statuses?.trial } });
  expect(theme.tones).toEqual({ accent: '#bf6622' });
});

test('authored paper and ink keep their original matching palette; authors without host tokens use renderer defaults', () => {
  for (const theme of [{ paper: '#eeeedd' }, { ink: '#112233' }, { tile_fill: '#ffffff' }, { line: '#123456' }, { statuses: { planned: { label: 'Paused', fill: '#beefee', stroke: '#008800' } } }]) {
    const authored = { ...source, theme };
    expect(nativeReviewSpec(authored, dark)).toBe(authored);
  }
  expect(nativeDiagramPalette({})).toBeNull();
  expect(nativeReviewSpec(source, null)).toBe(source);
});

test('invalid author values still reach renderer validation', async () => {
  for (const theme of [null, { tones: 3 }, { statuses: { planned: { fill: '#123456' } } }, { paper: 'bad' }]) {
    const authored = { ...source, theme };
    const errors = await Promise.all([authored, nativeReviewSpec(authored, dark)].map(async (spec) => {
      try { await renderDiagram(spec as DiagramSpec); } catch (error) { return (error as Error).message; }
      return null;
    }));
    expect(errors[0]).toMatch(/theme/);
    expect(errors[1]).toEqual(errors[0]);
  }
});

test('built-in light and dark palettes keep shared text and connectors readable across their surfaces', () => {
  const themes = join(import.meta.dir, '../../themes');
  let checked = 0;
  for (const file of readdirSync(themes).filter(name => name.endsWith('.css'))) {
    const css = readFileSync(join(themes, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const tokens = Object.fromEntries([...declarations.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)]
        .map(([, key, value]) => [key, value.trim()]));
      if (!tokens.background || !tokens.foreground) continue;
      const palette = nativeDiagramPalette(tokens);
      expect(palette, selector).not.toBeNull();
      const { ink, muted, faint, line, paper, panel_fill, tile_fill, note_fill, group_fill, statuses } = palette!;
      const surfaces = [paper, panel_fill, tile_fill, note_fill, group_fill, ...Object.values(statuses).map(s => s.fill)];
      for (const surface of surfaces) {
        const contrast = (paint: string) => contrastRatio(parseCssColor(paint)!, parseCssColor(surface)!);
        for (const text of [ink, muted, faint]) expect(contrast(text), selector).toBeGreaterThanOrEqual(4.5);
        expect(contrast(line), selector).toBeGreaterThanOrEqual(3);
      }
      for (const state of Object.values(statuses)) {
        for (const bg of [paper, state.fill]) {
          expect(contrastRatio(parseCssColor(state.stroke)!, parseCssColor(bg)!), selector).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrastRatio(parseCssColor(palette!.tones.dark)!, parseCssColor('#ffffff')!), selector).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseCssColor(palette!.tones.dark)!, parseCssColor(paper)!), selector).toBeGreaterThanOrEqual(1.5);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});
