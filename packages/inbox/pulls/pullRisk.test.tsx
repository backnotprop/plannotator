/**
 * PR risk ranking in the window. What regresses:
 *  - the filter hiding what it should keep (a stack's high layer, a row in the folded group), or hiding a row with a
 *    layer not ranked without a word, or High losing a row it can't place (failed, or not ranked yet) for good;
 *  - a save during the model read leaving the agent on the person's own, possibly expensive, default;
 *  - a merged layer's old judgment deciding a stack;
 *  - the filter closing the stack open beside the list;
 *  - a tap on a mark opening the row instead of showing the sentence;
 *  - a local review (no PR to rank) shown or counted under the filter, or a thread's row not judged by the PRs it owns;
 *  - the dialog losing the person's words when a save fails, or keeping the last agent's model after a switch;
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullRiskAnswer, InboxPullsAnswer, InboxReviewRow, InboxReviewThread } from '@plannotator/core/inbox-types';
import { pullsStateOf } from './reviewsTestState';

const hasDom = typeof document !== 'undefined';
const { inboxApi } = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { InlinePicker } = (hasDom ? await import('@plannotator/ui/components/InlinePicker') : {}) as typeof import('@plannotator/ui/components/InlinePicker');
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
  last_failure: null,
  failed: {},
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

const page = (stackId: string | null = null, opened: string[] = [], state = pullsStateOf(LIST)) => (
  <SidebarProvider>
    <PullsPage
      state={state}
      stackId={stackId}
      project={null}
      projects={[]}
      projectNames={new Map()}
      phone={false}
      onOpenStack={(id) => id && opened.push(id)}
      filter="all" onScope={() => {}}
      onReview={() => {}}
      onOpenThread={() => {}}
      onNew={() => {}}
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
  expect(document.querySelector('[data-pulls-risk-not-ranked-toggle]')?.textContent).toBe('1 not ranked');
});

test.skipIf(!hasDom)('a stack with a layer not ranked: Low is not something it can say, High hides it and counts it, high still shows', async () => {
  // #5 and #6 are one stack. #5 low with #6 not ranked: #6 could be anything.
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
  expect(document.querySelector('[data-pulls-risk-not-ranked]')?.getAttribute('data-pulls-risk-not-ranked')).toBe('1');
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';

  // The other way round: #6 high and #5 not ranked is on screen, so nothing is hidden to count.
  const high = { ...JUDGED.judgments };
  delete high[key(5)];
  spy('pullRisk', async () => ({ ...JUDGED, judgments: high }));
  await mount(page());
  expect(shownRows()).toContain(key(6));
  expect(document.querySelector('[data-pulls-risk-not-ranked]')).toBeNull();
});

test.skipIf(!hasDom)('a PR that failed to rank says so with the reason, never Low; Medium and up keeps it in the list; the review says it too', async () => {
  const reason = 'prompt is too long: 2500000 tokens > 200000 maximum';
  const judgments = { ...JUDGED.judgments };
  delete judgments[key(3)];
  // #5 and #6 are one stack: Low on one layer and a failure on the other is no Low.
  delete judgments[key(6)];
  spy('pullRisk', async () => ({ ...JUDGED, judgments, failed: { [key(3)]: reason, [key(6)]: reason } }));
  await mount(page(key(3)));
  expect(markOf(3)).toBe('failed');
  expect(markOf(6)).toBe('failed');
  const mark = document.querySelector(`[data-pulls-row="${key(3)}"] [data-pull-risk]`)!;
  expect(mark.textContent).toContain('Couldn\u2019t rank');
  expect(mark.textContent).toContain(reason);
  expect(document.querySelector('[data-pulls-risk-line="failed"]')?.textContent).toContain(reason);
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';

  window.localStorage.setItem('plannotator-inbox-pr-risk-filter', 'medium');
  await mount(page());
  const shown = shownRows();
  expect(shown).toContain(key(3));
  expect(shown).toContain(key(6));
  expect(shown).not.toContain(key(1));
  // Ranked first: a failed row can't push a high one down.
  expect(shown.indexOf(key(2))).toBeLessThan(shown.indexOf(key(3)));
  // On screen, so not counted as hidden; and that is High's line only.
  expect(document.querySelectorAll('[data-pulls-risk-not-judged], [data-pulls-risk-not-ranked]').length).toBe(0);
});

test.skipIf(!hasDom)('High hides what failed and what is not ranked yet behind one quiet count, and a click shows them as rows', async () => {
  window.localStorage.setItem('plannotator-inbox-pr-risk-filter', 'high');
  const judgments = { ...JUDGED.judgments };
  delete judgments[key(1)]; // not ranked yet (a run still going counts)
  delete judgments[key(3)]; // failed
  delete judgments[key(6)]; // #5 low, #6 failed: the stack can't be said to be Low
  const reason = 'prompt is too long: 2500000 tokens > 200000 maximum';
  spy('pullRisk', async () => ({ ...JUDGED, judgments, failed: { [key(3)]: reason, [key(6)]: reason }, pending: 1 }));
  await mount(page());
  expect(shownRows().sort()).toEqual([key(2), key(4)].sort());
  const toggle = document.querySelector<HTMLButtonElement>('[data-pulls-risk-not-ranked-toggle]')!;
  expect(toggle.textContent).toBe('3 not ranked');
  // One line, not two.
  expect(document.querySelectorAll('[data-pulls-risk-not-judged]').length).toBe(0);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  // Last in the list, after every group.
  expect(document.querySelector('[data-pulls-risk-not-ranked]')!.nextElementSibling).toBeNull();
  await act(async () => toggle.click());
  expect(shownRows().sort()).toEqual([key(1), key(2), key(3), key(4), key(6)].sort());
  expect(markOf(3)).toBe('failed');
  expect(markOf(6)).toBe('failed');
  expect(markOf(1)).toBeNull();
  const opened = [...document.querySelectorAll('[data-pulls-risk-not-ranked] [data-pulls-row]')].map((r) => r.getAttribute('data-pulls-row'));
  expect(opened.sort()).toEqual([key(1), key(3), key(6)].sort());
  await act(async () => toggle.click());
  expect(shownRows().sort()).toEqual([key(2), key(4)].sort());
});

test.skipIf(!hasDom)('High with nothing high: the empty words, and the count still shows what it could not place', async () => {
  window.localStorage.setItem('plannotator-inbox-pr-risk-filter', 'high');
  spy('pullRisk', async () => ({ ...JUDGED, judgments: { [key(1)]: { level: 'low', why: 'Docs.' } }, failed: { [key(2)]: 'Too big.' } }));
  await mount(page());
  expect(document.querySelector('[data-pulls-empty]')?.getAttribute('data-pulls-empty')).toBe('risk');
  await act(async () => document.querySelector<HTMLButtonElement>('[data-pulls-risk-not-ranked-toggle]')!.click());
  expect(shownRows()).toContain(key(2));
  expect(shownRows()).not.toContain(key(1));
});

test.skipIf(!hasDom)('a failure on a layer of a stack with a higher one found: the stack shows that level', async () => {
  const judgments = { ...JUDGED.judgments };
  delete judgments[key(5)];
  spy('pullRisk', async () => ({ ...JUDGED, judgments, failed: { [key(5)]: 'Too big.' } }));
  await mount(page());
  expect(markOf(6)).toBe('high');
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
  expect(Number(document.querySelector('[data-pulls-risk-not-ranked]')?.getAttribute('data-pulls-risk-not-ranked'))).toBeGreaterThan(0);
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

/** Pick from one of the dialog's two lists, as a person does: the button, then the entry. */
const pick = async (list: 'agent' | 'model', label: string) => {
  const holder = document.querySelector(`[data-pull-risk-${list}]`)!;
  await act(async () => holder.querySelector('button')!.click());
  const entry = [...holder.querySelectorAll('button')].slice(1).find((b) => b.textContent === label)!;
  await act(async () => entry.click());
  await settle();
};
const modelShown = () => document.querySelector('[data-pull-risk-model]')!.getAttribute('data-pull-risk-model');
const modelButton = () => document.querySelector('[data-pull-risk-model] button')!.textContent;

test.skipIf(!hasDom)('a save that fails keeps the words and says why; a switch of agent takes what that agent starts on', async () => {
  const twoAgents = { ...JUDGED, agents: [{ id: 'pi-sdk', label: 'Pi' }, { id: 'codex-sdk', label: 'Codex' }] };
  spy('pullRiskModels', async (provider) =>
    provider === 'pi-sdk'
      ? { models: [{ id: 'a/sonnet', label: 'Sonnet' }, { id: 'a/opus', label: 'Opus' }], default_model: null }
      : { models: [{ id: 'gpt-6-luna', label: 'Luna' }, { id: 'gpt-6-sol', label: 'Sol' }], default_model: 'gpt-6-luna' },
  );
  const saves: unknown[] = [];
  spy('savePullRisk', async (input) => {
    saves.push(input);
    throw new Error('config.json could not be saved.');
  });
  let closed = 0;
  await mount(<RiskRulesDialog answer={twoAgents} onSaved={() => {}} onClose={() => closed++} />);
  await pick('agent', 'Codex');
  expect(modelShown()).toBe('gpt-6-luna');
  expect(modelButton()).toContain('Luna');
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
  expect(saves).toEqual([{ rules: 'Anything in billing.', provider: 'codex-sdk', model: 'gpt-6-luna' }]);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not be saved');
  expect(document.querySelector<HTMLTextAreaElement>('[data-pull-risk-rules-text]')!.value).toBe('Anything in billing.');
  expect(closed).toBe(0);
});

test.skipIf(!hasDom)('Pi starts on Default, as the guided review does, and saves no model; a model picked from the list is saved; Default takes it back', async () => {
  spy('pullRiskModels', async () => ({ models: [{ id: 'a/sonnet', label: 'Sonnet' }, { id: 'a/opus', label: 'Opus' }], default_model: null }));
  const saves: unknown[] = [];
  spy('savePullRisk', async (input) => {
    saves.push(input);
    return JUDGED;
  });
  await mount(<RiskRulesDialog answer={{ ...JUDGED, provider: null, model: null }} onSaved={() => {}} onClose={() => {}} />);
  expect(modelButton()).toContain('Default');
  expect(modelShown()).toBe('');
  await pick('model', 'Opus');
  expect(modelShown()).toBe('a/opus');
  const submit = async () => {
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  await submit();
  await pick('model', 'Default');
  await submit();
  expect(saves).toEqual([
    { rules: 'Anything in billing.', provider: 'pi-sdk', model: 'a/opus' },
    { rules: 'Anything in billing.', provider: 'pi-sdk', model: null },
  ]);
});

test.skipIf(!hasDom)('Escape on an open list closes the list, not the dialog with the words in it', async () => {
  spy('pullRiskModels', async () => ({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: null }));
  let closed = 0;
  await mount(<RiskRulesDialog answer={JUDGED} onSaved={() => {}} onClose={() => closed++} />);
  const holder = document.querySelector('[data-pull-risk-model]')!;
  await act(async () => holder.querySelector('button')!.click());
  expect(holder.querySelectorAll('button').length).toBeGreaterThan(1);
  await act(async () => holder.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(holder.querySelectorAll('button').length).toBe(1);
  expect(closed).toBe(0);
  await act(async () => holder.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(closed).toBe(1);
});

test.skipIf(!hasDom)('outside the Risk dialog the picker keeps its own ways: Escape passes through, and its group headings stay as they are', async () => {
  const options = Array.from({ length: 14 }, (_, i) => ({ value: `anthropic/m${i}`, label: `M${i}` }));
  const reached: string[] = [];
  await mount(
    <div onKeyDown={(event) => reached.push(event.key)}>
      <InlinePicker label="Model" value="" options={options} onChange={() => {}} />
    </div>,
  );
  const button = document.querySelector('button')!;
  await act(async () => button.click());
  const heading = () => [...document.querySelectorAll('div')].find((el) => el.textContent === 'anthropic')!;
  expect(heading().className).toContain('uppercase');
  await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(reached).toEqual(['Escape']);
  // Still open: on the button, Escape has never closed it.
  expect(heading()).toBeDefined();
  // In the filter box Enter is the page's to handle, as it always was.
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => document.querySelector('input')!.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(false);
});

test.skipIf(!hasDom)('in the Risk dialog a long list has its groups in plain case, and Escape in its filter box closes only the list', async () => {
  const models = Array.from({ length: 14 }, (_, i) => ({ id: `anthropic/m${i}`, label: `M${i}` }));
  spy('pullRiskModels', async () => ({ models, default_model: null }));
  let closed = 0;
  await mount(<RiskRulesDialog answer={JUDGED} onSaved={() => {}} onClose={() => closed++} />);
  const holder = document.querySelector('[data-pull-risk-model]')!;
  await act(async () => holder.querySelector('button')!.click());
  const heading = [...holder.querySelectorAll('div')].find((el) => el.textContent === 'anthropic')!;
  expect(heading.className).not.toContain('uppercase');
  expect(heading.className).not.toContain('tracking');
  const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => holder.querySelector('input')!.dispatchEvent(key));
  expect(key.defaultPrevented).toBe(true);
  expect(holder.querySelector('input')).toBeNull();
  expect(closed).toBe(0);
});

test.skipIf(!hasDom)('in the Risk dialog Enter in the filter box never reaches the form, whether it matches or not', async () => {
  const models = Array.from({ length: 14 }, (_, i) => ({ id: `anthropic/m${i}`, label: `M${i}` }));
  spy('pullRiskModels', async () => ({ models, default_model: null }));
  await mount(<RiskRulesDialog answer={JUDGED} onSaved={() => {}} onClose={() => {}} />);
  const holder = document.querySelector('[data-pull-risk-model]')!;
  await act(async () => holder.querySelector('button')!.click());
  const press = async () => {
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => holder.querySelector('input')!.dispatchEvent(key));
    return key.defaultPrevented;
  };
  const input = holder.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'zzzzz');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(await press()).toBe(true);
  expect(holder.querySelector('input')).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'M1');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(await press()).toBe(true);
  expect(holder.querySelector('input')).toBeNull();
});

test.skipIf(!hasDom)('a failed last run says why in the dialog', async () => {
  spy('pullRiskModels', async () => ({ models: [], default_model: null }));
  await mount(<RiskRulesDialog answer={{ ...JUDGED, last_failure: 'Not signed in.' }} onSaved={() => {}} onClose={() => {}} />);
  expect(document.querySelector('[data-pull-risk-failed]')?.textContent).toContain('Not signed in.');
});

test.skipIf(!hasDom)('Save waits for a new agent\'s pick, so a save during the read can\'t leave it on another model; a saved model needs no wait', async () => {
  let arrive = (_: { models: { id: string; label: string }[]; default_model: string | null }) => {};
  spy('pullRiskModels', () => new Promise((resolve) => (arrive = resolve)));
  await mount(<RiskRulesDialog answer={{ ...JUDGED, provider: null, model: null, agents: [{ id: 'pi-sdk', label: 'Pi' }] }} onSaved={() => {}} onClose={() => {}} />);
  const save = () => document.querySelector<HTMLButtonElement>('[data-pull-risk-save]')!;
  expect(save().disabled).toBe(true);
  await act(async () => arrive({ models: [{ id: 'a/sonnet', label: 'Sonnet' }], default_model: 'a/sonnet' }));
  await settle();
  expect(save().disabled).toBe(false);
  expect(modelShown()).toBe('a/sonnet');
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

const review = (thread: string): InboxReviewThread =>
  ({
    thread_id: thread,
    project_id: 'proj_a',
    subject: null,
    first_review_id: `msg_${thread}`,
    latest_review_id: `msg_${thread}`,
    round: 1,
    title: `Review ${thread}`,
    files: 1,
    additions: 1,
    deletions: 1,
    agent: null,
    source: null,
    verdict: null,
    answered: null,
    reviewed_at: '2026-11-03T11:00:00.000Z',
    updated_at: '2026-11-03T11:00:00.000Z',
  }) as InboxReviewThread;

/** The list with #2 owned by a review thread, and a local review that owns no PR. */
function withThreads() {
  const state = pullsStateOf(LIST);
  const rows = state.reviews!.rows;
  const pr2 = rows.find((row) => row.id === key(2))!;
  const owned: InboxReviewRow = { ...pr2, id: 'thr_owns', reviewed: true, thread_id: 'thr_owns', move: 'on_you', reason: 'review_ready', review: review('thr_owns') };
  const local: InboxReviewRow = { id: 'thr_local', reviewed: true, move: 'on_you', reason: 'review_ready', thread_id: 'thr_local', review: review('thr_local'), stacks: [], pull_keys: [], link: null, pull_reason: null, landed: [], updated_at: '2026-11-03T11:00:00.000Z' };
  return { ...state, reviews: { ...state.reviews!, rows: [local, owned, ...rows.filter((row) => row !== pr2)] } };
}
const reviewRows = () => [...document.querySelectorAll('[data-reviews-row]')].map((r) => r.getAttribute('data-reviews-row'));

test.skipIf(!hasDom)("a thread's row is judged by the PR it owns; a local review has no mark, and the filter hides it without counting it", async () => {
  spy('pullRisk', async () => JUDGED);
  await mount(page(null, [], withThreads()));
  expect(document.querySelector('[data-reviews-row="thr_owns"] [data-pull-risk]')?.getAttribute('data-pull-risk')).toBe('high');
  expect(document.querySelector('[data-reviews-row="thr_local"]')).not.toBeNull();
  expect(document.querySelector('[data-reviews-row="thr_local"] [data-pull-risk]')).toBeNull();
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = '';

  for (const filter of ['high', 'medium']) {
    window.localStorage.setItem('plannotator-inbox-pr-risk-filter', filter);
    await mount(page(null, [], withThreads()));
    expect(reviewRows()).toContain('thr_owns');
    expect(reviewRows()).not.toContain('thr_local');
    expect(document.querySelectorAll('[data-pulls-risk-not-judged], [data-pulls-risk-not-ranked]').length).toBe(0);
    if (root) await act(async () => root!.unmount());
    document.body.innerHTML = '';
  }
});
