import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Mermaid } from 'mermaid';
import {
  __setMermaidRuntimeLoaderForTests,
  getMermaidRuntime,
  getMermaidRuntimeSource,
  loadMermaidRuntime,
  setMermaidRuntime,
} from './mermaid';

const fakeRuntime = { initialize() {}, render: async () => ({ svg: '<svg/>' }) } as unknown as Mermaid;

beforeEach(() => {
  __setMermaidRuntimeLoaderForTests(undefined);
});

afterEach(() => {
  __setMermaidRuntimeLoaderForTests(undefined);
});

describe('filled slot', () => {
  test('resolves at once without calling the loader (single-initialize guarantee)', async () => {
    let loads = 0;
    __setMermaidRuntimeLoaderForTests(async () => {
      loads += 1;
      return fakeRuntime;
    });
    setMermaidRuntime(fakeRuntime, 'plannotator-mermaid-eager');

    expect(getMermaidRuntime()).toBe(fakeRuntime);
    expect(getMermaidRuntimeSource()).toBe('plannotator-mermaid-eager');
    expect(await loadMermaidRuntime()).toBe(fakeRuntime);
    expect(await loadMermaidRuntime()).toBe(fakeRuntime);
    expect(loads).toBe(0);
  });
});

describe('empty slot', () => {
  test('calls the loader once, memoizes, and fills the slot with source loader', async () => {
    let loads = 0;
    __setMermaidRuntimeLoaderForTests(async () => {
      loads += 1;
      return fakeRuntime;
    });
    expect(getMermaidRuntime()).toBeNull();

    const [a, b] = await Promise.all([loadMermaidRuntime(), loadMermaidRuntime()]);
    expect(a).toBe(fakeRuntime);
    expect(b).toBe(fakeRuntime);
    expect(await loadMermaidRuntime()).toBe(fakeRuntime);
    expect(loads).toBe(1);
    expect(getMermaidRuntime()).toBe(fakeRuntime);
    expect(getMermaidRuntimeSource()).toBe('loader');
  });

  test('a rejected load is dropped so the next call re-attempts', async () => {
    let attempts = 0;
    __setMermaidRuntimeLoaderForTests(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk failed');
      return fakeRuntime;
    });

    await expect(loadMermaidRuntime()).rejects.toThrow('chunk failed');
    expect(getMermaidRuntime()).toBeNull();
    expect(await loadMermaidRuntime()).toBe(fakeRuntime);
    expect(attempts).toBe(2);
  });
});
