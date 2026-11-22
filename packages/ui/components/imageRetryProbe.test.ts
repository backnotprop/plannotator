/**
 * ui's off-page retry loads (imageRetryProbe.ts): at most four at a time, and a load that never ends gives its slot
 * up at the timeout. What regresses if this fails: four hung loads stall every later retry in the window for good,
 * or a cancelled load keeps its request.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { PROBE_TIMEOUT_MS, probeImage } from './imageRetryProbe';

/** An `Image` stand-in that loads nothing by itself: a test ends each load, or lets it hang. */
class FakeImage {
  static made: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    FakeImage.made.push(this);
  }
}

const saved = (globalThis as { Image?: unknown }).Image;
beforeEach(() => {
  FakeImage.made = [];
  (globalThis as { Image?: unknown }).Image = FakeImage;
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  (globalThis as { Image?: unknown }).Image = saved;
});

test('four loads that never end give their slots up at the timeout, and the next one starts', () => {
  const results: (boolean | string)[] = [];
  for (let i = 0; i < 4; i += 1) probeImage(`/hung-${i}.png`, (loaded) => results.push(loaded));
  probeImage('/next.png', (loaded) => results.push(`next:${loaded}`));
  expect(FakeImage.made.map((image) => image.src)).toEqual(['/hung-0.png', '/hung-1.png', '/hung-2.png', '/hung-3.png']);
  jest.advanceTimersByTime(PROBE_TIMEOUT_MS - 1);
  expect(FakeImage.made).toHaveLength(4);
  jest.advanceTimersByTime(1);
  expect(results).toEqual([false, false, false, false]);
  expect(FakeImage.made.at(-1)?.src).toBe('/next.png');
  FakeImage.made.at(-1)!.onload?.();
  expect(results.at(-1)).toBe('next:true');
});

test('a cancelled load clears its src and says nothing; the queue moves on when it ends', () => {
  const results: string[] = [];
  const cancels = Array.from({ length: 4 }, (_, i) => probeImage(`/a-${i}.png`, () => results.push(`a-${i}`)));
  probeImage('/b.png', () => results.push('b'));
  cancels[0]();
  expect(FakeImage.made[0].src).toBe('');
  // The browser ends the dropped request with an error: its slot goes to the queued load.
  FakeImage.made[0].onerror?.();
  expect(results).toEqual([]);
  expect(FakeImage.made.at(-1)?.src).toBe('/b.png');
  jest.advanceTimersByTime(PROBE_TIMEOUT_MS);
});
