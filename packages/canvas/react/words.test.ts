import { describe, expect, test } from 'bun:test';
import { createDocument } from '../model/document';
import { CanvasStore } from '../events/store';
import type { CanvasObject } from '../model/types';
import { FIGURE_MIN, figureBox, fitName } from '../snapshot/SnapshotFigure';
import { edgesBeyond, nearestBeyond } from './EdgeMarkers';
import { ARROW_LABEL_MAX, shortLabel } from './objects';
import { addReference, previewsPending } from './references';

describe('words that do not fit', () => {
  test('a long arrow label is shortened at a word, and a short line gets a shorter label', () => {
    const long = 'Architecture of the payments reconciliation pipeline for the EU-West region after the incident';
    const short = shortLabel(long);
    expect(short.length).toBeLessThanOrEqual(ARROW_LABEL_MAX);
    expect(short.endsWith('…')).toBe(true);
    expect(long.startsWith(short.slice(0, -1))).toBe(true);
    expect(short.slice(0, -1).endsWith(' ')).toBe(false);
    expect(shortLabel('retry ×3')).toBe('retry ×3');
    expect(shortLabel(long, 70).length).toBeLessThanOrEqual(10);
    expect(shortLabel('write', 20)).toBe('write');
  });

  test('a snapshot name too long to keep is cut at a word and says it was cut', () => {
    const typed = `${'dead-letter replay '.repeat(20)}tail`;
    const kept = fitName(typed);
    expect(kept.length).toBeLessThanOrEqual(300);
    expect(kept.endsWith('replay…') || kept.endsWith('dead-letter…')).toBe(true);
    expect(fitName('  two\n lines ')).toBe('two lines');
  });
});

describe('the box a figure is drawn in', () => {
  test('a very wide, a very tall and a one-pixel snapshot all get a box that can be seen and pressed', () => {
    for (const rect of [{ w: 20_000, h: 40 }, { w: 40, h: 20_000 }, { w: 1, h: 1 }, { w: 2_000_000, h: 300 }]) {
      const box = figureBox(rect);
      expect(box.w).toBeGreaterThanOrEqual(FIGURE_MIN.w);
      expect(box.h).toBeGreaterThanOrEqual(FIGURE_MIN.h);
      expect(box.h).toBeLessThanOrEqual(420);
    }
    // An ordinary snapshot keeps exactly its own shape.
    expect(figureBox({ w: 600, h: 300 })).toEqual({ w: 600, h: 300 });
  });
});

describe('a board wider than the furthest zoom can show', () => {
  const view = { x: 0, y: 0, w: 1000, h: 800 };
  test('each edge with something beyond it is marked, and no edge when all of it is in view', () => {
    expect(edgesBeyond({ x: -5000, y: 100, w: 12_000, h: 200 }, view)).toEqual(['e', 'w']);
    expect(edgesBeyond({ x: 10, y: 10, w: 200, h: 200 }, view)).toEqual([]);
    expect(edgesBeyond(null, view)).toEqual([]);
  });

  test('a mark leads to the nearest thing that way', () => {
    const store = new CanvasStore(createDocument('board'));
    const note = (id: string, x: number, y: number): CanvasObject => ({ id, type: 'note', x, y, w: 200, h: 100, text: id });
    store.dispatch({ type: 'add', objects: [note('here', 100, 100), note('near', 3000, 100), note('far', 900_000, 100), note('west', -50_000, 0)] });
    expect(nearestBeyond(store.getDocument(), view, 'e')).toEqual({ x: 3100, y: 150 });
    expect(nearestBeyond(store.getDocument(), view, 'w')).toEqual({ x: -49_900, y: 50 });
    expect(nearestBeyond(store.getDocument(), view, 'n')).toBeNull();
  });
});

describe('a pasted link while its page is looked up', () => {
  test('the card is marked as waiting until the answer comes, and also when none ever does', async () => {
    const store = new CanvasStore(createDocument('board'));
    let answer!: (value: null) => void;
    const id = addReference(store, { x: 0, y: 0 }, { target: { kind: 'web', url: 'https://example.com/a' } }, () => new Promise((resolve) => (answer = resolve)))!;
    expect(previewsPending.has(id)).toBe(true);
    answer(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(previewsPending.has(id)).toBe(false);
    const failing = addReference(store, { x: 0, y: 0 }, { target: { kind: 'web', url: 'https://example.com/b' } }, () => Promise.reject(new Error('down')))!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(previewsPending.has(failing)).toBe(false);
    expect(store.getDocument().objects[failing]).toBeDefined();
  });
});
