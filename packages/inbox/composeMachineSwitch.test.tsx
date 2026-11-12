/**
 * New message's To as a machine switch (approval "inbox-launcher-machine-switch"), in the real dialog: with one
 * machine no switch; with two, a button per machine ("Atlas 2"), one machine's "Running" and "Start new" at a time;
 * a running agent on another machine picked from it is To as any agent is (with its machine named), and Send goes
 * through that machine; an asleep machine shows a moon, since when, and its agents unpicked; five long names keep this
 * computer and the chosen machine beside "N more"; a phone gets chips.
 *
 * The failures this catches: a switch drawn for a person with one machine, another machine's agents shown under the
 * wrong button, a message to a linked machine's agent sent to this computer, an asleep machine's agent picked as if
 * it were awake, a machine lost when there are more than fit.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxComposeLaunch, InboxComposeProject } from '@plannotator/core/inbox-types';
import type { MachineView } from './api';
import type { ComposeSent } from './compose/ComposeDialog';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const { setSelfMachine, resetMachineRoutes } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');
const { resetMachineLaunchesForTests } = (hasDom ? await import('./compose/useMachineLaunches') : {}) as typeof import('./compose/useMachineLaunches');

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ATLAS = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const ORBIT = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAX';
const QUILL = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAY';
const FERN = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAZ';

const view = (id: string, name: string, over: Partial<MachineView> = {}): MachineView =>
  ({ id, name, self: false, state: 'online', since: '2026-11-12T14:10:00.000Z', reason: null, version: '0.30.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true, ...over }) as MachineView;
const SELF_VIEW = view(SELF, 'Lumen', { self: true, launch: null });

const live = (session: string, host: string, label: string, busy: boolean) => ({ session, host, label, busy, started_at: '2026-11-12T16:00:00.000Z', last_seen_at: '2026-11-12T17:00:00.000Z', idle_since: null, last_thread: null });
const HERE_LAUNCH: InboxComposeLaunch = {
  agents: [{ agent: 'claude-code', name: 'Claude Code' }, { agent: 'codex', name: 'Codex' }],
  projects: [{ id: 'prj_lw', name: 'lantern-web', root: '/Users/me/lantern-web', exists: true }],
};
const HERE_LIVE: InboxComposeProject[] = [{ project: { id: 'prj_lw', name: 'lantern-web', root: '/Users/me/lantern-web' }, sessions: [live('ses_colour', 'claude-code', 'Colour tokens', true)] }];
const ATLAS_LAUNCH: InboxComposeLaunch = {
  agents: [{ agent: 'claude-code', name: 'Claude Code' }],
  projects: [
    { id: 'prj_kr', name: 'kiln-render', root: '/Users/atlas/kiln-render', exists: true },
    { id: 'prj_tp', name: 'tidepool', root: '/Users/atlas/tidepool', exists: true },
  ],
};
const ATLAS_LIVE: InboxComposeProject[] = [
  { project: { id: 'prj_kr', name: 'kiln-render', root: '/Users/atlas/kiln-render' }, sessions: [live('ses_certs', 'claude-code', 'Staging certs', true)] },
  { project: { id: 'prj_tp', name: 'tidepool', root: '/Users/atlas/tidepool' }, sessions: [live('ses_queue', 'claude-code', 'Render queue', false)] },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
let machines: MachineView[] = [SELF_VIEW];
let sent: ComposeSent[] = [];
const restore: (() => void)[] = [];

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  resetMachineLaunchesForTests();
  setSelfMachine(SELF);
  requests = [];
  sent = [];
  machines = [SELF_VIEW];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (method === 'POST') {
      if (path.endsWith('/messages')) return Response.json({ thread_id: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FT1' });
      return Response.json({});
    }
    if (path.startsWith('/api/inbox/machines')) return Response.json({ self: SELF, machines });
    const far = /^\/api\/inbox\/m\/(ibx_\w+)\/sessions/.exec(path);
    if (far) return Response.json({ serverSession: 't', home: '/Users/atlas', projects: far[1] === ATLAS ? ATLAS_LIVE : [], launch: ATLAS_LAUNCH });
    if (path.startsWith('/api/inbox/sessions')) return Response.json({ serverSession: 's', home: '/Users/me', projects: HERE_LIVE, launch: HERE_LAUNCH });
    if (path.startsWith('/api/inbox/skills')) return Response.json({ skills: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  while (restore.length) restore.pop()!();
});

const inDialog = (selector: string) => document.querySelector('dialog[data-compose]')?.querySelector<HTMLElement>(selector) ?? null;
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(`dialog[data-compose] ${selector}`)];
const caps = () => all('[data-compose-cap]').map((c) => c.textContent);
const click = (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to click');
  act(() => el.click());
};

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function open(phone = false) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<ComposeDialog request={{}} phone={phone} current={null} lastSent={null} home="/Users/me" launchTip={null} onSent={(s) => sent.push(s)} onSaved={() => {}} onDeleted={() => {}} onClose={() => {}} />);
  });
  await until(() => inDialog('[data-compose-to]:not([data-loading])') !== null, 'To');
}
const atlasRead = () => requests.some((r) => r.path.startsWith(`/api/inbox/m/${ATLAS}/sessions`));

function write(words: string) {
  const text = inDialog('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)('one machine: no machine buttons; Running, then Start new in the project', async () => {
  await open();
  click(inDialog('button[data-compose-to]'));
  await until(() => inDialog('[data-compose-start]') !== null, 'the start rows');
  expect(inDialog('[data-compose-machines]')).toBeNull();
  expect(caps()).toEqual(['Running', 'Start new']);
  expect(all('[data-compose-start]').map((r) => r.textContent)).toEqual(['Claude Codein lantern-web', 'Codexin lantern-web']);
  expect(inDialog('[data-compose-session="ses_colour"] [data-compose-state]')!.textContent).toBe('Working');
});

test.skipIf(!hasDom)("two machines: a button each with its running agents; Atlas's button shows Atlas's agents and starts only", async () => {
  machines = [SELF_VIEW, view(ATLAS, 'Atlas')];
  await open();
  await until(atlasRead, "Atlas's read");
  click(inDialog('button[data-compose-to]'));
  await until(() => all('[data-compose-switch]').length === 2, 'the switch');
  expect(all('[data-compose-switch]').map((b) => b.textContent)).toEqual(['Lumen1', 'Atlas2']);
  expect(inDialog(`[data-compose-switch="here"]`)!.getAttribute('aria-pressed')).toBe('true');
  expect(all('[data-compose-session]').map((r) => r.getAttribute('data-compose-session'))).toEqual(['ses_colour']);
  click(inDialog(`[data-compose-switch="${ATLAS}"]`));
  expect(inDialog(`[data-compose-switch="${ATLAS}"]`)!.getAttribute('aria-pressed')).toBe('true');
  expect(all('[data-compose-session]').map((r) => r.getAttribute('data-compose-session'))).toEqual(['ses_certs', 'ses_queue']);
  // Codex is this computer's only: "Not on Atlas", not a row that would fail.
  expect(all('[data-compose-start]').map((r) => `${r.getAttribute('data-compose-start')} ${r.getAttribute('data-compose-start-machine')} ${r.getAttribute('data-compose-start-project')}`)).toEqual([`claude-code ${ATLAS} kiln-render`]);
  expect(inDialog('[data-compose-start-missing="codex"]')!.textContent).toContain('Not on Atlas');
  // Typing looks across both machines, the switch aside.
  const filter = inDialog('input[role="combobox"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'claude');
    filter.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(inDialog('[data-compose-machines]')).toBeNull();
  expect(all('[data-compose-session]').map((r) => r.getAttribute('data-compose-session'))).toEqual(['ses_colour', 'ses_certs', 'ses_queue']);
});

test.skipIf(!hasDom)("picking Atlas's running agent: To reads as for any agent, naming Atlas, and Send goes through Atlas", async () => {
  machines = [SELF_VIEW, view(ATLAS, 'Atlas')];
  await open();
  await until(atlasRead, "Atlas's read");
  click(inDialog('button[data-compose-to]'));
  await until(() => inDialog(`[data-compose-switch="${ATLAS}"]`) !== null, 'the switch');
  click(inDialog(`[data-compose-switch="${ATLAS}"]`));
  click(inDialog('[data-compose-session="ses_certs"]'));
  const to = inDialog('button[data-compose-to]')!;
  expect(to.getAttribute('data-compose-to')).toBe('ses_certs');
  expect(to.textContent).toBe('Claude Code· Staging certs · kiln-render · Atlas');
  expect(to.getAttribute('aria-label')).toBe('To: Claude Code, Staging certs, in kiln-render, on Atlas. Change');
  write('Rotate the staging certs.');
  click(inDialog('[data-compose-send]'));
  await until(() => sent.length === 1, 'the send');
  const posts = requests.filter((r) => r.method === 'POST');
  expect(posts.map((r) => r.path)).toEqual([`/api/inbox/m/${ATLAS}/messages`]);
  expect(posts[0]!.body!.to).toEqual({ host: 'claude-code', session: 'ses_certs' });
  expect(sent[0]).toMatchObject({ machine: ATLAS, projectName: 'kiln-render · Atlas' });
});

test.skipIf(!hasDom)("picking Atlas's Start new row: To is a new session in Atlas's project, as the folder menu would make it", async () => {
  machines = [SELF_VIEW, view(ATLAS, 'Atlas')];
  await open();
  await until(atlasRead, "Atlas's read");
  click(inDialog('button[data-compose-to]'));
  await until(() => inDialog(`[data-compose-switch="${ATLAS}"]`) !== null, 'the switch');
  click(inDialog(`[data-compose-switch="${ATLAS}"]`));
  click(inDialog('[data-compose-start="claude-code"]'));
  expect(inDialog('button[data-compose-to]')!.textContent).toBe('New Claude Code session');
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder')).toBe('prj_kr');
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder-machine')).toBe(ATLAS);
  // Open again: on Atlas, its row checked.
  click(inDialog('button[data-compose-to]'));
  expect(inDialog(`[data-compose-switch="${ATLAS}"]`)!.getAttribute('aria-pressed')).toBe('true');
  expect(inDialog('[data-compose-start="claude-code"] .ib-cp-check svg')).not.toBeNull();
});

test.skipIf(!hasDom)('an asleep machine: a moon and no count, since when, its agents shown but not picked, its starts wait for it', async () => {
  machines = [SELF_VIEW, view(ATLAS, 'Atlas')];
  await open();
  await until(atlasRead, "Atlas's read");
  machines = [SELF_VIEW, view(ATLAS, 'Atlas', { state: 'offline' })];
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 30));
  });
  click(inDialog('button[data-compose-to]'));
  await until(() => inDialog(`[data-compose-switch="${ATLAS}"][data-asleep]`) !== null, 'the asleep button');
  expect(inDialog(`[data-compose-switch="${ATLAS}"]`)!.textContent).toBe('Atlas');
  click(inDialog(`[data-compose-switch="${ATLAS}"]`));
  expect(caps()[0]).toMatch(/^Atlas asleep since \d{1,2}:\d{2} [AP]M$/);
  const agent = inDialog('[data-compose-session="ses_certs"]')!;
  expect(agent.getAttribute('aria-disabled')).toBe('true');
  expect(agent.querySelector('[data-compose-state]')!.textContent).toBe('asleep');
  click(agent);
  expect(inDialog('button[data-compose-to]')!.getAttribute('data-compose-to')).toBe('choose');
  expect(inDialog('[data-compose-start="claude-code"]')!.textContent).toContain("starts when it's back");
});

test.skipIf(!hasDom)('more than four running: four, then "N more running", which opens the rest', async () => {
  const many = Array.from({ length: 6 }, (_, i) => live(`ses_m${i}`, 'claude-code', `Task ${i + 1}`, false));
  ATLAS_LIVE.push({ project: { id: 'prj_tp', name: 'tidepool', root: '/Users/atlas/tidepool' }, sessions: many });
  restore.push(() => void ATLAS_LIVE.pop());
  machines = [SELF_VIEW, view(ATLAS, 'Atlas')];
  await open();
  await until(atlasRead, "Atlas's read");
  click(inDialog('button[data-compose-to]'));
  await until(() => inDialog(`[data-compose-switch="${ATLAS}"]`) !== null, 'the switch');
  expect(inDialog(`[data-compose-switch="${ATLAS}"]`)!.textContent).toBe('Atlas8');
  click(inDialog(`[data-compose-switch="${ATLAS}"]`));
  expect(all('[data-compose-session]')).toHaveLength(4);
  expect(inDialog('[data-compose-more-running]')!.textContent).toBe('4 more running');
  expect(caps()).toEqual(['Running', 'Start new']);
  click(inDialog('[data-compose-more-running]'));
  expect(all('[data-compose-session]')).toHaveLength(8);
});

test.skipIf(!hasDom)('five machines with long names: this computer and the chosen one keep buttons, the rest are under "3 more", and one picked there swaps in', async () => {
  machines = [view(SELF, 'MacBook Pro 14 (work)', { self: true, launch: null }), view(ATLAS, 'Studio Mac mini upstairs'), view(ORBIT, 'render-box-basement'), view(QUILL, 'ci-runner-west-2-large'), view(FERN, 'Old ThinkPad in the hall')];
  // The real list is 560 px wide: a button's natural width is its name's, the switch has what is left.
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const room = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return (this.textContent ?? '').length * 8 + 40; } });
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get(this: Element) { return this.classList.contains('ib-cp-msw') ? 540 : 0; } });
  restore.push(() => {
    if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
    else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    if (room) Object.defineProperty(Element.prototype, 'clientWidth', room);
    else delete (Element.prototype as { clientWidth?: number }).clientWidth;
  });
  await open();
  await until(() => requests.some((r) => r.path.startsWith(`/api/inbox/m/${FERN}/sessions`)), "Fern's read");
  click(inDialog('button[data-compose-to]'));
  await until(() => inDialog('[data-compose-machine-more]') !== null, '"N more"');
  expect(all('.ib-cp-mswrow:not(.ib-cp-mswmeasure) [data-compose-switch]').map((b) => b.getAttribute('data-compose-switch'))).toEqual(['here', ATLAS]);
  expect(inDialog('[data-compose-machine-more]')!.textContent).toBe('3 more');
  click(inDialog('[data-compose-machine-more]'));
  expect(all('[data-compose-machine-panel] [data-compose-switch]').map((b) => b.textContent)).toEqual(['render-box-basementNothing running', 'ci-runner-west-2-largeNothing running', 'Old ThinkPad in the hallNothing running']);
  click(inDialog(`[data-compose-machine-panel] [data-compose-switch="${FERN}"]`));
  expect(inDialog('[data-compose-machine-panel]')).toBeNull();
  expect(all('.ib-cp-mswrow:not(.ib-cp-mswmeasure) [data-compose-switch]').map((b) => b.getAttribute('data-compose-switch'))).toEqual(['here', FERN]);
  expect(inDialog(`[data-compose-switch="${FERN}"]`)!.getAttribute('aria-pressed')).toBe('true');
});

test.skipIf(!hasDom)('a phone: the machines are chips over the list, a tap shows that machine; one machine has none', async () => {
  machines = [SELF_VIEW, view(ATLAS, 'Atlas')];
  await open(true);
  await until(atlasRead, "Atlas's read");
  click(inDialog('[data-compose-to]'));
  await until(() => document.querySelector('[data-compose-to-sheet] .ib-cp-mchips') !== null, 'the chips');
  const chips = [...document.querySelectorAll<HTMLElement>('[data-compose-to-sheet] [data-compose-switch]')];
  expect(chips.map((c) => c.textContent)).toEqual(['Lumen1', 'Atlas2']);
  click(chips[1]!);
  expect([...document.querySelectorAll('[data-compose-to-sheet] [data-compose-session]')].map((r) => r.getAttribute('data-compose-session'))).toEqual(['ses_certs', 'ses_queue']);
  act(() => root?.unmount());
  host?.remove();
  machines = [SELF_VIEW];
  resetMachineLaunchesForTests();
  await open(true);
  click(inDialog('[data-compose-to]'));
  await until(() => document.querySelector('[data-compose-to-sheet] [data-compose-start]') !== null, 'the start rows');
  expect(document.querySelector('[data-compose-to-sheet] .ib-cp-mchips')).toBeNull();
});
