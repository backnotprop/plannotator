import { describe, expect, test } from 'bun:test';
import { parseTypographyConfig } from './config-types';

describe('parseTypographyConfig', () => {
  test('accepts an explicit empty profile for reset', () => {
    expect(parseTypographyConfig({})).toEqual({ ok: true, value: {} });
  });

  test('accepts valid role-specific catalog and custom selections', () => {
    expect(parseTypographyConfig({
      plan: { display: { source: 'catalog', family: 'inter' } },
      review: { mono: { source: 'custom', family: '"Berkeley Mono", monospace' } },
    })).toEqual({
      ok: true,
      value: {
        plan: { display: { source: 'catalog', family: 'inter' } },
        review: { mono: { source: 'custom', family: '"Berkeley Mono", monospace' } },
      },
    });
  });

  test('rejects malformed, unsafe, and role-incompatible input without partial acceptance', () => {
    for (const value of [
      null,
      { plan: null },
      { plan: { display: { source: 'catalog', family: 'fira-code' } } },
      { review: { mono: { source: 'catalog', family: 'inter' } } },
      { review: { mono: { source: 'custom', family: 'x; color: red' } } },
      { unknown: { display: { source: 'catalog', family: 'inter' } } },
    ]) expect(parseTypographyConfig(value).ok).toBe(false);
  });
});
