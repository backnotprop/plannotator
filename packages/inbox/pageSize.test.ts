import { describe, expect, test } from 'bun:test';
import { PAGE_DESKTOP_WIDTH, PAGE_SIZE_KEPT, PAGE_SIZE_KEY, desktopFitScale, pageIsWide, readPageSize, shownPageSize, writePageSize } from './pageSize';

function memoryStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    raw: () => map.get(PAGE_SIZE_KEY),
  };
}

describe('a wide page', () => {
  test('is one that lays out clearly past its frame', () => {
    expect(pageIsWide({ width: 1180, viewport: 390 })).toBe(true);
    expect(pageIsWide({ width: 585, viewport: 390 })).toBe(true);
    expect(pageIsWide({ width: 768, viewport: 390 })).toBe(true);
  });
  test('a phone-friendly page with one long hash or URL poking out is not', () => {
    expect(pageIsWide({ width: 500, viewport: 390 })).toBe(false);
    expect(pageIsWide({ width: 584, viewport: 390 })).toBe(false);
  });
  test('a page that fits, or is off by rounding, is not', () => {
    expect(pageIsWide({ width: 390, viewport: 390 })).toBe(false);
    expect(pageIsWide({ width: 391, viewport: 390 })).toBe(false);
    expect(pageIsWide({ width: 0, viewport: 0 })).toBe(false);
  });
});

test('Desktop size fits 1280 into the box, and never enlarges', () => {
  expect(PAGE_DESKTOP_WIDTH).toBe(1280);
  expect(desktopFitScale(390)).toBeCloseTo(390 / 1280, 6);
  expect(desktopFitScale(1600)).toBe(1);
  expect(desktopFitScale(0)).toBe(1);
});

describe('the picked size', () => {
  test('is kept per file and read back after a reload', () => {
    const store = memoryStore();
    expect(readPageSize('/work/a/report.html', store)).toBeNull();
    writePageSize('/work/a/report.html', 'phone', store);
    writePageSize('/work/b/report.html', 'desktop', store);
    const reloaded = memoryStore({ [PAGE_SIZE_KEY]: store.raw()! });
    expect(readPageSize('/work/a/report.html', reloaded)).toBe('phone');
    expect(readPageSize('/work/b/report.html', reloaded)).toBe('desktop');
    expect(readPageSize('/work/c/report.html', reloaded)).toBeNull();
  });

  test('wins over the page width; before a pick a wide page opens on Desktop size', () => {
    expect(shownPageSize(null, true)).toBe('desktop');
    expect(shownPageSize(null, false)).toBe('phone');
    expect(shownPageSize('phone', true)).toBe('phone');
    expect(shownPageSize('desktop', false)).toBe('desktop');
  });

  test('a new pick replaces the old one, and the oldest files go first once the store is full', () => {
    const store = memoryStore();
    for (let i = 0; i < PAGE_SIZE_KEPT; i++) writePageSize(`/f/${i}.html`, 'desktop', store);
    writePageSize('/f/0.html', 'phone', store);
    writePageSize('/f/new.html', 'desktop', store);
    expect(readPageSize('/f/0.html', store)).toBe('phone');
    expect(readPageSize('/f/1.html', store)).toBeNull();
    expect(readPageSize('/f/2.html', store)).toBe('desktop');
    expect(readPageSize('/f/new.html', store)).toBe('desktop');
    expect(Object.keys(JSON.parse(store.raw()!))).toHaveLength(PAGE_SIZE_KEPT);
  });

  test('a broken or foreign stored value reads as no pick', () => {
    expect(readPageSize('/a.html', memoryStore({ [PAGE_SIZE_KEY]: '{not json' }))).toBeNull();
    expect(readPageSize('/a.html', memoryStore({ [PAGE_SIZE_KEY]: '["desktop"]' }))).toBeNull();
    expect(readPageSize('/a.html', memoryStore({ [PAGE_SIZE_KEY]: '{"/a.html":"tablet"}' }))).toBeNull();
    expect(readPageSize('/a.html', null)).toBeNull();
  });

  test('a store that refuses the write does not break the press', () => {
    const store = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(() => writePageSize('/a.html', 'desktop', store)).not.toThrow();
  });
});
