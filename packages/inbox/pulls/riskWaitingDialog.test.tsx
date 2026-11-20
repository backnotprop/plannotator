import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullRiskAnswer, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { pullsStateOf } from './reviewsTestState';

const hasDom = typeof document !== 'undefined';
const { inboxApi } = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

const key = (n: number) => `github.com/n/b#${n}`;
const pull = (number: number, title: string) =>
  ({
    key: key(number),
    platform: 'github',
    host: 'github.com',
    repo: 'n/b',
    number,
    url: `https://github.com/n/b/pull/${number}`,
    title,
    author: 'tomas',
    mine: false,
    requested: true,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: 'n/b',
    head_sha: `h${number}`,
    additions: 1,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: 'success',
    updated_at: '2026-11-03T10:00:00.000Z',
    merged_at: null,
  }) as unknown as InboxPull;

const LIST = {
  fetched_at: '2026-11-03T10:00:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [pull(1, 'Refund to the card'), pull(2, 'Waive the card fee'), pull(3, 'Fix a typo')],
  links: {},
  projects: {},
  cards: {},
} as unknown as InboxPullsAnswer;

const ANSWER: InboxPullRiskAnswer = {
  rules: 'Anything in billing.',
  provider: 'pi-sdk',
  model: 'a/sonnet',
  agents: [{ id: 'pi-sdk', label: 'Pi' }],
  pending: 0,
  last_failure: null,
  failed: {},
  judgments: { [key(1)]: { level: 'high', why: 'Refunds.' }, [key(2)]: { level: 'high', why: 'Fees.' } },
  auto: { level: 'high', make: 'guide' },
  auto_agent: { agent: 'pi', name: 'Pi' },
  auto_waiting: [key(1), key(2)],
  auto_dismissed: [],
};

let root: Root | null = null;
const restores: (() => void)[] = [];
const spy = <K extends keyof typeof inboxApi>(name: K, impl: (typeof inboxApi)[K]) => {
  const made = spyOn(inboxApi, name).mockImplementation(impl as never);
  restores.push(() => made.mockRestore());
};
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const page = (threadId: string | null = null) => (
  <SidebarProvider>
    <PullsPage
      state={pullsStateOf(LIST)}
      stackId={null}
      threadId={threadId}
      project={null}
      projects={[]}
      projectNames={new Map()}
      phone={false}
      onOpenStack={() => {}}
      filter="all"
      onScope={() => {}}
      onReview={() => {}}
      onOpenThread={() => {}}
      onNew={() => {}}
      onNewReview={() => {}}
    />
  </SidebarProvider>
);
const mount = async (threadId: string | null = null) => {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(page(threadId)));
  await settle();
};
const click = async (selector: string) => {
  await act(async () => document.querySelector<HTMLElement>(selector)!.click());
  await settle();
};
const asking = () => document.querySelector('[data-dialog="pull-risk-waiting"]');
const sentTo = (sent: unknown[], answer: (input: unknown) => InboxPullRiskAnswer = () => ANSWER) =>
  spy('savePullRisk', async (input) => {
    sent.push(input);
    return answer(input);
  });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  for (const restore of restores.splice(0)) restore();
});

test.skipIf(!hasDom)('on Reviews it asks with the count and the titles; Escape is Not now for exactly those keys and it stays closed', async () => {
  spy('pullRisk', async () => ANSWER);
  const sent: unknown[] = [];
  sentTo(sent);
  await mount();
  expect(asking()!.querySelector('h2')!.textContent).toBe('2 already rank High');
  expect(asking()!.querySelector('p')!.textContent).toBe('You turned on guided reviews for High. Make one for each now?');
  expect([...asking()!.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Refund to the card n/b #1', 'Waive the card fee n/b #2']);
  await act(async () => asking()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await settle();
  expect(sent).toEqual([{ not_now: true, keys: [key(1), key(2)] }]);
  expect(asking()).toBeNull();
});

test.skipIf(!hasDom)('Make them now asks for exactly the shown keys and closes; with starting agents off it says why and stays', async () => {
  spy('pullRisk', async () => ANSWER);
  const sent: unknown[] = [];
  let off = true;
  spy('savePullRisk', async (input) => {
    sent.push(input);
    if (off) throw new Error('Starting agents from the Inbox is off in Settings → Agents.');
    return { ...ANSWER, auto_waiting: [] };
  });
  await mount();
  await click('[data-pull-risk-waiting-make-now]');
  expect(asking()!.querySelector('[role="alert"]')!.textContent).toBe('Starting agents from the Inbox is off in Settings → Agents.');
  off = false;
  await click('[data-pull-risk-waiting-make-now]');
  expect(sent).toEqual([
    { make_now: true, keys: [key(1), key(2)] },
    { make_now: true, keys: [key(1), key(2)] },
  ]);
  expect(asking()).toBeNull();
});

test.skipIf(!hasDom)('never over a thread, nor for what was put off; never beside Risk rules, nor after its own question asked about the same keys', async () => {
  spy('pullRisk', async () => ANSWER);
  spy('pullRiskModels', async () => ({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: null }));
  await mount('thread-1');
  expect(asking()).toBeNull();
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';

  restores.splice(0).forEach((restore) => restore());
  let answer: InboxPullRiskAnswer = { ...ANSWER, auto_waiting: [] };
  spy('pullRisk', async () => answer);
  spy('pullRiskModels', async () => ({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: null }));
  const sent: unknown[] = [];
  sentTo(sent);
  await mount();
  expect(asking()).toBeNull();
  await click('[data-pulls-risk-chip]');
  await click('[data-pulls-risk-rules]');
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  expect(document.querySelector('[data-pull-risk-ranked]')).not.toBeNull();
  expect(asking()).toBeNull();
  await click('[data-pull-risk-not-now]');
  expect(sent.at(-1)).toEqual({ not_now: true, keys: [key(1), key(2)] });
  expect(document.querySelector('[data-pull-risk-ranked]')).toBeNull();
  expect(asking()).toBeNull();

  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';
  answer = { ...ANSWER, auto_dismissed: [key(1), key(2)] };
  await mount();
  expect(asking()).toBeNull();
});
