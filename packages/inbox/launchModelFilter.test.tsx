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

test.skipIf(!hasDom)("OpenCode's own agents get an Agent column beside the variant: a pick keeps the model, Default takes it off; none listed, no column", async () => {
  const { initialLaunchChoice, launchChoiceButton, launchChoiceSend, pickLaunchModel } = await import('./compose/launchChoice');
  const short: InboxLaunchChoices = { models: ['opencode/big-pickle', 'opencode/flint'], efforts: ['low', 'high'], effort_word: 'Variant', primary_agents: ['build', 'plan'] };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const picks: InboxLaunchChoice[] = [];
  const render = (choice: InboxLaunchChoice, lists: InboxLaunchChoices) =>
    act(() => root!.render(<LaunchChoiceMenu choice={choice} choices={lists} phone={false} onChoice={(next) => picks.push(next)} onClose={() => {}} />));
  render({ model: 'opencode/big-pickle' }, short);
  const column = host.querySelector<HTMLElement>('[data-compose-choice-menu="primary_agent"]')!;
  expect(column.getAttribute('aria-label')).toBe('Agent');
  expect([...column.querySelectorAll<HTMLElement>('[data-compose-choice-value]')].map((row) => row.textContent)).toEqual(['Default', 'build', 'plan']);
  expect(host.querySelector('[data-compose-choices]')!.getAttribute('aria-label')).toBe('Model, variant and agent');
  act(() => column.querySelector<HTMLButtonElement>('[data-compose-choice-value="plan"]')!.click());
  expect(picks.at(-1)).toEqual({ model: 'opencode/big-pickle', primary_agent: 'plan' });

  render({ model: 'opencode/big-pickle', primary_agent: 'plan' }, short);
  act(() => host!.querySelector<HTMLButtonElement>('[data-compose-choice-menu="primary_agent"] [data-compose-choice-value="default"]')!.click());
  expect(picks.at(-1)).toEqual({ model: 'opencode/big-pickle' });
  // Another model keeps the agent; the button and the Send carry it.
  expect(pickLaunchModel({ model: 'opencode/big-pickle', primary_agent: 'plan' }, short, 'opencode/flint')).toEqual({ model: 'opencode/flint', primary_agent: 'plan' });
  expect(launchChoiceButton({ primary_agent: 'plan' }, short)).toBe('Default model · plan');
  expect(launchChoiceSend({ model: 'opencode/flint', primary_agent: 'plan' })).toEqual({ model: 'opencode/flint', primary_agent: 'plan' });
  // The last start's agent comes back while OpenCode still lists it.
  expect(initialLaunchChoice({ ...short, last: { primary_agent: 'plan' } })).toEqual({ primary_agent: 'plan' });
  expect(initialLaunchChoice({ ...short, last: { primary_agent: 'gone' } })).toEqual({});

  const { primary_agents: _none, ...noModes } = short;
  render({}, noModes);
  expect(host.querySelector('[data-compose-choice-menu="primary_agent"]')).toBeNull();
  expect(host.querySelector('[data-compose-choices]')!.getAttribute('aria-label')).toBe('Model and variant');
});
