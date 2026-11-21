/**
 * The window zoom's release (windowPinch.ts): the clamp on the viewport tag
 * must always come off, however often the pane asks.
 */
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
  // A zoomed phone window (as on Android Chrome, which honors the clamp but applies it at a later layout).
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

// Failure to catch: a second release before the first one's frames saving the clamped tag as the original, which
// leaves maximum-scale=1 on the Inbox and pinch off until a reload (two quick file changes, or a hidden tab).
test('two releases in a row leave the viewport tag as it was', () => {
  releaseWindowZoom();
  expect(meta.content).toBe(`${ORIGINAL}, maximum-scale=1`);
  releaseWindowZoom();
  runFrames();
  expect(meta.content).toBe(ORIGINAL);
});

// Failure to catch: the pending guard sticking after its frames, so a later zoom is never released.
test('a release after the last one finished clamps again', () => {
  releaseWindowZoom();
  runFrames();
  releaseWindowZoom();
  expect(meta.content).toBe(`${ORIGINAL}, maximum-scale=1`);
  runFrames();
  expect(meta.content).toBe(ORIGINAL);
});
