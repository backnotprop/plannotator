import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import type { MachineView, ProjectFolder } from './api';
import { lastLaunchAgent, newSessionTip, projectCanStart, projectPlusOn } from './compose/model';

const hasDom = typeof document !== 'undefined';
const { ProjectRow } = (hasDom ? await import('./components/ProjectRow') : {}) as typeof import('./components/ProjectRow');
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const { setSelfMachine, resetMachineRoutes } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');
const { resetMachineLaunchesForTests } = (hasDom ? await import('./compose/useMachineLaunches') : {}) as typeof import('./compose/useMachineLaunches');

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MINI = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const view = (id: string, name: string, over: Partial<MachineView> = {}): MachineView =>
  ({ id, name, self: false, state: 'online', since: '2026-11-06T22:42:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true, ...over }) as MachineView;

const HERE: InboxComposeLaunch = {
  agents: [
    { agent: 'claude-code', name: 'Claude Code' },
    { agent: 'pi', name: 'Pi' },
  ],
  projects: [
    { id: 'prj_web', name: 'web-app', root: '/Users/me/code/web-app', exists: true },
    { id: 'prj_bill', name: 'billing-svc', root: '/Users/me/code/billing-svc', exists: true },
  ],
};
const MINI_BLOCK: InboxComposeLaunch = { agents: [{ agent: 'claude-code', name: 'Claude Code' }], projects: [{ id: 'prj_infra', name: 'infra', root: '/Users/mini/code/infra', exists: true }] };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let machines: MachineView[] = [view(SELF, 'MacBook', { self: true, launch: null })];

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  resetMachineLaunchesForTests();
  setSelfMachine(SELF);
  machines = [view(SELF, 'MacBook', { self: true, launch: null })];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith('/api/inbox/machines')) return Response.json({ self: SELF, machines });
    if (path.startsWith(`/api/inbox/m/${MINI}/sessions`)) return Response.json({ serverSession: 't', home: '/Users/mini', projects: [], launch: MINI_BLOCK });
    if (path.startsWith('/api/inbox/sessions')) return Response.json({ serverSession: 's', home: '/Users/me', projects: [], launch: HERE });
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
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('the tip names the project, its machine when it is another, and that it waits while asleep; the last agent is the newest launched row\'s', () => {
  expect(newSessionTip('billing-svc', null, false)).toBe('New session in billing-svc');
  expect(newSessionTip('infra', 'Mac mini', true)).toBe("New session in infra · Mac mini, starts when it's back");
  const rows = [
    { created_at: '2026-11-07T09:00:00Z', run: null, addressee: { host: 'pi' } },
    { created_at: '2026-11-07T10:00:00Z', run: 'working', addressee: { host: 'claude-code' } },
    { created_at: '2026-11-07T11:00:00Z', addressee: { host: 'codex' } },
  ];
  expect(lastLaunchAgent(rows)).toBe('claude-code');
  expect(lastLaunchAgent([])).toBeNull();
});

test('"+" shows only while launch is on and never on a tailnet guest\'s page; a row shows it only where it can start something', () => {
  expect(projectPlusOn(true, false)).toBe(true);
  expect(projectPlusOn(true, true)).toBe(false);
  expect(projectPlusOn(false, false)).toBe(false);
  expect(projectPlusOn(undefined, false)).toBe(false);
  const bill = { id: 'prj_bill', root: '/Users/me/code/billing-svc' };
  expect(projectCanStart(bill, null)).toBe(true);
  expect(projectCanStart(bill, HERE)).toBe(true);
  expect(projectCanStart(bill, { ...HERE, agents: [] })).toBe(false);
  expect(projectCanStart(bill, null, false)).toBe(false);
  expect(projectCanStart(bill, { ...HERE, projects: [{ id: 'prj_bill', name: 'billing-svc', root: bill.root, exists: false }] })).toBe(false);
});

const SITE = { id: 'prj_bill', name: 'billing-svc', root: '/Users/me/code/billing-svc' } as unknown as ProjectFolder;

test.skipIf(!hasDom)('F1, F2: "+" is its own button beside ⋯, named by its tip, before ⋯ in the Tab order; a press is the new session, not the project', () => {
  const pressed: string[] = [];
  mount(<ProjectRow project={SITE} count={2} on={false} held={false} readable phone={false} onOpen={() => pressed.push('open')} onAction={() => {}} newSession={{ tip: 'New session in billing-svc', onPress: () => pressed.push('new') }} />);
  const plus = document.querySelector<HTMLButtonElement>('[data-pplus="prj_bill"]')!;
  expect(plus.tagName).toBe('BUTTON');
  expect(plus.getAttribute('aria-label')).toBe('New session in billing-svc');
  expect(plus.closest('.ib-proj')).toBeNull();
  const buttons = [...document.querySelectorAll('button')];
  expect(buttons.indexOf(plus)).toBeLessThan(buttons.indexOf(document.querySelector('.ib-pmore')!));
  act(() => plus.click());
  expect(pressed).toEqual(['new']);
  act(() => root!.unmount());
  mount(<ProjectRow project={SITE} count={2} on={false} held={false} readable phone={false} onOpen={() => {}} onAction={() => {}} />);
  expect(document.querySelector('[data-pplus]')).toBeNull();
});

test.skipIf(!hasDom)('a phone: no "+" on a project row, with Launch on; ⋯ stays', () => {
  mount(<ProjectRow project={SITE} count={2} on={false} held={false} readable phone onOpen={() => {}} onAction={() => {}} newSession={{ tip: 'New session in billing-svc', onPress: () => {} }} />);
  expect(document.querySelector('[data-pplus]')).toBeNull();
  expect(document.querySelector('.ib-projrow')!.hasAttribute('data-plus')).toBe(false);
  expect(document.querySelector('.ib-pmore')).not.toBeNull();
});

const open = (start: { projectId: string; machine: string | null; agent: string | null }) =>
  mount(<ComposeDialog request={{ start }} phone={false} current={null} lastSent={null} home="/Users/me" onSent={() => {}} onHeld={() => {}} onSaved={() => {}} onDeleted={() => {}} onClose={() => {}} />);
const inDialog = (selector: string) => document.querySelector('dialog[data-compose]')?.querySelector<HTMLElement>(selector) ?? null;

test.skipIf(!hasDom)('F3: pressed, New message names a new session of the last agent in that project, and the cursor is in the message', async () => {
  open({ projectId: 'prj_bill', machine: null, agent: 'pi' });
  await until(() => inDialog('[data-compose-folder="prj_bill"]') !== null, 'the project in To');
  expect(inDialog('[data-compose-to]')!.textContent).toContain('New Pi session');
  expect(document.activeElement).toBe(inDialog('textarea'));
});

test.skipIf(!hasDom)("F5: a project on an asleep machine opens on that machine, the agent that machine has, and Send waits for it", async () => {
  machines = [view(SELF, 'MacBook', { self: true, launch: null }), view(MINI, 'Mac mini', { state: 'offline' })];
  open({ projectId: 'prj_infra', machine: MINI, agent: 'pi' });
  await until(() => inDialog('[data-compose-folder="prj_infra"]') !== null, "Mac mini's project in To");
  expect(inDialog('[data-compose-to]')!.textContent).toContain('New Claude Code session');
  expect(inDialog(`[data-compose-folder] [data-compose-machine="${MINI}"]`)!.textContent).toBe('· Mac mini');
  expect(inDialog('[data-compose-send]')!.textContent).toContain('Start when Mac mini is back');
});
