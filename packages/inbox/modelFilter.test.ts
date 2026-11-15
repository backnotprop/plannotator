import { expect, test } from 'bun:test';
import { filterLaunchModels } from './compose/modelFilter';

const MODELS = [
  'anthropic/claude-opus-4-5',
  'anthropic/claude-sonnet-4-5',
  'openai/gpt-5.5',
  'openai/gpt-6.1-sol',
  'openrouter/anthropic/claude-opus-4-5',
  'openrouter/openai/gpt-5.5',
  'opencode/flint-40b-free',
  'opencode/big-pickle',
  'google/gemini-3-pro',
];

test("Pi's model filter: subsequence per token, all tokens, best first; provider prefixes and swapped letters and digits", () => {
  const cases: [string, string[]][] = [
    ['', MODELS],
    ['opus', ['anthropic/claude-opus-4-5', 'openrouter/anthropic/claude-opus-4-5', 'anthropic/claude-sonnet-4-5']],
    ['openrouter opus', ['openrouter/anthropic/claude-opus-4-5']],
    ['opus openrouter', ['openrouter/anthropic/claude-opus-4-5']],
    ['openai/gpt', ['openai/gpt-5.5', 'openai/gpt-6.1-sol', 'openrouter/openai/gpt-5.5']],
    ['flnt', ['opencode/flint-40b-free']],
    ['gemini3', ['google/gemini-3-pro']],
    ['3gemini', ['google/gemini-3-pro']],
    ['sonnet 4', ['anthropic/claude-sonnet-4-5']],
    ['zzz', []],
  ];
  for (const [query, expected] of cases) expect(filterLaunchModels(MODELS, query), query).toEqual(expected);
});
