/**
 * Clone from a git URL in compose's folder menu (approval "launch-create-clone", C1-C17, B5, D4, D7, D9). A URL in
 * the filter turns each machine's group into its clone row, into the folder that machine answers; a pick puts the git
 * mark in To and the clone in the foot, and Send asks that machine to clone (`to.launch.clone`) into that folder.
 *
 * The failures this catches: a clone row asked of (or a Send gone to) the wrong machine, a Send that drops the clone
 * or names another folder, a machine whose git can't read the repo hidden or made unpickable (C11 dims it), a repo
 * already there cloned again (C9), an unknown host offered before it is checked (C7, C8), the URL lost when the chip
 * is reopened (D4, D7), a git URL in the folder field read as a path (B5), and a reopened draft that forgot its clone.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import type { MachineView } from './api';
import type { ComposeSent } from './compose/ComposeDialog';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const { setSelfMachine, resetMachineRoutes } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');
const { resetMachineLaunchesForTests } = (hasDom ? await import('./compose/useMachineLaunches') : {}) as typeof import('./compose/useMachineLaunches');

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MINI = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const AGENT = 'claude-code';
const URL_HTTPS = 'https://github.com/acme/billing-api';

const view = (id: string, name: string, over: Partial<MachineView> = {}): MachineView =>
  ({ id, name, self: false, state: 'online', since: '2026-11-06T22:42:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true, ...over }) as MachineView;
const SELF_VIEW = view(SELF, 'MacBook', { self: true, launch: null });

const HERE: InboxComposeLaunch = {
  agents: [{ agent: AGENT, name: 'Claude Code' }],
  projects: [{ id: 'prj_web', name: 'web-app', root: '/Users/me/code/web-app', exists: true }],
  scratch: { root: '/Users/me/scratch' },
  clone: { into: '/Users/me/code' },
};
const MINI_BLOCK: InboxComposeLaunch = {
  agents: [{ agent: AGENT, name: 'Claude Code' }],
  projects: [{ id: 'prj_infra', name: 'infra', root: '/Users/mini/work/infra', exists: true }],
  scratch: { root: '/Users/mini/scratch' },
  clone: { into: '/Users/mini/work' },
};

/** Each machine's folders under its home, by `~/…` path. */
const TREES: Record<string, Record<string, string[]>> = {
  self: { '~': ['code'], '~/code': ['api-gateway', 'web', 'web-app'], '~/code/web': ['docs', 'src'] },
  [MINI]: { '~': ['work'], '~/work': ['infra'] },
};
/** Where each machine would clone, by `<machine>:<into>`: the repo's name, or what it answers (C9, C10). */
const ALREADY = new Set(['self:~/code:api-gateway']);
/** The quiet check's answer per machine (C11) and for unknown hosts (C7, C8). */
let reach: Record<string, string> = {};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
let machines: MachineView[] = [SELF_VIEW];
let sent: ComposeSent[] = [];

const route = (path: string, what: string) => {
  const m = new RegExp(`^/api/inbox/(?:m/(ibx_[0-9A-Z]{26})/)?launch/${what}\\?(.*)$`).exec(path);
  return m ? { machine: m[1] ?? 'self', query: new URLSearchParams(m[2]) } : null;
};

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  resetMachineLaunchesForTests();
  setSelfMachine(SELF);
  requests = [];
  sent = [];
  reach = {};
  machines = [SELF_VIEW];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (method === 'POST') {
      if (path === `/api/inbox/m/${MINI}/messages` || path === '/api/inbox/messages') return Response.json({ thread_id: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FT1', launch: { id: 'lch_1', state: 'starting' } });
      return Response.json({});
    }
    const check = route(path, 'clone-check');
    if (check) return Response.json({ reach: reach[check.machine] ?? 'ok' });
    const target = route(path, 'clone');
    if (target) {
      const repo = (target.query.get('url') ?? '').replace(/\.git$/, '').split(/[/:]/).pop()!;
      const into = target.query.get('into') ?? (target.machine === 'self' ? '~/code' : '~/work');
      const already = ALREADY.has(`${target.machine}:${into}:${repo}`);
      const taken = (TREES[target.machine]?.[into] ?? []).includes(repo) && !already;
      const name = taken ? `${repo}-2` : repo;
      return Response.json({ into, path: `${into}/${name}`, name, state: already ? 'already' : 'clone', taken: taken ? `${into}/${repo}` : null, writable: true });
    }
    const folders = route(path, 'folders');
    if (folders) {
      const at = folders.query.get('path') ?? '';
      const list = TREES[folders.machine]?.[at];
      return Response.json(list ? { path: at, exists: true, state: 'folder', folders: list, writable: true } : { path: at, exists: false, state: 'missing', folders: [] });
    }
    if (path.startsWith('/api/inbox/machines')) return Response.json({ self: SELF, machines });
    if (path.startsWith(`/api/inbox/m/${MINI}/sessions`)) return Response.json({ serverSession: 't', home: '/Users/mini', projects: [], launch: MINI_BLOCK });
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

async function open(request: Record<string, unknown> = {}) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog request={request} phone={false} current={null} lastSent={null} home="/Users/me" onSent={(s) => sent.push(s)} onHeld={() => {}} onSaved={() => {}} onDeleted={() => {}} onClose={() => {}} />,
    );
  });
  await until(() => inDialog('[data-compose-to]:not([data-loading])') !== null, 'To');
}

async function startAndOpenMenu() {
  act(() => inDialog('button[data-compose-to]')!.click());
  await until(() => inDialog(`[data-compose-start="${AGENT}"]`) !== null, 'the start row');
  act(() => inDialog(`[data-compose-start="${AGENT}"]`)!.click());
  await until(() => inDialog('[data-compose-folder]') !== null, 'the folder button');
  act(() => inDialog('[data-compose-folder]')!.click());
  await until(() => inDialog('[data-compose-folder-option]') !== null, 'the menu');
}

function type(input: HTMLInputElement | HTMLTextAreaElement, words: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, words);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const filter = () => inDialog('[data-compose-folders] .ib-cp-filter input') as HTMLInputElement;
const pathField = () => inDialog('[data-home-folders-path]') as HTMLInputElement;
const cloneRow = (machine: string) => inDialog(`[data-compose-folder-clone="${machine}"]`);
const key = (target: Element, name: string) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
const machinesRead = () => requests.some((r) => r.path === `/api/inbox/m/${MINI}/sessions`);

async function twoMachinesMenu() {
  machines = [SELF_VIEW, view(MINI, 'Mac mini')];
  await open();
  await until(machinesRead, "Mac mini's sessions read");
  await startAndOpenMenu();
  await until(() => all('[data-compose-folder-group]').length === 2, 'two groups');
}

async function sendWith(words: string) {
  type(inDialog('textarea') as HTMLTextAreaElement, words);
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => sent.length === 1, 'the send');
  return requests.filter((r) => r.method === 'POST');
}

test.skipIf(!hasDom)("C1, C11, C13: a URL gives each machine its clone row into the folder it answers; one that can't sign in is dimmed but pickable; Send clones there", async () => {
  reach = { [MINI]: 'auth' };
  await twoMachinesMenu();
  expect(filter().placeholder).toBe('Find a project or paste a git URL');
  type(filter(), URL_HTTPS);
  await until(() => cloneRow('self')?.getAttribute('data-clone-path') === '~/code/billing-api' && cloneRow(MINI)?.hasAttribute('data-clone-cant') === true, 'both clone rows answered');
  // Each machine was asked through its own route; no project rows while a URL is in the filter.
  expect(requests.some((r) => r.path.startsWith(`/api/inbox/m/${MINI}/launch/clone?`))).toBe(true);
  expect(requests.some((r) => r.path.startsWith('/api/inbox/launch/clone?'))).toBe(true);
  expect(all('[data-compose-folder-option]')).toHaveLength(0);
  expect(cloneRow('self')!.textContent).toBe('Clone billing-api and start~/code/billing-api');
  expect(cloneRow('self')!.getAttribute('aria-label')).toBe('Clone acme/billing-api and start, into ~/code/billing-api, on MacBook');
  expect(cloneRow(MINI)!.textContent).toBe("Clone billing-apiMac mini can't sign in to github.com");
  expect(all('[data-compose-folder-clone-other]').map((r) => r.getAttribute('aria-label'))).toEqual(['Clone into another folder on MacBook', 'Clone into another folder on Mac mini']);
  expect(inDialog('[data-compose-clone-explain]')!.textContent).toBe(
    "Cloned with that machine's own git sign-in, into the folder where its other projects live. Claude Code starts when the clone is done.",
  );

  // C11: still pickable. ↓ walks to it (MacBook's clone, its another folder, then Mac mini's), Enter picks it.
  key(filter(), 'ArrowDown');
  key(filter(), 'ArrowDown');
  expect(cloneRow(MINI)!.getAttribute('aria-selected')).toBe('true');
  key(filter(), 'Enter');
  expect(all('[data-compose-folders]')).toHaveLength(0);
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder-clone')).toBe('acme/billing-api');
  expect(inDialog(`[data-compose-folder] [data-compose-machine="${MINI}"]`)!.textContent).toBe('· Mac mini');
  expect(inDialog('[data-compose-folder]')!.getAttribute('aria-label')).toBe('Start in: billing-api, ~/work/billing-api, cloned from github.com/acme/billing-api when you send, on Mac mini. Change');
  expect(inDialog('[data-compose-status]')!.textContent).toBe('Clones acme/billing-api, then starts Claude Code.');

  // D4, D7: reopened, the URL is still in the filter and Mac mini's row has the ✓; ↑ to MacBook, Enter switches.
  act(() => inDialog('[data-compose-folder]')!.click());
  await until(() => cloneRow('self') !== null, 'the clone rows again');
  expect(filter().value).toBe(URL_HTTPS);
  expect(cloneRow(MINI)!.getAttribute('aria-selected')).toBe('true');
  expect(cloneRow(MINI)!.querySelector('.ib-cp-check svg')).not.toBeNull();
  act(() => cloneRow('self')!.click());
  expect(inDialog('[data-compose-folder] [data-compose-machine]')).toBeNull();

  const posts = await sendWith('Find the cent drift.');
  expect(posts.map((r) => r.path)).toEqual(['/api/inbox/messages']);
  expect(posts[0]!.body!.to).toEqual({ launch: { agent: AGENT, folder: '~/code/billing-api', clone: { url: URL_HTTPS } } });
});

test.skipIf(!hasDom)('C9, C10: the same repo there starts in it without a clone; another folder with the name gets -2', async () => {
  await open();
  await startAndOpenMenu();
  type(filter(), 'git@github.com:acme/api-gateway.git');
  await until(() => cloneRow('self')?.hasAttribute('data-clone-already') === true, 'already cloned');
  expect(cloneRow('self')!.textContent).toBe('Start in api-gateway · already cloned~/code/api-gateway');
  // Nothing to clone elsewhere: no "another folder" row for it.
  expect(all('[data-compose-folder-clone-other]')).toHaveLength(0);
  type(filter(), 'https://github.com/other/web');
  await until(() => cloneRow('self')?.getAttribute('data-clone-path') === '~/code/web-2', 'the next free name');
  expect(cloneRow('self')!.getAttribute('aria-label')).toBe('Clone other/web and start, into ~/code/web-2. ~/code/web is another folder');

  type(filter(), 'git@github.com:acme/api-gateway.git');
  await until(() => cloneRow('self')?.hasAttribute('data-clone-already') === true, 'already cloned again');
  act(() => cloneRow('self')!.click());
  expect(inDialog('[data-compose-folder]')!.hasAttribute('data-compose-folder-clone')).toBe(false);
  const posts = await sendWith('Tidy the gateway.');
  expect(posts[0]!.body!.to).toEqual({ launch: { agent: AGENT, folder: '~/code/api-gateway' } });
});

test.skipIf(!hasDom)('C6, C7, C8: an account is said; an unknown host is checked before it is offered, then offered or said not to be a repo', async () => {
  await open();
  await startAndOpenMenu();
  type(filter(), 'https://github.com/acme');
  await until(() => inDialog('[data-compose-clone-note="line"]') !== null, 'the account line');
  expect(inDialog('[data-compose-clone-note="line"]')!.textContent).toBe("github.com/acme is an account, not a repo. Paste the repo's URL.");
  expect(cloneRow('self')).toBeNull();

  reach = { self: 'not_found' };
  type(filter(), 'https://acme.com/pricing/plans');
  expect(inDialog('[data-compose-clone-note="checking"]')!.textContent).toBe('Checking acme.com…');
  expect(cloneRow('self')).toBeNull();
  await until(() => inDialog('[data-compose-clone-note="line"]') !== null, 'the not-a-repo line');
  expect(inDialog('[data-compose-clone-note="line"]')!.textContent).toBe("acme.com/pricing/plans isn't a git repo.");

  reach = { self: 'ok' };
  type(filter(), 'https://git.acme.dev/team/tool');
  await until(() => cloneRow('self') !== null, 'the self-hosted clone row');
  expect(cloneRow('self')!.textContent).toBe('Clone tool and start~/code/tool');
  // A bare owner/repo stays a project search (C3).
  type(filter(), 'acme/billing-api');
  expect(cloneRow('self')).toBeNull();
});

test.skipIf(!hasDom)('C14, C15: Clone into another folder… opens at the clone folder with Clone here leading; a folder there takes the clone; Send clones on that machine', async () => {
  await twoMachinesMenu();
  type(filter(), URL_HTTPS);
  await until(() => inDialog(`[data-compose-folder-clone-other="${MINI}"]`) !== null, "Mac mini's another-folder row");
  act(() => inDialog(`[data-compose-folder-clone-other="${MINI}"]`)!.click());
  expect(inDialog('[data-home-folders] .ib-hfb-head')!.textContent).toBe('Clone billing-api on Mac mini');
  expect(pathField().getAttribute('aria-label')).toBe('Folder to clone billing-api into, on Mac mini');
  expect(pathField().value).toBe('~/work/');
  await until(() => inDialog('[data-home-folder-clone]') !== null, 'Clone here');
  const lead = inDialog('[data-home-folder-clone]')!;
  expect(lead.textContent).toBe('Clone billing-api here~/work/billing-api');
  expect(lead.getAttribute('aria-selected')).toBe('true');
  key(pathField(), 'Enter');
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder-clone')).toBe('acme/billing-api');
  const posts = await sendWith('Find the cent drift.');
  expect(posts.map((r) => r.path)).toEqual([`/api/inbox/m/${MINI}/messages`]);
  expect(posts[0]!.body!.to).toEqual({ launch: { agent: AGENT, folder: '~/work/billing-api', clone: { url: URL_HTTPS } } });
});

test.skipIf(!hasDom)("C15: in this computer's clone browser, a folder that is there is where the clone goes; its folders sit below", async () => {
  await open();
  await startAndOpenMenu();
  type(filter(), URL_HTTPS);
  await until(() => inDialog('[data-compose-folder-clone-other="self"]') !== null, 'the another-folder row');
  act(() => inDialog('[data-compose-folder-clone-other="self"]')!.click());
  expect(inDialog('[data-home-folders] .ib-hfb-head')!.textContent).toBe('Clone billing-api');
  type(pathField(), '~/code/web/');
  await until(() => inDialog('[data-home-folder-clone="~/code/web/billing-api"]') !== null, 'Clone here into web');
  expect(all('[data-home-folder-row]').map((r) => r.getAttribute('data-home-folder-row'))).toEqual(['cloneHere', 'folder', 'folder']);
  // A new name is the clone's own folder.
  type(pathField(), '~/code/invoices');
  await until(() => inDialog('[data-home-folder-row="cloneInto"]') !== null, 'Clone into invoices');
  expect(inDialog('[data-home-folder-row="cloneInto"]')!.textContent).toBe('Clone into invoices and start~/code/invoices');
});

test.skipIf(!hasDom)("B5: a git URL typed in Another folder…'s path field goes back to the list on that machine's clone row", async () => {
  await twoMachinesMenu();
  act(() => inDialog(`[data-compose-folder-other="${MINI}"]`)!.click());
  type(pathField(), URL_HTTPS);
  expect(all('[data-home-folders]')).toHaveLength(0);
  expect(filter().value).toBe(URL_HTTPS);
  await until(() => cloneRow(MINI) !== null, "Mac mini's clone row");
  expect(cloneRow(MINI)!.getAttribute('aria-selected')).toBe('true');
});

test.skipIf(!hasDom)('D9: a reopened draft keeps its clone pick; checked again, a folder that is there by now drops the clone', async () => {
  const draft = (folder: string) => ({
    v: 1,
    id: 'drf_01ARZ3NDEKTSV4RRFFQ69G5FT2',
    created_at: '2026-11-07T10:00:00.000Z',
    updated_at: '2026-11-07T10:00:00.000Z',
    body: 'Find the cent drift.',
    to: null,
    project: null,
    files: [],
    status: 'none',
    start: { agent: AGENT, machine: null, folder, name: folder.split('/').pop(), clone: { url: URL_HTTPS } },
  });
  await open({ draft: draft('~/code/billing-api') });
  await until(() => inDialog('[data-compose-folder-clone]') !== null, 'the clone pick');
  expect(inDialog('[data-compose-status]')!.textContent).toBe('Clones acme/billing-api, then starts Claude Code.');
  act(() => root!.unmount());
  host!.remove();
  // ~/code/web is there now: the pick starts in it, without the git mark.
  await open({ draft: draft('~/code/web') });
  await until(() => requests.some((r) => r.path.includes('launch/folders')), 'the check');
  await until(() => inDialog('[data-compose-folder]') !== null && !inDialog('[data-compose-folder]')!.hasAttribute('data-compose-folder-clone'), 'the mark dropped');
});
