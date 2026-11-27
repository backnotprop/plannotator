import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPullRiskAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { inboxApi } = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { RiskRulesDialog } = (hasDom ? await import('./RiskRulesDialog') : {}) as typeof import('./RiskRulesDialog');

const SAVED: InboxPullRiskAnswer = {
  rules: 'Anything in billing.',
  provider: 'pi-sdk',
  model: 'a/sonnet',
  agents: [{ id: 'pi-sdk', label: 'Pi' }],
  pending: 0,
  last_failure: null,
  failed: {},
  judgments: {},
  auto: { level: 'high', make: 'guide' },
  auto_agent: { agent: 'pi', name: 'Pi' },
};

let root: Root | null = null;
const restores: (() => void)[] = [];
const spy = <K extends keyof typeof inboxApi>(name: K, impl: (typeof inboxApi)[K]) => {
  const made = spyOn(inboxApi, name).mockImplementation(impl as never);
  restores.push(() => made.mockRestore());
  return made;
};
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const mount = async (node: React.ReactNode) => {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await settle();
};
const submit = async () => {
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
};
const click = async (selector: string) => {
  await act(async () => document.querySelector<HTMLElement>(selector)!.click());
  await settle();
};
const key = async (selector: string, name: string) => {
  await act(async () => document.querySelector(selector)!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
};
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  for (const restore of restores.splice(0)) restore();
});

test.skipIf(!hasDom)('Save with a pick asks about the PRs that already rank there: Not now starts nothing, Make them now asks the server once for exactly the PRs it counted', async () => {
  spy('pullRiskModels', async () => ({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: null }));
  const made: unknown[] = [];
  spy('savePullRisk', async (input) => {
    if ('make_now' in input) {
      made.push(input);
      return { ...SAVED, auto_would_start: { high: 0, medium: 1 } };
    }
    return { ...SAVED, auto_would_start: { high: 2, medium: 3 }, auto_waiting: ['github.com/n/b#1', 'github.com/n/b#2'] };
  });
  const done: InboxPullRiskAnswer[] = [];
  await mount(<RiskRulesDialog answer={SAVED} onSaved={(next) => done.push(next)} onClose={() => {}} />);
  await submit();
  expect(done).toEqual([]);
  expect(document.querySelector('[data-pull-risk-ranked]')!.getAttribute('data-pull-risk-ranked')).toBe('2');
  await click('[data-pull-risk-not-now]');
  expect(made).toEqual([]);
  expect(done.map((one) => one.auto_would_start)).toEqual([{ high: 2, medium: 3 }]);
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';

  await mount(<RiskRulesDialog answer={SAVED} onSaved={(next) => done.push(next)} onClose={() => {}} />);
  await submit();
  await click('[data-pull-risk-make-now]');
  expect(made).toEqual([{ make_now: true, keys: ['github.com/n/b#1', 'github.com/n/b#2'] }]);
  expect(done.at(-1)!.auto_would_start).toEqual({ high: 0, medium: 1 });
});

test.skipIf(!hasDom)('nothing already ranked, or nothing picked: Save closes at once with no question', async () => {
  spy('pullRiskModels', async () => ({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: null }));
  const answers = [{ ...SAVED, auto_would_start: { high: 0, medium: 4 } }, { ...SAVED, auto: null, auto_would_start: { high: 0, medium: 0 } }];
  spy('savePullRisk', async () => answers.shift()!);
  let done = 0;
  await mount(<RiskRulesDialog answer={SAVED} onSaved={() => done++} onClose={() => {}} />);
  await submit();
  expect(done).toBe(1);
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';
  await mount(<RiskRulesDialog answer={{ ...SAVED, auto: null }} onSaved={() => done++} onClose={() => {}} />);
  await submit();
  expect(done).toBe(2);
  expect(document.querySelector('[data-pull-risk-ranked]')).toBeNull();
});

test.skipIf(!hasDom)('an info button opens on a tap, and Escape closes it without closing the dialog and its words', async () => {
  spy('pullRiskModels', async () => ({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: null }));
  let closed = 0;
  await mount(<RiskRulesDialog answer={SAVED} onSaved={() => {}} onClose={() => closed++} />);
  const info = '[data-pull-risk-info="rules"]';
  expect(document.querySelector(info)!.hasAttribute('data-open')).toBe(false);
  await click(info);
  expect(document.querySelector(info)!.hasAttribute('data-open')).toBe(true);
  await key(info, 'Escape');
  expect(document.querySelector(info)!.hasAttribute('data-open')).toBe(false);
  expect(closed).toBe(0);
  await key(info, 'Escape');
  expect(closed).toBe(1);
});

test.skipIf(!hasDom)('no agent can start here: Save closes with no question, so nothing is offered that would only fail', async () => {
  spy('pullRiskModels', async () => ({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: null }));
  spy('savePullRisk', async () => ({ ...SAVED, auto_agent: null, auto_would_start: { high: 2, medium: 2 } }));
  let done = 0;
  await mount(<RiskRulesDialog answer={SAVED} onSaved={() => done++} onClose={() => {}} />);
  await submit();
  expect(done).toBe(1);
  expect(document.querySelector('[data-pull-risk-ranked]')).toBeNull();
});

test.skipIf(!hasDom)('a refused Make them now says why in the question and closes nothing', async () => {
  spy('pullRiskModels', async () => ({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: null }));
  spy('savePullRisk', async (input) => {
    if ('make_now' in input) throw new Error('Starting agents from the Inbox is off in Settings → Agents.');
    return { ...SAVED, auto_would_start: { high: 2, medium: 2 } };
  });
  let done = 0;
  await mount(<RiskRulesDialog answer={SAVED} onSaved={() => done++} onClose={() => {}} />);
  await submit();
  await click('[data-pull-risk-make-now]');
  expect(done).toBe(0);
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('off in Settings');
});
