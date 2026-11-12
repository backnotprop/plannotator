import { afterEach, beforeEach, expect, test } from 'bun:test';
import { releaseWindowZoom } from './windowPinch';

const ORIGINAL = 'width=device-width, initial-scale=1.0, viewport-fit=cover';

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, document: g.document, requestAnimationFrame: g.requestAnimationFrame };
let frames: Array<() => void> = [];
const meta = { content: ORIGINAL };

function runFrames(): void {
  while (frames.length > 0) {
    const due = frames;
    frames = [];
    for (const frame of due) frame();
  }
}

beforeEach(() => {
  frames = [];
  meta.content = ORIGINAL;
  g.window = { visualViewport: { scale: 2 } };
  g.document = { querySelector: (selector: string) => (selector === 'meta[name="viewport"]' ? meta : null) };
  g.requestAnimationFrame = (callback: () => void) => {
    frames.push(callback);
    return frames.length;
  };
});

afterEach(() => {
  runFrames();
  g.window = saved.window;
  g.document = saved.document;
  g.requestAnimationFrame = saved.requestAnimationFrame;
});

test('two releases in a row leave the viewport tag as it was', () => {
  releaseWindowZoom();
  expect(meta.content).toBe(`${ORIGINAL}, maximum-scale=1`);
  releaseWindowZoom();
  runFrames();
  expect(meta.content).toBe(ORIGINAL);
});

test('a release after the last one finished clamps again', () => {
  releaseWindowZoom();
  runFrames();
  releaseWindowZoom();
  expect(meta.content).toBe(`${ORIGINAL}, maximum-scale=1`);
  runFrames();
  expect(meta.content).toBe(ORIGINAL);
});
