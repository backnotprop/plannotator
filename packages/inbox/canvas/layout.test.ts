/**
 * What counts as the agent's change when its new version lands (layout.ts `changedPartIds`): the quiet line's
 * "changed N parts" and Show's flash. What regresses: a recolour not counted (the person is told nothing changed),
 * a removed part missed, or an unchanged board reported as changed.
 */
import { expect, test } from 'bun:test';
import type { CanvasElement } from '@plannotator/core/canvas-scene';
import { changedPartCount, changedPartIds } from './layout';

const el = (id: string, more: Partial<CanvasElement> = {}): CanvasElement => ({ id, type: 'rectangle', x: 10, y: 20, width: 100, height: 40, customData: { part: id.split('~')[0] }, strokeColor: '#1e1e1e', backgroundColor: 'transparent', ...more });

const before = [el('title', { type: 'text', text: 'Settings' }), el('row-1'), el('row-1~t', { type: 'text', text: 'Push' }), el('row-2')];

test('the same layout again changes nothing; the person\'s own elements never count', () => {
  const person: CanvasElement = { id: 'ink', type: 'freedraw', x: 0, y: 0, width: 5, height: 5 };
  expect(changedPartCount(before, [...before.map((e) => ({ ...e, x: e.x + 0.2 })), person])).toBe(0);
});

test('moved, resized, reworded and recoloured parts count once each', () => {
  const after = before.map((e) =>
    e.id === 'title' ? { ...e, text: 'Preferences' } : e.id === 'row-1~t' ? { ...e, x: e.x + 30 } : e.id === 'row-2' ? { ...e, backgroundColor: '#ffec99' } : e,
  );
  expect(changedPartIds(before, after).sort()).toEqual(['row-1', 'row-2', 'title']);
  expect(changedPartCount(before, after.map((e) => (e.id === 'row-2' ? { ...e, strokeColor: '#e03131', backgroundColor: 'transparent' } : e)))).toBe(3);
});

test('added and removed parts count', () => {
  expect(changedPartIds(before, [...before.filter((e) => e.id !== 'row-2'), el('row-3')]).sort()).toEqual(['row-2', 'row-3']);
  expect(changedPartIds(before, before.map((e) => (e.id === 'row-2' ? { ...e, isDeleted: true } : e)))).toEqual(['row-2']);
});
