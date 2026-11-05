/**
 * PR risk ranking in the window. What regresses:
 *  - the filter hiding what it should keep (a stack's high layer, a row in the folded group), or hiding a row with a
 *    layer not ranked without a word;
 *  - a save during the model read leaving the agent on the person's own, possibly expensive, default;
 *  - a merged layer's old judgment deciding a stack;
 *  - the filter closing the stack open beside the list;
 *  - a tap on a mark opening the row instead of showing the sentence;
 *  - the dialog losing the person's words when a save fails, or keeping the last agent's model after a switch;
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullRiskAnswer, InboxPullsAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { inboxApi } = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { RiskRulesDialog } = (hasDom ? await import('./RiskRulesDialog') : {}) as typeof import('./RiskRulesDialog');

const key = (n: number) => `github.com/n/b#${n}`;
function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  return {
    key: key(number),
    platform: 'github',
    host: 'github.com',
    repo: 'n/b',
    number,
    url: `https://github.com/n/b/pull/${number}`,
    title: `PR ${number}`,
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
    ...fields,
  } as InboxPull;
}

const LIST: InboxPullsAnswer = {
  fetched_at: '2026-11-03T10:00:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  // #4 waits on others, in the folded group: mine, and its review is someone else's.
  pulls: [pull(1), pull(2), pull(3), pull(4, { mine: true, requested: false, author: 'dana', reviewers: ['jun'] }), pull(5), pull(6, { base: 'b5' }), pull(7, { state: 'merged', merged_at: '2026-11-02T10:00:00.000Z', head: 'b7' }), pull(8, { base: 'b7' })],
  links: {},
  projects: {},
  cards: {},
} as unknown as InboxPullsAnswer;

const JUDGED: InboxPullRiskAnswer = {
  rules: 'Anything in billing.',
  provider: 'pi-sdk',
  model: 'a/sonnet',
  agents: [{ id: 'pi-sdk', label: 'Pi' }],
  pending: 0,
  agent_failed: false,
  judgments: {
    [key(1)]: { level: 'low', why: 'Docs only.' },
    [key(2)]: { level: 'high', why: 'It changes charges.' },
    [key(3)]: { level: 'medium', why: 'It may reach charges.' },
    [key(4)]: { level: 'high', why: 'It changes invoices.' },
    [key(5)]: { level: 'low', why: 'It moves files.' },
    [key(6)]: { level: 'high', why: 'It changes permissions.' },
    // A stale judgment of a merged layer can't decide #8's stack.
    [key(7)]: { level: 'high', why: 'Old.' },
    [key(8)]: { level: 'low', why: 'A small fix.' },
  },
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
beforeEach(() => window.localStorage?.clear());
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  for (const restore of restores.splice(0)) restore();
});

const page = (stackId: string | null = null, opened: string[] = []) => (
  <SidebarProvider>
    <PullsPage
      state={{ model: LIST, error: null, loading: false, refresh: () => {}, reload: () => {} }}
      stackId={stackId}
      project={null}
      projects={[]}
      projectNames={new Map()}
      phone={false}
      onOpenStack={(id) => id && opened.push(id)}
      onProject={() => {}}
      onReview={() => {}}
      onOpenThread={() => {}}
      onLaunch={() => {}}
      onStarted={() => {}}
    />
  </SidebarProvider>
);
const shownRows = () => [...document.querySelectorAll('[data-pulls-row]')].map((r) => r.getAttribute('data-pulls-row'));
const markOf = (n: number) => document.querySelector(`[data-pulls-row="${key(n)}"] [data-pull-risk]`)?.getAttribute('data-pull-risk') ?? null;

test.skipIf(!hasDom)('no rules: the chip and no marks, however a remembered filter reads', async () => {
  window.localStorage.setItem('plannotator-inbox-pr-risk-filter', 'high');
  spy('pullRisk', async () => ({ ...JUDGED, rules: '', judgments: {} }));
  await mount(page());
  expect(document.querySelector('[data-pulls-risk-chip]')).not.toBeNull();
  expect(document.querySelector('[data-pulls-risk-filter]')!.getAttribute('data-pulls-risk-filter')).toBe('all');
  expect(shownRows()).toContain(key(1));
});

test.skipIf(!hasDom)('marks: a stack takes its highest open layer, never a merged one', async () => {
  spy('pullRisk', async () => JUDGED);
  await mount(page());
  expect(markOf(1)).toBe('low');
  expect(markOf(2)).toBe('high');
  expect(markOf(3)).toBe('medium');
  expect(markOf(6)).toBe('high');
  expect(markOf(8)).toBe('low');
});

test.skipIf(!hasDom)('High keeps the high rows, also from the folded group, and counts what has no judgment', async () => {
  window.localStorage.setItem('plannotator-inbox-pr-risk-filter', 'high');
  const judgments = { ...JUDGED.judgments };
  delete judgments[key(3)];
  spy('pullRisk', async () => ({ ...JUDGED, judgments }));
  await mount(page());
  expect(shownRows().sort()).toEqual([key(2), key(4), key(6)].sort());
  expect(document.querySelector('[data-pulls-risk-not-judged]')?.textContent).toBe('1 pull request not ranked yet.');
});

test.skipIf(!hasDom)('a stack with a layer not ranked: Low is not something it can say, High hides it and counts it, high still shows', async () => {
  // #5 and #6 are one stack. #5 low with #6 not ranked: maybe past the size the Inbox reads, so never.
  const low = { ...JUDGED.judgments };
  delete low[key(6)];
  spy('pullRisk', async () => ({ ...JUDGED, judgments: low }));
  await mount(page());
  expect(markOf(6)).toBeNull();
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';

  window.localStorage.setItem('plannotator-inbox-pr-risk-filter', 'high');
  await mount(page());
  expect(shownRows()).not.toContain(key(6));
  expect(document.querySelector('[data-pulls-risk-not-judged]')?.getAttribute('data-pulls-risk-not-judged')).toBe('1');
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';

  // The other way round: #6 high and #5 not ranked is on screen, so nothing is hidden to count.
  const high = { ...JUDGED.judgments };
  delete high[key(5)];
  spy('pullRisk', async () => ({ ...JUDGED, judgments: high }));
  await mount(page());
  expect(shownRows()).toContain(key(6));
  expect(document.querySelector('[data-pulls-risk-not-judged]')).toBeNull();
});

test.skipIf(!hasDom)('Medium and up puts high first within a group; All keeps the list as it came', async () => {
  window.localStorage.setItem('plannotator-inbox-pr-risk-filter', 'medium');
  spy('pullRisk', async () => JUDGED);
  await mount(page());
  const onYou = [...document.querySelectorAll('[data-pulls-group="on_you"] [data-pulls-row]')].map((r) => r.getAttribute('data-pulls-row'));
  expect(onYou.indexOf(key(2))).toBeLessThan(onYou.indexOf(key(3)));
  expect(onYou.indexOf(key(6))).toBeLessThan(onYou.indexOf(key(3)));
  expect(shownRows()).not.toContain(key(1));
});

test.skipIf(!hasDom)("nothing passes: says so, instead of saying there are no pull requests", async () => {
  window.localStorage.setItem('plannotator-inbox-pr-risk-filter', 'high');
  spy('pullRisk', async () => ({ ...JUDGED, judgments: { [key(1)]: { level: 'low', why: 'Docs.' } } }));
  await mount(page());
  expect(shownRows()).toEqual([]);
  expect(document.querySelector('[data-pulls-empty]')?.getAttribute('data-pulls-empty')).toBe('risk');
  expect(Number(document.querySelector('[data-pulls-risk-not-judged]')?.getAttribute('data-pulls-risk-not-judged'))).toBeGreaterThan(0);
});

test.skipIf(!hasDom)('the filter never closes the stack open beside the list, and the page says the sentence', async () => {
  window.localStorage.setItem('plannotator-inbox-pr-risk-filter', 'high');
  spy('pullRisk', async () => JUDGED);
  await mount(page(key(1)));
  expect(shownRows()).not.toContain(key(1));
  expect(document.querySelector(`[data-pulls-stack="${key(1)}"]`)).not.toBeNull();
  expect(document.querySelector('[data-pulls-risk-line]')?.textContent).toContain('Docs only.');
});

test.skipIf(!hasDom)('a tap on a mark, on a touch screen, shows the sentence instead of opening the row; a click elsewhere still opens it', async () => {
  const realMatch = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: /hover:\s*none/.test(query), media: query, addEventListener() {}, removeEventListener() {} })) as never;
  restores.push(() => {
    window.matchMedia = realMatch;
  });
  spy('pullRisk', async () => JUDGED);
  const opened: string[] = [];
  await mount(page(null, opened));
  const mark = document.querySelector<HTMLElement>(`[data-pulls-row="${key(2)}"] [data-pull-risk]`)!;
  await act(async () => mark.click());
  await settle();
  expect(opened).toEqual([]);
  await act(async () => document.querySelector<HTMLElement>(`[data-pulls-row="${key(2)}"]`)!.click());
  expect(opened).toEqual([key(2)]);
});

test.skipIf(!hasDom)('a save that fails keeps the words and says why; a switch of agent takes that agent\'s own cheap model', async () => {
  const twoAgents = { ...JUDGED, agents: [{ id: 'pi-sdk', label: 'Pi' }, { id: 'codex-sdk', label: 'Codex' }] };
  spy('pullRiskModels', async (provider) =>
    provider === 'pi-sdk'
      ? { models: [{ id: 'a/sonnet', label: 'Sonnet' }, { id: 'a/opus', label: 'Opus' }], default_model: 'a/sonnet' }
      : { models: [{ id: 'gpt-terra', label: 'Terra' }, { id: 'gpt-sol', label: 'Sol' }], default_model: 'gpt-terra' },
  );
  const saves: unknown[] = [];
  spy('savePullRisk', async (input) => {
    saves.push(input);
    throw new Error('config.json could not be saved.');
  });
  let closed = 0;
  await mount(<RiskRulesDialog answer={twoAgents} onSaved={() => {}} onClose={() => closed++} />);
  const select = document.querySelector<HTMLSelectElement>('[data-pull-risk-agent]')!;
  await act(async () => {
    select.value = 'codex-sdk';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  expect(document.querySelector<HTMLSelectElement>('[data-pull-risk-model]')!.value).toBe('gpt-terra');
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
  expect(saves).toEqual([{ rules: 'Anything in billing.', provider: 'codex-sdk', model: 'gpt-terra' }]);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not be saved');
  expect(document.querySelector<HTMLTextAreaElement>('[data-pull-risk-rules-text]')!.value).toBe('Anything in billing.');
  expect(closed).toBe(0);
});

test.skipIf(!hasDom)('Save waits for a new agent\'s cheap model, so a save during the read can\'t leave it on the person\'s default; a saved model needs no wait', async () => {
  let arrive = (_: { models: { id: string; label: string }[]; default_model: string | null }) => {};
  spy('pullRiskModels', () => new Promise((resolve) => (arrive = resolve)));
  await mount(<RiskRulesDialog answer={{ ...JUDGED, provider: null, model: null, agents: [{ id: 'pi-sdk', label: 'Pi' }] }} onSaved={() => {}} onClose={() => {}} />);
  const save = () => document.querySelector<HTMLButtonElement>('[data-pull-risk-save]')!;
  expect(save().disabled).toBe(true);
  await act(async () => arrive({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: 'a/sonnet' }));
  await settle();
  expect(save().disabled).toBe(false);
  expect(document.querySelector<HTMLSelectElement>('[data-pull-risk-model]')!.value).toBe('a/sonnet');
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';

  await mount(<RiskRulesDialog answer={JUDGED} onSaved={() => {}} onClose={() => {}} />);
  expect(save().disabled).toBe(false);
});

test.skipIf(!hasDom)('no agent installed: one line, and the rules can still be saved', async () => {
  const saves: unknown[] = [];
  spy('savePullRisk', async (input) => {
    saves.push(input);
    return { ...JUDGED, agents: [], provider: null, model: null };
  });
  const models = spy('pullRiskModels', async () => ({ models: [], default_model: null }));
  let done = 0;
  await mount(<RiskRulesDialog answer={{ ...JUDGED, rules: '', provider: null, model: null, agents: [] }} onSaved={() => done++} onClose={() => {}} />);
  expect(document.querySelector('[data-pull-risk-no-agent]')).not.toBeNull();
  expect(document.querySelector('[data-pull-risk-agent]')).toBeNull();
  expect(models).not.toHaveBeenCalled();
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
  expect(saves).toEqual([{ rules: '', provider: null, model: null }]);
  expect(done).toBe(1);
});
