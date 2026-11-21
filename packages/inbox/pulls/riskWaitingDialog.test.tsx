import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullRiskAnswer, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { pullsStateOf } from './reviewsTestState';
import type { PullsState } from './usePulls';

const hasDom = typeof document !== 'undefined';
const { inboxApi } = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { InboxApiError } = (hasDom ? await import('../apiError') : {}) as typeof import('../apiError');
const { RISK_ASK_TIMING } = (hasDom ? await import('./riskAskGate') : {}) as typeof import('./riskAskGate');
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

const listOf = (pulls: InboxPull[]) => ({ ...LIST, pulls }) as InboxPullsAnswer;
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
const TIMING = { ...RISK_ASK_TIMING };
let focused = true;
const hadFocus = hasDom ? document.hasFocus : null;
beforeEach(() => {
  Object.assign(RISK_ASK_TIMING, { settleMs: 40, guardMs: 40, tickMs: 5 });
  focused = true;
  document.hasFocus = () => focused;
});
const spy = <K extends keyof typeof inboxApi>(name: K, impl: (typeof inboxApi)[K]) => {
  const made = spyOn(inboxApi, name).mockImplementation(impl as never);
  restores.push(() => made.mockRestore());
};
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const page = (threadId: string | null = null, state: PullsState = pullsStateOf(LIST)) => (
  <SidebarProvider>
    <PullsPage
      state={state}
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
const mount = async (threadId: string | null = null, state?: PullsState) => {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(page(threadId, state)));
  await settle();
};
const rerender = async (state: PullsState) => {
  await act(async () => root!.render(page(null, state)));
  await settle();
};
const wait = async (ms: number) => {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  await settle();
};
const click = async (selector: string) => {
  await act(async () => document.querySelector<HTMLElement>(selector)!.click());
  await settle();
};
const press = async (target: Element) => {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
};
const keyOn = async (target: Element, name: string, repeat = false) => {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, repeat, bubbles: true, cancelable: true })));
  await settle();
};
const button = (name: 'not-now' | 'make-now') => document.querySelector(`[data-pull-risk-waiting-${name}]`)!;
const SETTLED = 60;
const opened = async () => {
  for (let i = 0; i < 200 && !asking(); i++) await wait(2);
  expect(asking()).not.toBeNull();
};
const armed = async () => {
  for (let i = 0; i < 50 && !document.querySelector('[data-pull-risk-waiting-armed]'); i++) await wait(10);
  expect(document.querySelector('[data-pull-risk-waiting-armed]')).not.toBeNull();
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
  Object.assign(RISK_ASK_TIMING, TIMING);
  if (hadFocus) document.hasFocus = hadFocus;
});

test.skipIf(!hasDom)('after a calm moment on Reviews it asks with the count and titles; a press right at open does nothing; Not now sends exactly the shown keys; keys arriving meanwhile wait for a new calm moment', async () => {
  let answer = ANSWER;
  spy('pullRisk', async () => answer);
  const sent: unknown[] = [];
  sentTo(sent, () => answer);
  await mount();
  expect(asking()).toBeNull();
  await opened();
  expect(asking()!.querySelector('h2')!.textContent).toBe('2 already rank High');
  expect(asking()!.querySelector('p')!.textContent).toBe('You turned on guided reviews for High. Make one for each now?');
  expect([...asking()!.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Refund to the card n/b#1', 'Waive the card fee n/b#2']);
  await press(button('not-now'));
  expect(sent).toEqual([]);
  answer = { ...ANSWER, auto_waiting: [key(1), key(2), key(3)] };
  await rerender(pullsStateOf(listOf([...LIST.pulls])));
  expect(asking()!.getAttribute('data-dialog')).toBe('pull-risk-waiting');
  expect(asking()!.querySelectorAll('li')).toHaveLength(2);
  await armed();
  await keyOn(button('not-now'), 'Enter', true);
  expect(sent).toEqual([]);
  await press(button('not-now'));
  expect(sent).toEqual([{ not_now: true, keys: [key(1), key(2)] }]);
  expect(asking()).toBeNull();
  await wait(5);
  expect(asking()).toBeNull();
  await opened();
  expect(asking()!.querySelector('h2')!.textContent).toBe('1 already ranks High');
  expect(asking()!.querySelector('p')!.textContent).toBe('You turned on guided reviews for High. Make one now?');
});

test.skipIf(!hasDom)('a held Escape does nothing; a refused Make them now says why and Not now still asks the server; a failed Not now says so once and the next Escape lets the person out without the server; it does not come back that visit', async () => {
  spy('pullRisk', async () => ANSWER);
  const sent: unknown[] = [];
  let down = false;
  spy('savePullRisk', async (input) => {
    sent.push(input);
    if ('make_now' in input) throw new InboxApiError(409, 'launch_off', 'Starting agents from the Inbox is off in Settings → Agents.');
    if (down) throw 'down';
    return { ...ANSWER, auto_dismissed: [key(1), key(2)] };
  });
  await mount();
  await opened();
  await armed();
  await keyOn(asking()!, 'Escape', true);
  expect(sent).toEqual([]);
  await press(button('make-now'));
  expect(sent).toEqual([{ make_now: true, keys: [key(1), key(2)] }]);
  expect(asking()!.querySelector('[role="alert"]')!.textContent).toBe('Starting agents from the Inbox is off in Settings → Agents.');
  await keyOn(asking()!, 'Escape');
  expect(sent.at(-1)).toEqual({ not_now: true, keys: [key(1), key(2)] });
  expect(asking()).toBeNull();

  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';
  down = true;
  await mount();
  await opened();
  await armed();
  await press(asking()!);
  expect(sent.at(-1)).toEqual({ not_now: true, keys: [key(1), key(2)] });
  expect(asking()!.querySelector('[role="alert"]')!.textContent).toBe('That could not be saved.');
  const before = sent.length;
  await keyOn(asking()!, 'Escape');
  expect(asking()).toBeNull();
  expect(sent).toHaveLength(before);
  await wait(SETTLED * 2);
  expect(asking()).toBeNull();
});

test.skipIf(!hasDom)('an answer that briefly names no agent keeps an open dialog; one with the pick off closes it', async () => {
  let answer: InboxPullRiskAnswer = ANSWER;
  spy('pullRisk', async () => answer);
  const sent: unknown[] = [];
  sentTo(sent);
  await mount();
  await opened();
  answer = { ...ANSWER, auto_agent: null };
  await rerender(pullsStateOf(listOf([...LIST.pulls])));
  expect(asking()).not.toBeNull();
  answer = { ...ANSWER, auto: null };
  await rerender(pullsStateOf(listOf([...LIST.pulls])));
  expect(asking()).toBeNull();
  expect(sent).toEqual([]);
});

test.skipIf(!hasDom)('a bare click (a screen reader sends only that) acts once the first moment has passed, never inside it', async () => {
  spy('pullRisk', async () => ANSWER);
  const sent: unknown[] = [];
  sentTo(sent, () => ({ ...ANSWER, auto_waiting: [] }));
  await mount();
  await opened();
  await click('[data-pull-risk-waiting-make-now]');
  expect(sent).toEqual([]);
  await armed();
  await click('[data-pull-risk-waiting-make-now]');
  expect(sent).toEqual([{ make_now: true, keys: [key(1), key(2)] }]);
  expect(asking()).toBeNull();
});

test.skipIf(!hasDom)('a window that is not focused never gets it; the click that brings the window back does nothing', async () => {
  spy('pullRisk', async () => ANSWER);
  const sent: unknown[] = [];
  sentTo(sent);
  focused = false;
  await mount();
  await wait(SETTLED * 3);
  expect(asking()).toBeNull();
  focused = true;
  await opened();
  await armed();
  await act(async () => window.dispatchEvent(new Event('focus')));
  await press(button('make-now'));
  expect(sent).toEqual([]);
  expect(asking()).not.toBeNull();
  await armed();
  await press(button('not-now'));
  expect(sent).toEqual([{ not_now: true, keys: [key(1), key(2)] }]);
});

test.skipIf(!hasDom)('it waits for the list, a focused field and another open dialog; past five it lists four and "+N more"; a title the list brings later fills in', async () => {
  const keys = [1, 2, 3, 4, 5, 6].map(key);
  spy('pullRisk', async () => ({ ...ANSWER, auto_waiting: keys }));
  await mount(null, pullsStateOf(null));
  await wait(SETTLED * 2);
  expect(asking()).toBeNull();
  const field = document.body.appendChild(document.createElement('input'));
  field.focus();
  await rerender(pullsStateOf(listOf([pull(2, 'Waive the card fee')])));
  await wait(SETTLED * 2);
  expect(asking()).toBeNull();
  const other = document.body.appendChild(document.createElement('dialog'));
  other.setAttribute('open', '');
  field.blur();
  field.remove();
  await wait(SETTLED * 2);
  expect(asking()).toBeNull();
  other.remove();
  await opened();
  expect([...asking()!.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['n/b#1', 'Waive the card fee n/b#2', 'n/b#3', 'n/b#4', '+2 more']);
  await rerender(pullsStateOf(listOf([pull(1, 'Refund to the card'), pull(2, 'Waive the card fee')])));
  expect(asking()!.querySelector('li')!.textContent).toBe('Refund to the card n/b#1');
});

test.skipIf(!hasDom)('never over a thread, nor for what was put off; never beside Risk rules, nor after its own question asked about the same keys; Code review turned off closes it and sends nothing', async () => {
  spy('pullRisk', async () => ANSWER);
  spy('pullRiskModels', async () => ({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: null }));
  await mount('thread-1');
  await wait(SETTLED * 2);
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
  await wait(SETTLED * 2);
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
  await wait(SETTLED * 2);
  expect(asking()).toBeNull();

  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';
  answer = { ...ANSWER, auto_dismissed: [key(1), key(2)] };
  await mount();
  await wait(SETTLED * 2);
  expect(asking()).toBeNull();

  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';
  let off = false;
  restores.splice(0).forEach((restore) => restore());
  spy('pullRisk', async () => {
    if (off) throw new InboxApiError(409, 'code_review_off', 'Code review is off.');
    return ANSWER;
  });
  const posted: unknown[] = [];
  sentTo(posted);
  await mount();
  await opened();
  off = true;
  await rerender(pullsStateOf(listOf([...LIST.pulls])));
  expect(asking()).toBeNull();
  expect(posted).toEqual([]);
});
