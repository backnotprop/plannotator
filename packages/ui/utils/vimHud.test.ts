import { describe, expect, test } from 'bun:test';
import { vimSelectionShortcuts } from '../shortcuts/plan-review/vimSelection.shortcuts';
import {
  createVimHudCommand,
  getVimHudLegendGroups,
  getVimHudPhase,
  isVimHudLegendGroupActive,
} from './vimHud';

describe('Vim HUD command projection', () => {
  test('normalizes multi-key and named keys for the video keycaps', () => {
    expect(createVimHudCommand(1, 'documentStart', 'g', 'block')).toMatchObject({
      key: 'gg',
      description: 'Start of document',
      context: 'block',
    });
    expect(createVimHudCommand(2, 'cancel', 'Escape', 'visual')).toMatchObject({
      key: 'esc',
      description: 'Cancel current Vim state',
    });
    expect(createVimHudCommand(3, 'annotationMenu', ' ', 'visual')).toMatchObject({
      key: 'space',
      description: 'Open annotation actions',
    });
  });

  test('distinguishes structural, line, word, visual, and action phases', () => {
    expect(getVimHudPhase('block', 'moveDown')).toBe('BLOCK');
    expect(getVimHudPhase('inline', 'moveDown')).toBe('INLINE');
    expect(getVimHudPhase('text', 'moveDown')).toBe('LINE');
    expect(getVimHudPhase('text', 'wordForward')).toBe('WORD');
    expect(getVimHudPhase('text', 'refine')).toBe('TEXT');
    expect(getVimHudPhase('visual', 'wordEnd')).toBe('VISUAL');
    expect(getVimHudPhase('action', 'comment')).toBe('ACTION');
  });

  test('maps every registered Vim action into the expanded learning legend', () => {
    const groups = getVimHudLegendGroups();
    const legendActionIds = new Set(
      groups.flatMap((group) => group.items.map((item) => item.actionId)),
    );

    expect([...legendActionIds].sort().join(',')).toBe(
      Object.keys(vimSelectionShortcuts.shortcuts).sort().join(','),
    );
    expect(groups.find((group) => group.id === 'structure')?.items)
      .toContainEqual(expect.objectContaining({
        actionId: 'documentStart',
        key: 'gg',
      }));
    expect(groups.find((group) => group.id === 'text')?.items)
      .toContainEqual(expect.objectContaining({
        actionId: 'moveDown',
        key: 'j',
        description: 'Next line',
      }));
    expect(groups.find((group) => group.id === 'annotation')?.items)
      .toContainEqual(expect.objectContaining({
        actionId: 'annotationMenu',
        key: 'space',
      }));
  });

  test('highlights the legend group for the current navigation level', () => {
    expect(isVimHudLegendGroupActive('structure', 'BLOCK')).toBe(true);
    expect(isVimHudLegendGroupActive('text', 'WORD')).toBe(true);
    expect(isVimHudLegendGroupActive('selection', 'VISUAL')).toBe(true);
    expect(isVimHudLegendGroupActive('annotation', 'ACTION')).toBe(true);
    expect(isVimHudLegendGroupActive('control', 'BLOCK')).toBe(false);
  });
});
