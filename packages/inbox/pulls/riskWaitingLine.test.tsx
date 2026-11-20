import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPullRiskAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { inboxApi } = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { RiskWaitingLine } = (hasDom ? await import('./RiskWaitingLine') : {}) as typeof import('./RiskWaitingLine');

const ANSWER: InboxPullRiskAnswer = {
  rules: 'Anything in billing.',
  provider: 'pi-sdk',
  model: null,
  agents: [{ id: 'pi-sdk', label: 'Pi' }],
  pending: 0,
  last_failure: null,
  failed: {},
  judgments: {},
  auto: { level: 'high', make: 'guide' },
  auto_agent: { agent: 'pi', name: 'Pi' },
  auto_waiting: ['a#1', 'a#2', 'a#3'],
  auto_dismissed: ['a#2'],
};

let root: Root | null = null;
const restores: (() => void)[] = [];
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  for (const restore of restores.splice(0)) restore();
});
const mount = async (answer: InboxPullRiskAnswer, onAnswer: (next: InboxPullRiskAnswer) => void = () => {}) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<RiskWaitingLine answer={answer} onAnswer={onAnswer} />));
};
const line = () => document.querySelector('[data-pull-risk-waiting]');

test.skipIf(!hasDom)('the line counts what waits minus what was put off, and Make them now sends exactly those keys', async () => {
  const sent: unknown[] = [];
  const made = spyOn(inboxApi, 'savePullRisk').mockImplementation((async (input: unknown) => {
    sent.push(input);
    return { ...ANSWER, auto_waiting: [], auto_dismissed: [] };
  }) as never);
  restores.push(() => made.mockRestore());
  const answers: InboxPullRiskAnswer[] = [];
  await mount(ANSWER, (next) => answers.push(next));
  expect(line()!.getAttribute('data-pull-risk-waiting')).toBe('2');
  expect(line()!.querySelector('.ib-riskw-t')!.textContent).toBe('2 rank High.');
  await act(async () => document.querySelector<HTMLElement>('[data-pull-risk-waiting-make-now]')!.click());
  expect(sent).toEqual([{ make_now: true, keys: ['a#1', 'a#3'] }]);
  expect(answers).toHaveLength(1);
});

test.skipIf(!hasDom)('nothing left to ask about, or no agent that can start: no line', async () => {
  await mount({ ...ANSWER, auto_dismissed: ['a#1', 'a#2', 'a#3'] });
  expect(line()).toBeNull();
  await act(async () => root!.render(<RiskWaitingLine answer={{ ...ANSWER, auto_agent: null, auto_agent_unavailable: 'Pi is not signed in.' }} onAnswer={() => {}} />));
  expect(line()).toBeNull();
  expect(document.querySelector('[role="status"]')).not.toBeNull();
});
