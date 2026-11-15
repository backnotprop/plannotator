import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxLaunchChoice, InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';

const hasDom = typeof document !== 'undefined';
const { LaunchChoiceMenu } = (hasDom ? await import('./compose/LaunchChoiceMenu') : {}) as typeof import('./compose/LaunchChoiceMenu');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const models = ['opencode/big-pickle', 'opencode/flint-40b-free', 'opencode/inkling-2-small-free', 'anthropic/claude-opus-4-5', 'anthropic/claude-sonnet-4-5', 'openai/gpt-5.5', 'openai/gpt-6.1-sol', 'openrouter/anthropic/claude-opus-4-5', 'google/gemini-3-pro', 'deepseek/deepseek-v4', 'xai/grok-5', 'mistral/devstral-3'];
const choices: InboxLaunchChoices = { models, efforts: ['low', 'high'], effort_word: 'Variant', model_efforts: Object.fromEntries(models.map((m) => [m, ['low', 'high']])) };

test.skipIf(!hasDom)('a long model list filters as you type; Enter picks the best match and shows the whole list again, so one Escape closes; Escape with words typed clears them first', () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const picks: InboxLaunchChoice[] = [];
  let closed = 0;
  act(() => root!.render(<LaunchChoiceMenu choice={{}} choices={choices} phone={false} onChoice={(next) => picks.push(next)} onClose={() => closed++} />));
  const input = host.querySelector<HTMLInputElement>('[data-compose-choice-filter]')!;
  expect(document.activeElement).toBe(input);
  const rows = () => [...host!.querySelectorAll<HTMLElement>('[data-compose-choice-menu="model"] [data-compose-choice-value]')].map((row) => row.dataset.composeChoiceValue);
  const type = (value: string) =>
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const key = (k: string) => act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));

  type('openrouter opus');
  expect(rows()).toEqual(['default', 'openrouter/anthropic/claude-opus-4-5']);
  key('Enter');
  expect(picks.at(-1)).toEqual({ model: 'openrouter/anthropic/claude-opus-4-5' });
  expect(input.value).toBe('');
  expect(rows()).toHaveLength(models.length + 1);

  type('gemini');
  act(() => host!.querySelector<HTMLButtonElement>('[data-compose-choice-value="google/gemini-3-pro"]')!.click());
  expect(picks.at(-1)).toEqual({ model: 'google/gemini-3-pro' });
  expect(input.value).toBe('');

  type('zzz');
  expect(rows()).toEqual(['default']);
  expect(host.textContent).toContain('No matching models');

  key('Escape');
  expect(input.value).toBe('');
  expect(rows()).toHaveLength(models.length + 1);
  expect(closed).toBe(0);
  key('Escape');
  expect(closed).toBe(1);
});
