/**
 * Settings → Prompts (components/PromptsSettings.tsx; design of record
 * `.product/approved/inbox-prompts-page/`, #2194): the reminder in effect
 * shown in full and marked Default, Edit and Save writing
 * `prompts.inbox.reminder`, Reset to default and Use shared deleting their
 * key (null), an agent's own text, the "Reminder off in Agents" note, the
 * cap (the count from 3,700, Save refused past 4,128), and the twelve
 * read-only prompts folded into one row. Requests go to a recording fetch
 * that answers like the server.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPromptHost, InboxPromptsSettings } from '@plannotator/core/inbox-types';
import { tooltipOf } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { PromptsSection, promptsSummary } = (hasDom ? await import('./components/PromptsSettings') : {}) as typeof import('./components/PromptsSettings');

/** The built-in line as the Inbox serves it (a fixture: the settings page shows whatever it is given). */
const WAKE = 'Plannotator Inbox is on: … Their reply comes back here.';

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

function model(over: Partial<InboxPromptsSettings['reminder']> = {}): InboxPromptsSettings {
  return {
    reminder: {
      shared: null,
      runtimes: { 'claude-code': null, pi: null, opencode: null },
      defaults: { wake: WAKE, no_wake: 'no wake' },
      max: 4128,
      on: { 'claude-code': true, pi: true, opencode: false },
      editable: true,
      ...over,
    },
    others: [
      { key: 'prompts.plan.approved', group: 'plan', group_label: 'Plan', label: 'Approved', default: 'Plan approved.', text: 'Plan approved.', custom: false, runtimes: [], note: 'OpenCode has a shorter default.' },
      { key: 'prompts.review.denied', group: 'review', group_label: 'Code review', label: 'Changes requested', default: 'Verify.', text: 'Check each finding.', custom: true, runtimes: [], note: 'Added after your feedback.' },
    ],
  };
}

/** A fetch that applies `{ prompts: { inbox } }` to the model like the server, and records what was sent. */
function server(start: InboxPromptsSettings) {
  const state = structuredClone(start);
  const sent: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body.prompts);
    const inbox = body.prompts.inbox;
    const clean = (value: string | null) => (value === null || value.trim() === '' ? null : value);
    if ('reminder' in inbox) state.reminder.shared = clean(inbox.reminder);
    for (const [agent, entry] of Object.entries(inbox.runtimes ?? {})) state.reminder.runtimes[agent as InboxPromptHost] = clean((entry as { reminder: string | null }).reminder);
    return new Response(JSON.stringify({ prompts: structuredClone(state) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

function mount(start: InboxPromptsSettings) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  let current = start;
  const render = () =>
    root!.render(
      <PromptsSection
        prompts={current}
        configFile="/Users/ann/.plannotator/config.json"
        home="/Users/ann"
        onPrompts={(next) => {
          current = next;
          render();
        }}
      />,
    );
  act(() => {
    root = createRoot(host!);
    render();
  });
  return host;
}

const q = <T extends Element = HTMLElement>(el: Element, selector: string) => el.querySelector<T & Element>(selector) as T | null;
const type = (box: HTMLTextAreaElement, words: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, words);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = async (button: Element | null) => {
  await act(async () => {
    (button as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

test.skipIf(!hasDom)('by default: the text in effect in full, marked Default; every agent uses it; one note where the reminder is off', () => {
  const el = mount(model());
  expect(q(el, '[data-prompt-slot="shared"] .ib-chip')?.textContent).toBe('Default');
  expect(q(el, '[data-prompt-text="shared"]')?.textContent).toBe(WAKE);
  expect(q(el, '[data-prompt-reset]')).toBeNull();
  expect(q(el, '[data-prompt-show-default]')).toBeNull();
  expect([...el.querySelectorAll('[data-prompt-status]')].map((s) => s.textContent)).toEqual([
    'Uses the shared text',
    'Uses the shared text',
    'Uses the shared text · Reminder off in Agents',
  ]);
  expect(q<HTMLAnchorElement>(el, '[data-prompt-agents-link]')?.getAttribute('href')).toBe('#settings/agents');
  // No native titles: tooltips are components.
  expect(el.querySelectorAll('[title]')).toHaveLength(0);
  expect(promptsSummary(model())).toBe('Default');
});

test.skipIf(!hasDom)('Edit, Save: the shared text becomes Custom; Show default opens the default; Reset to default deletes the key', async () => {
  const sent = server(model());
  const el = mount(model());
  await click(q(el, '[data-prompt-edit="shared"]'));
  const box = q<HTMLTextAreaElement>(el, '[data-prompt-field="shared"]')!;
  expect(box.value).toBe(WAKE);
  expect(document.activeElement).toBe(box);
  // Unchanged: nothing to save.
  expect(q<HTMLButtonElement>(el, '[data-prompt-save="shared"]')!.disabled).toBe(true);
  type(box, 'Send only when no upstream session can decide.');
  await click(q(el, '[data-prompt-save="shared"]'));
  expect(sent).toEqual([{ inbox: { reminder: 'Send only when no upstream session can decide.' } }]);
  expect(q(el, '[data-prompt-field="shared"]')).toBeNull();
  expect(q(el, '[data-prompt-slot="shared"] .ib-chip')?.textContent).toBe('Custom');
  expect(q(el, '[data-prompt-text="shared"]')?.textContent).toBe('Send only when no upstream session can decide.');
  expect(document.activeElement).toBe(q(el, '[data-prompt-edit="shared"]'));

  const disclosure = q<HTMLButtonElement>(el, '[data-prompt-show-default]')!;
  expect(disclosure.getAttribute('aria-expanded')).toBe('false');
  await click(disclosure);
  expect(q(el, '[data-prompt-default]')?.textContent).toBe(WAKE);
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');

  await click(q(el, '[data-prompt-reset]'));
  expect(sent.at(-1)).toEqual({ inbox: { reminder: null } });
  expect(q(el, '[data-prompt-slot="shared"] .ib-chip')?.textContent).toBe('Default');
  expect(q(el, '[data-prompt-default]')).toBeNull();
});

test.skipIf(!hasDom)('Cancel keeps what was saved; saving the default text back deletes the key', async () => {
  const sent = server(model({ shared: 'Mine.' }));
  const el = mount(model({ shared: 'Mine.' }));
  await click(q(el, '[data-prompt-edit="shared"]'));
  type(q<HTMLTextAreaElement>(el, '[data-prompt-field="shared"]')!, 'Something else');
  await click(q(el, '[data-prompt-cancel="shared"]'));
  expect(sent).toEqual([]);
  expect(q(el, '[data-prompt-text="shared"]')?.textContent).toBe('Mine.');
  await click(q(el, '[data-prompt-edit="shared"]'));
  type(q<HTMLTextAreaElement>(el, '[data-prompt-field="shared"]')!, WAKE);
  await click(q(el, '[data-prompt-save="shared"]'));
  expect(sent).toEqual([{ inbox: { reminder: null } }]);
});

test.skipIf(!hasDom)("an agent's own text: Edit starts from the shared text, Save writes the agent's key; Use shared deletes it", async () => {
  const start = model({ shared: 'Shared.' });
  const sent = server(start);
  const el = mount(start);
  const pi = q(el, '[data-agent="pi"]')!;
  await click(q(pi, '[data-prompt-edit="pi"]'));
  const box = q<HTMLTextAreaElement>(el, '[data-prompt-field="pi"]')!;
  expect(box.value).toBe('Shared.');
  expect(box.getAttribute('aria-label')).toBe('Inbox reminder for Pi');
  // The shared text as Pi's own is still a change: Save is offered.
  expect(q<HTMLButtonElement>(el, '[data-prompt-save="pi"]')!.disabled).toBe(false);
  type(box, 'Pi: report upstream first.');
  await click(q(el, '[data-prompt-save="pi"]'));
  expect(sent).toEqual([{ inbox: { runtimes: { pi: { reminder: 'Pi: report upstream first.' } } } }]);
  expect(q(pi, '[data-prompt-status="pi"]')?.textContent).toBe('Own text');
  expect(q(pi, '[data-prompt-text="pi"]')?.textContent).toBe('Pi: report upstream first.');
  expect(promptsSummary(model({ runtimes: { 'claude-code': null, pi: 'x', opencode: null } }))).toBe('Custom');

  await click(q(pi, '[data-prompt-use-shared="pi"]'));
  expect(sent.at(-1)).toEqual({ inbox: { runtimes: { pi: { reminder: null } } } });
  expect(q(pi, '[data-prompt-status="pi"]')?.textContent).toBe('Uses the shared text');
  expect(q(pi, '[data-prompt-text="pi"]')).toBeNull();
});

test.skipIf(!hasDom)('the cap: no count under 3,700; the count from there; past 4,128 Save is refused and the count says so', async () => {
  server(model());
  const el = mount(model());
  await click(q(el, '[data-prompt-edit="shared"]'));
  const box = q<HTMLTextAreaElement>(el, '[data-prompt-field="shared"]')!;
  type(box, 'a'.repeat(3699));
  expect(q(el, '[data-prompt-count]')).toBeNull();
  type(box, 'a'.repeat(3700));
  expect(q(el, '[data-prompt-count]')?.textContent).toBe('3,700 / 4,128');
  expect(box.getAttribute('aria-describedby')).toBe(q(el, '[data-prompt-count]')!.id);
  type(box, 'a'.repeat(4128));
  expect(q<HTMLButtonElement>(el, '[data-prompt-save="shared"]')!.disabled).toBe(false);
  type(box, 'a'.repeat(4129));
  expect(q(el, '[data-prompt-count]')?.hasAttribute('data-over')).toBe(true);
  expect(q<HTMLButtonElement>(el, '[data-prompt-save="shared"]')!.disabled).toBe(true);
  expect(box.getAttribute('aria-invalid')).toBe('true');
  // Blank is not text: nothing to save.
  type(box, '   ');
  expect(q<HTMLButtonElement>(el, '[data-prompt-save="shared"]')!.disabled).toBe(true);
});

test.skipIf(!hasDom)('a refused save keeps the field and says why', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'prompts.inbox.reminder: at most 4,128 characters.', code: 'validation_error' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  const el = mount(model());
  await click(q(el, '[data-prompt-edit="shared"]'));
  type(q<HTMLTextAreaElement>(el, '[data-prompt-field="shared"]')!, 'Mine.');
  await click(q(el, '[data-prompt-save="shared"]'));
  expect(q(el, '[data-prompt-field="shared"]')).not.toBeNull();
  expect(q(el, '[data-prompt-error="shared"]')?.textContent).toContain('at most 4,128 characters');
});

test.skipIf(!hasDom)('the plan, review and annotate prompts: one folded row, opened read-only with key, mark and note', async () => {
  const el = mount(model());
  const fold = q<HTMLButtonElement>(el, '[data-prompts-fold]')!;
  expect(fold.textContent).toBe('2 prompts· 1 custom');
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(q(el, '[data-prompts-list]')).toBeNull();
  await click(fold);
  const approved = q(el, '[data-prompt-key="prompts.plan.approved"]')!;
  expect([approved.querySelector('b')?.textContent, approved.querySelector('.ib-chip')?.textContent, approved.querySelector('code')?.textContent]).toEqual(['Approved', 'Default', 'prompts.plan.approved']);
  expect(approved.querySelector('.pm-onote')?.textContent).toBe('OpenCode has a shorter default.');
  const denied = q(el, '[data-prompt-key="prompts.review.denied"]')!;
  expect([denied.querySelector('.ib-chip')?.textContent, denied.querySelector('pre')?.textContent, denied.querySelector('.pm-onote')]).toEqual(['Custom', 'Check each finding.', null]);
  expect(el.querySelectorAll('[data-prompts-list] textarea, [data-prompts-list] button')).toHaveLength(0);
});

test.skipIf(!hasDom)('text over the limit in config.json: the default stays marked, a calm line says it is ignored, and Reset to default / Use shared delete it', async () => {
  const start = model({
    over: { shared: 4200, runtimes: { 'claude-code': null, pi: 5000, opencode: null } },
  });
  const sent = server(start);
  const el = mount(start);
  expect(q(el, '[data-prompt-slot="shared"] .ib-chip')?.textContent).toBe('Default');
  expect(q(el, '[data-prompt-text="shared"]')?.textContent).toBe(WAKE);
  expect(q(el, '[data-prompt-over="shared"]')?.textContent).toBe('The text in config.json is 4,200 characters, over the 4,128 limit, so it is ignored.');
  expect(q(el, '[data-prompt-over="pi"]')?.textContent).toBe('The text in config.json is 5,000 characters, over the 4,128 limit, so it is ignored.');
  expect(q(el, '[data-prompt-status="pi"]')?.textContent).toBe('Uses the shared text');
  // Calm: not an alert, not the error line.
  expect(el.querySelectorAll('[role="alert"]')).toHaveLength(0);
  await click(q(el, '[data-prompt-reset]'));
  expect(sent.at(-1)).toEqual({ inbox: { reminder: null } });
  await click(q(el, '[data-prompt-use-shared="pi"]'));
  expect(sent.at(-1)).toEqual({ inbox: { runtimes: { pi: { reminder: null } } } });
});

test.skipIf(!hasDom)("OpenCode 1: its row shows the default it really gets (the no-wake line), and Edit starts from it; a shared text replaces it", async () => {
  const NO_WAKE = 'Plannotator Inbox is on: … Call wait_for_reply when you need their answer.';
  const start: InboxPromptsSettings = {
    ...model({ wakes: { 'claude-code': true, pi: true, opencode: false } }),
  };
  start.reminder.defaults.no_wake = NO_WAKE;
  server(start);
  const el = mount(start);
  const opencode = q(el, '[data-agent="opencode"]')!;
  expect(q(opencode, '[data-prompt-status="opencode"]')?.textContent).toBe('Uses the default for OpenCode 1 · Reminder off in Agents');
  expect(q(opencode, '[data-prompt-text="opencode"]')?.textContent).toBe(NO_WAKE);
  expect(q(el, '[data-prompt-text="pi"]')).toBeNull();
  await click(q(opencode, '[data-prompt-edit="opencode"]'));
  expect(q<HTMLTextAreaElement>(el, '[data-prompt-field="opencode"]')!.value).toBe(NO_WAKE);
  await click(q(el, '[data-prompt-cancel="opencode"]'));
  act(() => root!.unmount());
  const shared = model({ shared: 'Shared.', wakes: { 'claude-code': true, pi: true, opencode: false } });
  act(() => {
    root = createRoot(host!);
    root.render(<PromptsSection prompts={shared} />);
  });
  expect(q(host!, '[data-prompt-status="opencode"]')?.textContent).toBe('Uses the shared text · Reminder off in Agents');
  expect(q(host!, '[data-prompt-text="opencode"]')).toBeNull();
});

test.skipIf(!hasDom)('config.json is named with the home folder as ~, the full path in the component tooltip; outside home, in full with none', async () => {
  const el = mount(model());
  const path = q(el, '[data-prompts-config-path]')!;
  expect(path.textContent).toBe('~/.plannotator/config.json');
  expect(path.hasAttribute('title')).toBe(false);
  expect(await tooltipOf(path)).toBe('/Users/ann/.plannotator/config.json');
  act(() => root!.unmount());
  act(() => {
    root = createRoot(host!);
    root.render(<PromptsSection prompts={model()} configFile="/srv/plannotator/config.json" home="/Users/ann" />);
  });
  const outside = q(host!, '[data-prompts-config-path]')!;
  expect(outside.textContent).toBe('/srv/plannotator/config.json');
  expect(await tooltipOf(outside)).toBeNull();
});

test.skipIf(!hasDom)('through the tailnet: read-only, no Edit anywhere', () => {
  const el = mount(model({ editable: false, shared: 'Mine.', runtimes: { 'claude-code': null, pi: 'Pi.', opencode: null } }));
  expect(el.querySelectorAll('[data-prompt-edit], [data-prompt-reset], [data-prompt-use-shared]')).toHaveLength(0);
  expect(el.textContent).toContain('Change it on this computer.');
  expect(q(el, '[data-prompt-text="pi"]')?.textContent).toBe('Pi.');
});
