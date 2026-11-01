import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetSendKeys, keepSendKeys, keptSendKeys } from './sendKeys';
import type { SentContents } from './sendTargets';

const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let held: Map<string, string>;

beforeEach(() => {
  held = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => held.get(k) ?? null, setItem: (k: string, v: string) => void held.set(k, v), removeItem: (k: string) => void held.delete(k) },
  });
});

afterEach(() => {
  if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const contents = new Map<string, SentContents>([['s:a', { value: 'the words', answers: ['m/q'] }]]);
const keys = new Map([['s:a', 'key-1']]);

describe('sendKeys', () => {
  test('a reload finds the key and the contents of a Send that never heard back', () => {
    keepSendKeys('t1', keys, contents, 1000);
    expect(keptSendKeys('t1', 2000)).toEqual({ keys, contents });
  });

  test('one thread never finds another thread\'s key', () => {
    keepSendKeys('t1', keys, contents, 1000);
    expect(keptSendKeys('t2', 2000)).toBeNull();
  });

  test('a confirmed Send leaves nothing, so the same words later are a new reply', () => {
    keepSendKeys('t1', keys, contents, 1000);
    forgetSendKeys('t1', 2000);
    expect(keptSendKeys('t1', 3000)).toBeNull();
    expect(held.size).toBe(0);
  });

  test('a key outlives no request: after ten minutes the same words are a new reply', () => {
    keepSendKeys('t1', keys, contents, 0);
    expect(keptSendKeys('t1', 10 * 60_000 - 1)).not.toBeNull();
    expect(keptSendKeys('t1', 10 * 60_000)).toBeNull();
  });

  test('storage that refuses or holds junk costs the key only, never the Send', () => {
    held.set('plannotator-inbox-send-keys', 'not json');
    expect(keptSendKeys('t1')).toBeNull();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
        removeItem: () => {},
      },
    });
    expect(() => keepSendKeys('t1', keys, contents)).not.toThrow();
  });
});
