import { describe, expect, test } from 'bun:test';
import { createDocument } from '../model/document';
import { CanvasStore } from '../events/store';
import type { CanvasObject } from '../model/types';
import { FIGURE_MIN, figureBox, fitName } from '../snapshot/SnapshotFigure';
import { CHART_NAMED_DROP, CHART_NAMED_MAX, HTML_FRAMES_DROP, HTML_FRAMES_MAX, chartDetailNext, htmlFramesNext } from './CanvasView';
import { edgesBeyond, nearestBeyond } from './EdgeMarkers';
import { ARROW_LABEL_MAX, shortLabel } from './objects';
import { faceColor } from './people';
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

describe('the colour of a person\'s mark', () => {
  test('is the host\'s colour when it is a colour, and nothing at all otherwise', () => {
    expect(faceColor({ color: '#B9A6FF' })).toBe('#B9A6FF');
    expect(faceColor({ color: ' oklch(0.7 0.1 290) ' })).toBe('oklch(0.7 0.1 290)');
    expect(faceColor({ color: 'rebeccapurple' })).toBe('rebeccapurple');
    expect(faceColor({})).toBeUndefined();
    expect(faceColor(null)).toBeUndefined();
    // Anything that could load, run, read a variable or end the declaration is not a colour.
    for (const color of [
      'red; background: url(https://evil.example/x)',
      'url(javascript:alert(1))',
      'var(--background)',
      'rgb(0 0 0); position: fixed',
      'color-mix(in srgb, red, blue)',
      'rgb(calc(1 * 2) 0 0)',
      'transparent',
      'currentcolor',
      'inherit',
      '',
      '#12',
      'expression(alert(1))',
      '</style><script>',
      `#${'f'.repeat(200)}`,
      `rgb(${'1 '.repeat(200)})`,
      0,
      true,
      ['#fff'],
      { custom: '#fff' },
      { toString: () => '#fff' },
    ]) {
      expect(faceColor({ color })).toBeUndefined();
    }
  });
});

describe('HTML items when the board is zoomed out', () => {
  test('frames are dropped past ten on screen and come back at eight, so one item at the edge does not turn them all over', () => {
    // Close up, every item is itself however many there are.
    expect(htmlFramesNext(false, 'full', 500)).toBe(true);
    // Walking the count up and down, as a pan across a board with items along it does.
    let kept = true;
    const seen: boolean[] = [];
    for (const onScreen of [3, 8, 9, 10, 11, 10, 9, 10, 9, 8, 9, 10, 11]) seen.push((kept = htmlFramesNext(kept, 'plain', onScreen)));
    expect(seen).toEqual([true, true, true, true, false, false, false, false, false, true, true, true, false]);
    expect(HTML_FRAMES_MAX).toBeLessThan(HTML_FRAMES_DROP);
  });
});

describe('how much of a chart is written out', () => {
  /** A walk: the zoom's level and how many objects are mounted at each step. How many times the detail changed. */
  const changes = (steps: [zoom: 'full' | 'plain' | 'far', mounted: number][]): { seen: string[]; changes: number } => {
    let named = true;
    const seen: string[] = [];
    for (const [zoom, mounted] of steps) {
      const detail = chartDetailNext(named, zoom, mounted);
      if (zoom === 'plain') named = detail === 'named';
      seen.push(detail);
    }
    return { seen, changes: seen.filter((detail, i) => i > 0 && detail !== seen[i - 1]).length };
  };

  test('a pan that hovers round one number of mounted objects changes the detail once at most, not at every step', () => {
    // Sixty pans across the old boundary (150), a few objects either side, below 45%.
    for (const centre of [CHART_NAMED_MAX, 150, CHART_NAMED_DROP]) {
      const walk = Array.from({ length: 60 }, (_step, i): ['plain', number] => ['plain', centre + [-4, 3, -2, 5, -5, 2][i % 6]]);
      expect(changes(walk).changes).toBeLessThanOrEqual(1);
    }
    // It does change when the board really fills up, and back when it really empties: once each way.
    const there = changes([['plain', 100], ['plain', 150], ['plain', CHART_NAMED_DROP + 1], ['plain', 150], ['plain', CHART_NAMED_MAX + 1], ['plain', CHART_NAMED_MAX], ['plain', 150]]);
    expect(there.seen).toEqual(['named', 'named', 'marks', 'marks', 'marks', 'named', 'named']);
  });

  test('all of it at 45% and over; no words under 20%, however few objects; a title and key between, on a board that is not crowded', () => {
    expect(chartDetailNext(true, 'full', 5000)).toBe('full');
    expect(chartDetailNext(false, 'full', 1)).toBe('full');
    expect(chartDetailNext(true, 'far', 1)).toBe('marks');
    expect(chartDetailNext(true, 'plain', 12)).toBe('named');
    expect(chartDetailNext(true, 'plain', 2000)).toBe('marks');
  });
});
