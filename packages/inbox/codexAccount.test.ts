import { expect, test } from 'bun:test';
import { codexAccountLine } from './codexAccount';

const now = new Date('2026-11-09T10:00:00');

test('a ChatGPT plan with its limits used; a limit at 90% or more says when it resets', () => {
  expect(codexAccountLine({ state: 'signed_in', kind: 'chatgpt', plan: 'ChatGPT Plus', limits: [{ used_percent: 21, window_mins: 300, resets_at: null }, { used_percent: 40, window_mins: 10080, resets_at: null }] }, now)).toEqual({
    value: 'ChatGPT Plus',
    limits: '5h 21% · week 40%',
    signIn: false,
  });
  const near = codexAccountLine({ state: 'signed_in', kind: 'chatgpt', plan: 'ChatGPT Pro', limits: [{ used_percent: 93, window_mins: 300, resets_at: '2026-11-09T14:20:00' }] }, now)!;
  expect(near.limits).toMatch(/^5h 93% · 5h resets \S/);
  expect(codexAccountLine({ state: 'signed_in', kind: 'chatgpt', plan: 'ChatGPT Plus', limits: null }, now)).toEqual({ value: 'ChatGPT Plus', limits: null, signIn: false });
});

test('an API key, another provider, signed out, and nothing to show', () => {
  expect(codexAccountLine({ state: 'signed_in', kind: 'api_key', plan: null, limits: null })).toEqual({ value: 'API key', limits: null, signIn: false });
  expect(codexAccountLine({ state: 'signed_in', kind: 'other', plan: null, limits: null })).toEqual({ value: 'Signed in', limits: null, signIn: false });
  expect(codexAccountLine({ state: 'signed_out' })).toEqual({ value: 'Not signed in', limits: null, signIn: true });
  expect(codexAccountLine({ state: 'missing' })).toBeNull();
  expect(codexAccountLine({ state: 'unknown' })).toBeNull();
  expect(codexAccountLine(null)).toBeNull();
});
