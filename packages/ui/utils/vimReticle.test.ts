import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SemanticTarget } from './blockTargeting';
import { createVimHudCommand } from './vimHud';
import { getVimReticleLabel } from './vimReticle';

function target(
  kind: SemanticTarget['kind'],
  label: string,
): Pick<SemanticTarget, 'kind' | 'label'> {
  return { kind, label };
}

describe('Vim HUD reticle labels', () => {
  test('names semantic targets without leaking their full text', () => {
    expect(getVimReticleLabel(
      { phase: 'block', targetKey: 'target' },
      target('block', 'heading: "Implementation plan"'),
      null,
    )).toBe('BLOCK · HEADING');
    expect(getVimReticleLabel(
      { phase: 'inline', targetKey: 'target' },
      target('inline', 'bold: "production-grade"'),
      null,
    )).toBe('INLINE · BOLD');
  });

  test('describes caret and Visual motions using their handled context', () => {
    expect(getVimReticleLabel(
      {
        phase: 'text',
        targetKey: 'target',
        cursor: { blockId: 'block', textOffset: 0 },
      },
      null,
      createVimHudCommand(1, 'refine', 'l', 'block'),
    )).toBe('CURSOR · INLINE TEXT');
    expect(getVimReticleLabel(
      {
        phase: 'visual',
        targetKey: 'target',
        anchor: { blockId: 'block', textOffset: 0 },
        cursor: { blockId: 'block', textOffset: 4 },
      },
      null,
      createVimHudCommand(2, 'wordEnd', 'e', 'visual'),
    )).toBe('VISUAL · EXACT TOKEN');
  });

  test('keeps motion compositor-only and disables it for reduced motion', () => {
    const themeCss = readFileSync(resolve(import.meta.dir, '../theme.css'), 'utf8');
    const reticleCss = themeCss.slice(themeCss.indexOf('.vim-target-reticle'));
    expect(reticleCss).toContain('transition: transform');
    expect(reticleCss).not.toMatch(/transition:\s*(top|left|width|height)/);
    expect(reticleCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(reticleCss).toContain('transition: none');
  });
});
