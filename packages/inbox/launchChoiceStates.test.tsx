/**
 * New message's model menu for "New OpenCode session": OpenCode's default named on the button and the Default row; and
 * when its list is being read or can't be read, the button still there, Default picked, and one line that says why.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';

const hasDom = typeof document !== 'undefined';
const { useLaunchChoice } = (hasDom ? await import('./compose/useLaunchChoice') : {}) as typeof import('./compose/useLaunchChoice');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const many = ['opencode/big-pickle', 'ollama/qwen2.5-coder:32b', 'vercel/anthropic/claude-sonnet-4.5', 'opencode/grok-code', 'anthropic/claude-sonnet-4-5', 'anthropic/claude-opus-4-5', 'openai/gpt-5', 'openai/gpt-5-codex', 'google/gemini-2.5-pro', 'openrouter/meta-llama/llama-4'];
const listed: InboxLaunchChoices = { models: many, efforts: ['low', 'high'], effort_word: 'Variant', primary_agents: ['build', 'plan'], model_efforts: Object.fromEntries(many.map((m) => [m, ['low', 'high']])) };
const unread = (why: NonNullable<InboxLaunchChoices['unread']>): InboxLaunchChoices => ({ models: [], efforts: [], effort_word: 'Variant', unread: why });
const reading: InboxLaunchChoices = { models: [], efforts: [], effort_word: 'Variant', reading: true };

let sent: Record<string, unknown> = {};
function Compose({ choices, phone = false }: { choices: InboxLaunchChoices; phone?: boolean }) {
  const launch = useLaunchChoice(':opencode', choices, phone);
  sent = launch.send;
  return (
    <div className="pn-inbox">
      {launch.button('ib-cp-tobtn')}
      {launch.menu()}
    </div>
  );
}

function mount(choices: InboxLaunchChoices, phone = false) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Compose choices={choices} phone={phone} />));
  const button = () => host!.querySelector<HTMLButtonElement>('.ib-cp-lchbtn');
  const open = () => act(() => button()!.click());
  const menu = () => host!.querySelector<HTMLElement>('[data-compose-choices]');
  const columns = () => [...host!.querySelectorAll<HTMLElement>('[data-compose-choice-menu]')].map((col) => col.dataset.composeChoiceMenu);
  const notice = () => host!.querySelector<HTMLElement>('[data-compose-choice-notice]');
  return { button, open, menu, columns, notice };
}

test.skipIf(!hasDom)('a known default is named on the button and on the Default row, its provider after it; a picked model shows itself', () => {
  const t = mount({ ...listed, default_model: 'opencode/big-pickle' });
  expect(t.button()!.dataset.composeChoice).toBe('Default (big-pickle)');
  // Only the name may give way: the brackets are their own parts.
  expect(t.button()!.querySelector('.ib-cp-lchdn')!.textContent).toBe('big-pickle');
  expect(t.button()!.querySelector('.ib-cp-lchw')!.textContent).toBe('Default (big-pickle)');
  t.open();
  const row = t.menu()!.querySelector<HTMLElement>('[data-compose-choice-value="default"]')!;
  expect(row.getAttribute('aria-checked')).toBe('true');
  expect(row.querySelector('.ib-cp-lchdef > span:first-child')!.textContent).toBe('Default (big-pickle)');
  expect(row.querySelector('.ib-cp-lchprov')!.textContent).toBe('opencode');
  expect(t.notice()).toBeNull();
  act(() => t.menu()!.querySelector<HTMLButtonElement>('[data-compose-choice-value="ollama/qwen2.5-coder:32b"]')!.click());
  expect(t.button()!.dataset.composeChoice).toBe('qwen2.5-coder:32b');
  expect(t.button()!.querySelector('.ib-cp-lchw')).toBeNull();
  expect(sent).toEqual({ model: 'ollama/qwen2.5-coder:32b' });
});

test.skipIf(!hasDom)('a short list (no filter) names the default on its Default row too', () => {
  const t = mount({ models: ['opencode/big-pickle', 'ollama/qwen2.5-coder:32b'], efforts: [], effort_word: 'Variant', default_model: 'opencode/big-pickle' });
  t.open();
  const row = t.menu()!.querySelector<HTMLElement>('[data-compose-choice-menu="model"] [data-compose-choice-value="default"]')!;
  expect(row.textContent).toBe('Default (big-pickle)opencode');
});

test.skipIf(!hasDom)('an unknown default reads as before: "Default model" and a plain Default row', () => {
  const t = mount(listed);
  expect(t.button()!.dataset.composeChoice).toBe('Default model');
  t.open();
  const row = t.menu()!.querySelector<HTMLElement>('[data-compose-choice-value="default"]')!;
  expect(row.textContent).toBe('Default');
  expect(row.querySelector('.ib-cp-lchprov')).toBeNull();
  expect(t.menu()!.getAttribute('aria-label')).toBe('Model, variant and agent');
});

test.skipIf(!hasDom)("a list that can't be read keeps the button; the menu is Model, Default picked, and one line that says why", () => {
  for (const [why, words] of [
    ['timeout', "Couldn't read OpenCode's models: it took longer than 5 seconds."],
    ['exit', "Couldn't read OpenCode's models: OpenCode stopped with an error."],
    ['empty', 'OpenCode has no models set up.'],
  ] as const) {
    const t = mount(unread(why));
    expect(t.button()!.dataset.composeChoice).toBe('Default model');
    t.open();
    expect(t.menu()!.getAttribute('aria-label')).toBe('Model');
    expect(t.columns()).toEqual(['model']);
    const rows = [...t.menu()!.querySelectorAll<HTMLElement>('[data-compose-choice-value]')];
    expect(rows.map((row) => [row.dataset.composeChoiceValue, row.getAttribute('aria-checked')])).toEqual([['default', 'true']]);
    expect(t.notice()!.textContent).toBe(words);
    expect(t.notice()!.classList.contains('ib-cp-fnotice')).toBe(true);
    expect(t.notice()!.querySelector('.ib-spin')).toBeNull();
    // Default sends nothing: OpenCode decides, as with no menu at all.
    expect(sent).toEqual({});
    act(() => root?.unmount());
    host?.remove();
  }
  root = null;
  host = null;
});

test.skipIf(!hasDom)('while the list is read: the button, Default picked, and a spinner with "Reading OpenCode\'s models…"; a phone\'s header reads "Model"', () => {
  const t = mount(reading, true);
  expect(t.button()!.dataset.composeChoice).toBe('Default model');
  t.open();
  expect(t.menu()!.querySelector('.ib-cp-pickhead > span')!.textContent).toBe('Model');
  expect(t.notice()!.textContent).toBe("Reading OpenCode's models…");
  expect(t.notice()!.querySelector('.ib-spin')).not.toBeNull();
  expect(t.menu()!.querySelector('[data-compose-choice-value="default"]')!.getAttribute('aria-checked')).toBe('true');
});
