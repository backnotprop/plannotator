/**
 * Remote launch in compose (approval "remote-launch", the picker's A): New Claude Code session on another linked
 * machine. The folder menu groups the projects by machine (none of it without a linked machine), To names the machine
 * ("in infra · Mac mini"), and Send goes through the forward to that machine (`/api/inbox/m/<id>/messages`), never to
 * this one. An asleep machine: Send reads "Start when Mac mini is back", a line says the message waits, and a held
 * answer closes compose with a toast whose Cancel takes it back (`/outbox/<key>/cancel`). A machine where Claude Code
 * can't start shows one line in its words, not projects that would fail.
 *
 * The failures this catches: a remote project's Send started on this computer (or nowhere), a grouped menu drawn for a
 * person with no linked machine, a held launch said as an error with no way to take it back.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import { INBOX_SCRATCH_PICK } from '@plannotator/core/inbox-scratch';
import type { MachineView } from './api';
import type { ComposeHeld, ComposeSent } from './compose/ComposeDialog';
import type { InboxToastModel } from './components/Toast';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const { heldLaunchToast } = (hasDom ? await import('./compose/heldLaunch') : {}) as typeof import('./compose/heldLaunch');
const { InboxToast } = (hasDom ? await import('./components/Toast') : {}) as typeof import('./components/Toast');
const { setSelfMachine, resetMachineRoutes } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');
const { resetMachineLaunchesForTests } = (hasDom ? await import('./compose/useMachineLaunches') : {}) as typeof import('./compose/useMachineLaunches');

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MINI = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const AGENT = 'claude-code';

const view = (id: string, name: string, over: Partial<MachineView> = {}): MachineView =>
  ({ id, name, self: false, state: 'online', since: '2026-11-06T22:42:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true, ...over }) as MachineView;
const SELF_VIEW = view(SELF, 'MacBook', { self: true, launch: null });

const HERE: InboxComposeLaunch = {
  agents: [{ agent: AGENT, name: 'Claude Code' }],
  projects: [
    { id: 'prj_web', name: 'web-app', root: '/Users/me/code/web-app', exists: true },
    { id: 'prj_bill_a', name: 'billing-svc', root: '/Users/me/code/billing-svc', exists: true },
  ],
  scratch: { root: '/Users/me/scratch' },
};
const MINI_BLOCK: InboxComposeLaunch = {
  agents: [{ agent: AGENT, name: 'Claude Code' }],
  projects: [
    { id: 'prj_infra', name: 'infra', root: '/Users/mini/code/infra', exists: true },
    { id: 'prj_bill_m', name: 'billing-svc', root: '/Users/mini/code/billing-svc', exists: true },
  ],
  scratch: { root: '/Users/mini/scratch' },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
let machines: MachineView[] = [SELF_VIEW];
/** Mac mini's sessions read: its launch block, absent while launch is off there (as a real Inbox answers). */
let miniBlock: InboxComposeLaunch | undefined = MINI_BLOCK;
let sendAnswer: () => Response = () => Response.json({ thread_id: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FT1', launch: { id: 'lch_1', state: 'starting' } });
let sent: ComposeSent[] = [];
let held: ComposeHeld[] = [];

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  resetMachineLaunchesForTests();
  setSelfMachine(SELF);
  requests = [];
  sent = [];
  held = [];
  machines = [SELF_VIEW];
  miniBlock = MINI_BLOCK;
  sendAnswer = () => Response.json({ thread_id: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FT1', launch: { id: 'lch_1', state: 'starting' } });
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (method === 'POST') {
      if (path === `/api/inbox/m/${MINI}/messages` || path === '/api/inbox/messages') return sendAnswer();
      if (path.startsWith('/api/inbox/outbox/')) return Response.json({ entry: { key: 'k1', state: 'cancelled' } });
      return Response.json({});
    }
    if (path.startsWith('/api/inbox/machines')) return Response.json({ self: SELF, machines });
    if (path.startsWith(`/api/inbox/m/${MINI}/sessions`)) return Response.json({ serverSession: 't', home: '/Users/mini', projects: [], launch: miniBlock });
    if (path.startsWith('/api/inbox/sessions')) return Response.json({ serverSession: 's', home: '/Users/me', projects: [], launch: HERE });
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
});

const inDialog = (selector: string) => document.querySelector('dialog[data-compose]')?.querySelector<HTMLElement>(selector) ?? null;
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(`dialog[data-compose] ${selector}`)];

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function open(launched?: Map<string, { at: string; project: string }>) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={{}}
        phone={false}
        current={null}
        lastSent={null}
        home="/Users/me"
        launched={launched}
        onSent={(s) => sent.push(s)}
        onHeld={(h) => held.push(h)}
        onSaved={() => {}}
        onDeleted={() => {}}
        onClose={() => {}}
      />,
    );
  });
  await until(() => inDialog('[data-compose-to]:not([data-loading])') !== null, 'To');
}

/** "Claude Code New session", then the folder menu open. */
async function startAndOpenMenu() {
  act(() => inDialog('button[data-compose-to]')!.click());
  await until(() => inDialog(`[data-compose-start="${AGENT}"]`) !== null, 'the start row');
  act(() => inDialog(`[data-compose-start="${AGENT}"]`)!.click());
  await until(() => inDialog('[data-compose-folder]') !== null, 'the folder button');
  act(() => inDialog('[data-compose-folder]')!.click());
  await until(() => inDialog('[data-compose-folder-option]') !== null, 'the menu');
}

function write(words: string) {
  const text = inDialog('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const machinesRead = () => requests.some((r) => r.path === `/api/inbox/m/${MINI}/sessions`);

test.skipIf(!hasDom)('no linked machine: the folder menu is one list with no caption, and Send starts the agent here', async () => {
  await open();
  await startAndOpenMenu();
  expect(inDialog('[data-compose-folders]')!.hasAttribute('data-grouped')).toBe(false);
  expect(all('[data-compose-folder-group]')).toHaveLength(0);
  expect(all('[data-compose-folder-option]').map((r) => r.getAttribute('data-compose-folder-option'))).toEqual(['prj_web', 'prj_bill_a', INBOX_SCRATCH_PICK]);
  act(() => inDialog('[data-compose-folder-option="prj_bill_a"]')!.click());
  expect(inDialog('[data-compose-machine]')).toBeNull();
  write('Fix the retries.');
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => sent.length === 1, 'the send');
  expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/api/inbox/messages']);
  expect(machinesRead()).toBe(false);
});

test.skipIf(!hasDom)('two machines: one group each, the one used last on top, a project on both under each; Send goes to that machine', async () => {
  machines = [SELF_VIEW, view(MINI, 'Mac mini')];
  await open(new Map([[MINI, { at: '2026-11-06T11:00:00.000Z', project: 'prj_bill_m' }]]));
  await until(machinesRead, "Mac mini's sessions read");
  await startAndOpenMenu();
  await until(() => all('[data-compose-folder-group]').length === 2, 'two groups');
  expect(all('[data-compose-folder-group]').map((g) => g.textContent)).toEqual(['Mac mini', 'MacBook · this computer']);
  // Mac mini's last project leads its group, with its quiet mark; billing-svc is under both machines.
  const rows = all('[data-compose-folder-option]').map((r) => `${r.getAttribute('data-compose-folder-machine') ?? 'here'}:${r.getAttribute('data-compose-folder-option')}`);
  expect(rows.slice(0, 2)).toEqual([`${MINI}:prj_bill_m`, `${MINI}:prj_infra`]);
  expect(all('[data-compose-folder-option]')[0]!.textContent).toContain('you started it here last');
  expect(all('[data-compose-folder-option]').filter((r) => r.textContent?.startsWith('billing-svc'))).toHaveLength(2);
  // The filter works across groups.
  const find = inDialog('[data-compose-folders] input') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(find, 'infra');
    find.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(all('[data-compose-folder-option]').map((r) => r.getAttribute('data-compose-folder-option'))).toEqual(['prj_infra']);
  act(() => inDialog('[data-compose-folder-option="prj_infra"]')!.click());
  // To names the machine: "in infra · Mac mini".
  expect(inDialog('[data-compose-folder] bdi')!.textContent).toBe('infra');
  expect(inDialog(`[data-compose-folder] [data-compose-machine="${MINI}"]`)!.textContent).toBe('· Mac mini');
  expect(inDialog('[data-compose-folder]')!.getAttribute('aria-label')).toContain('on Mac mini');
  write('Rotate the staging password.');
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => sent.length === 1, 'the send');
  const posts = requests.filter((r) => r.method === 'POST');
  expect(posts.map((r) => r.path)).toEqual([`/api/inbox/m/${MINI}/messages`]);
  expect(posts[0]!.body!.to).toEqual({ launch: { agent: AGENT, project_id: 'prj_infra' } });
  expect(sent[0]).toMatchObject({ launched: true, machine: MINI });
});

test.skipIf(!hasDom)('↓ and Enter walk every row of every group, into the next machine', async () => {
  machines = [SELF_VIEW, view(MINI, 'Mac mini')];
  await open();
  await until(machinesRead, "Mac mini's sessions read");
  await startAndOpenMenu();
  await until(() => all('[data-compose-folder-group]').length === 2, 'two groups');
  const menu = inDialog('[data-compose-folders] input')!;
  // This computer first (no launch yet): web-app (picked), billing-svc, scratch, "Another folder on MacBook…", then Mac mini's infra.
  for (let i = 0; i < 4; i++) act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder')).toBe('prj_infra');
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder-machine')).toBe(MINI);
});

test.skipIf(!hasDom)("asleep: Send says it starts when that machine is back, a line says the message waits, and a held answer hands over its key", async () => {
  machines = [SELF_VIEW, view(MINI, 'Mac mini')];
  await open();
  await until(machinesRead, "Mac mini's sessions read");
  // Mac mini goes to sleep: its last read still lists its projects.
  machines = [SELF_VIEW, view(MINI, 'Mac mini', { state: 'offline' })];
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 30));
  });
  await startAndOpenMenu();
  await until(() => all('[data-compose-folder-group]').some((g) => g.textContent === 'Mac mini · asleep'), 'the asleep caption');
  act(() => inDialog(`[data-compose-folder-option="prj_infra"]`)!.click());
  expect(inDialog('[data-compose-send]')!.textContent).toContain('Start when Mac mini is back');
  expect(inDialog('[data-compose-note="asleep"]')!.textContent).toContain("Mac mini is asleep (since");
  expect(inDialog('[data-compose-note="asleep"]')!.textContent).toContain("Your message waits here, and Claude Code starts on Mac mini when it's back. You can cancel it until then.");
  sendAnswer = () => new Response(JSON.stringify({ outbox: { key: 'k1', machine: MINI, route: 'messages', state: 'queued', queued_at: '2026-11-06T23:00:00.000Z', settled_at: null, status: null, answer: null }, machine: view(MINI, 'Mac mini', { state: 'offline' }) }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  write('Rotate the staging password.');
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => held.length === 1, 'the held answer');
  expect(held[0]).toMatchObject({ key: 'k1', queued: true, machineName: 'Mac mini', asleep: true, agentName: 'Claude Code', words: { body: 'Rotate the staging password.' } });
  expect(sent).toEqual([]);
  // Compose is still there (this test's onHeld leaves it open), and it shows no error: held is not a failure.
  expect(document.querySelector('dialog[data-compose]')).not.toBeNull();
  expect(inDialog('[data-compose-send]')).not.toBeNull();
  expect(inDialog('.ib-cp-error')).toBeNull();
});

test.skipIf(!hasDom)("the held toast: it starts on that machine when it's back, and Cancel takes it back and puts its words in Drafts", async () => {
  const shown: Omit<InboxToastModel, 'id'>[] = [];
  let dismissed = 0;
  let kept = 0;
  const words = { body: 'Rotate the staging password.', thread_name: 'Rotate staging' };
  const { toast } = heldLaunchToast({ key: 'k1', queued: true, machineName: 'Mac mini', asleep: true, agentName: 'Claude Code', draftId: null, words }, (t) => shown.push(t), () => (dismissed += 1), () => (kept += 1));
  expect(toast.lead).toBe("Claude Code starts on Mac mini when it's back");
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxToast toast={{ ...toast, id: 1 }} />);
  });
  await act(async () => host!.querySelector<HTMLElement>('[data-toast-action]')!.click());
  await until(() => shown.length === 1, 'the cancelled toast');
  expect(dismissed).toBe(1);
  const posts = requests.filter((r) => r.method === 'POST');
  expect(posts[0]!.path).toBe('/api/inbox/outbox/k1/cancel');
  // The words are not lost: the draft it was sent from is gone here, so a new one holds them.
  expect(posts[1]!.path).toMatch(/^\/api\/inbox\/drafts\/drf_/);
  expect(posts[1]!.body).toMatchObject({ ...words, to: null, project: null, files: [], base: null });
  expect(posts).toHaveLength(2);
  expect(kept).toBe(1);
  expect(shown[0]!.lead).toBe('Cancelled. Nothing was sent; your words are in Drafts.');
  // Already on its way: no Cancel to offer.
  expect(heldLaunchToast({ key: 'k2', queued: false, machineName: 'Mac mini', asleep: false, agentName: 'Claude Code', draftId: null, words }, () => {}, () => {}).toast.action).toBeUndefined();
});

test.skipIf(!hasDom)("Claude Code not ready on that machine: its group is one line in that machine's words, with the command to copy", async () => {
  machines = [SELF_VIEW, view(MINI, 'Mac mini')];
  miniBlock = { agents: [], projects: MINI_BLOCK.projects, not_ready: [{ agent: AGENT, name: 'Claude Code', code: 'plugin_off' }] };
  await open();
  await until(machinesRead, "Mac mini's sessions read");
  await startAndOpenMenu();
  await until(() => inDialog(`[data-compose-folder-notice="${MINI}"]`) !== null, 'the notice');
  const notice = inDialog(`[data-compose-folder-notice="${MINI}"]`)!;
  expect(notice.textContent).toContain("Claude Code isn't ready on Mac mini");
  expect(notice.getAttribute('aria-disabled')).toBe('true');
  expect(notice.querySelector('[data-compose-folder-copy]')).not.toBeNull();
  expect(all(`[data-compose-folder-option][data-compose-folder-machine="${MINI}"]`)).toHaveLength(0);
});

test.skipIf(!hasDom)("Claude Code signed out on that machine: what to do there is under the line, its commands as code, and read as the row's description", async () => {
  machines = [SELF_VIEW, view(MINI, 'Mac mini')];
  miniBlock = { agents: [], projects: MINI_BLOCK.projects, not_ready: [{ agent: AGENT, name: 'Claude Code', code: 'signed_out', over_ssh: true }] };
  await open();
  await until(machinesRead, "Mac mini's sessions read");
  await startAndOpenMenu();
  await until(() => inDialog(`[data-compose-folder-notice="${MINI}"]`) !== null, 'the notice');
  const notice = inDialog(`[data-compose-folder-notice="${MINI}"]`)!;
  const fix = notice.querySelector('[data-compose-folder-fix]');
  expect(fix?.textContent).toBe('Plannotator on Mac mini was started over SSH, and macOS keeps the login locked for SSH. In Terminal on Mac mini itself, run plannotator inbox restart, then try again.');
  expect([...fix!.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['plannotator inbox restart']);
  // Named by its line, described by the fix: a screen reader says both, once each.
  expect(document.getElementById(notice.getAttribute('aria-labelledby')!)?.textContent).toBe("Claude Code isn't signed in on Mac mini");
  expect(notice.getAttribute('aria-describedby')).toBe(fix!.id);
  expect(notice.getAttribute('aria-disabled')).toBe('true');
  expect(all(`[data-compose-folder-option][data-compose-folder-machine="${MINI}"]`)).toHaveLength(0);
});

test.skipIf(!hasDom)('launch off on that machine: one line says so, and none of its projects', async () => {
  machines = [SELF_VIEW, view(MINI, 'Mac mini', { launch: false })];
  miniBlock = undefined;
  await open();
  await startAndOpenMenu();
  await until(() => inDialog(`[data-compose-folder-notice="${MINI}"]`) !== null, 'the notice');
  expect(inDialog(`[data-compose-folder-notice="${MINI}"]`)!.textContent).toBe('Starting agents is off on Mac mini');
  expect(all(`[data-compose-folder-option][data-compose-folder-machine="${MINI}"]`)).toHaveLength(0);
});

test.skipIf(!hasDom)("its switch turned on there since the link connected: its sessions read says so, and its projects are offered", async () => {
  // The link's health still says off (read once per connection); Settings → Agents there is live.
  machines = [SELF_VIEW, view(MINI, 'Mac mini', { launch: false })];
  await open();
  await until(machinesRead, "Mac mini's sessions read");
  await startAndOpenMenu();
  await until(() => all(`[data-compose-folder-option][data-compose-folder-machine="${MINI}"]`).length > 0, "Mac mini's projects");
  expect(inDialog(`[data-compose-folder-notice="${MINI}"]`)).toBeNull();
});

test.skipIf(!hasDom)("an agent only Mac mini has, picked under this computer's project: To names it in Mac mini's project, and Send starts it there", async () => {
  miniBlock = { ...MINI_BLOCK, agents: [...MINI_BLOCK.agents, { agent: 'pi', name: 'Pi' }] };
  machines = [SELF_VIEW, view(MINI, 'Mac mini')];
  await open();
  await until(machinesRead, "Mac mini's sessions read");
  act(() => inDialog('button[data-compose-to]')!.click());
  await until(() => inDialog('[data-compose-start="pi"]') !== null, 'the Pi start row');
  act(() => inDialog('[data-compose-start="pi"]')!.click());
  // The caption's project was web-app on MacBook, which has no Pi: To is not left empty.
  await until(() => inDialog('[data-compose-folder]') !== null, 'the project in To');
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder')).toBe('prj_infra');
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder-machine')).toBe(MINI);
  expect(inDialog('[data-compose-to]')!.textContent).toContain('Pi');
  write('Rotate the staging password.');
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => sent.length === 1, 'the send');
  const posts = requests.filter((r) => r.method === 'POST');
  expect(posts.map((r) => r.path)).toEqual([`/api/inbox/m/${MINI}/messages`]);
  expect(posts[0]!.body!.to).toEqual({ launch: { agent: 'pi', project_id: 'prj_infra' } });
});

test.skipIf(!hasDom)('the default start is never an asleep machine\'s project while this computer has one, though the menu still leads with the machine used last', async () => {
  machines = [SELF_VIEW, view(MINI, 'Mac mini')];
  await open(new Map([[MINI, { at: '2026-11-06T11:00:00.000Z', project: 'prj_infra' }]]));
  await until(machinesRead, "Mac mini's sessions read");
  machines = [SELF_VIEW, view(MINI, 'Mac mini', { state: 'offline' })];
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 30));
  });
  await startAndOpenMenu();
  await until(() => all('[data-compose-folder-group]').some((g) => g.textContent === 'Mac mini · asleep'), 'the asleep caption');
  expect(all('[data-compose-folder-group]').map((g) => g.textContent)).toEqual(['Mac mini · asleep', 'MacBook · this computer']);
  expect(inDialog('[data-compose-folder]')!.hasAttribute('data-compose-folder-machine')).toBe(false);
  expect(inDialog('[data-compose-send]')!.textContent).not.toContain('Start when');
});
