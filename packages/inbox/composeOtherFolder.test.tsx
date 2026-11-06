/**
 * "Another folder on <machine>…" in compose's folder menu (remote launch, approval addendum "existing folders"): the
 * quiet last row of each machine's group ("Another folder…" with only this computer) opens a folder browser for that
 * machine. Typing reads the typed path's parent through that machine's own route (this computer's
 * `/api/inbox/launch/folders`, a linked one's `/api/inbox/m/<id>/launch/folders`), picking a folder goes into it,
 * "Start in <name>" puts it in To, and Send names the folder (`to.launch.folder`) on that machine's route.
 *
 * The failures this catches: a folder read or a Send that goes to the wrong machine, a Send that names a project or
 * nothing instead of the folder, an asleep machine read anyway (or offering a folder nobody checked), a missing path
 * left silent, and a stale answer drawn under a newer path.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import { INBOX_SCRATCH_PICK } from '@plannotator/core/inbox-scratch';
import type { MachineView } from './api';
import type { ComposeSent } from './compose/ComposeDialog';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
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
  projects: [{ id: 'prj_web', name: 'web-app', root: '/Users/me/code/web-app', exists: true }],
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

/** Each machine's folders under its home, by `~/…` path. */
const TREES: Record<string, Record<string, string[]>> = {
  self: { '~': ['code', 'notes'], '~/code': ['notes-local', 'web-app'], '~/code/notes-local': [] },
  [MINI]: { '~': ['code'], '~/code': ['billing-api', 'billing-reports', 'billing-svc', 'infra'], '~/code/billing-api': [], '~/code/billing-svc': ['src'] },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
let machines: MachineView[] = [SELF_VIEW];
/** Holds a folder read until released (a slow machine). */
let slow: { path: string; release: Promise<void> } | null = null;
let sent: ComposeSent[] = [];

/** A folder read: the machine (`self` or its id) and the path asked for, or null for any other request. */
function folderRead(path: string): { machine: string; at: string } | null {
  const m = /^\/api\/inbox\/(?:m\/(ibx_[0-9A-Z]{26})\/)?launch\/folders\?(.*)$/.exec(path);
  return m ? { machine: m[1] ?? 'self', at: new URLSearchParams(m[2]).get('path') ?? '' } : null;
}

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  resetMachineLaunchesForTests();
  setSelfMachine(SELF);
  requests = [];
  sent = [];
  slow = null;
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
    const read = folderRead(path);
    if (read) {
      if (slow && slow.path === read.at) await slow.release;
      if (read.at.split('/').some((s) => s.startsWith('.'))) return Response.json({ error: "Hidden folders aren't listed.", code: 'folder_hidden' }, { status: 422 });
      const folders = TREES[read.machine]?.[read.at];
      return Response.json(folders ? { path: read.at, exists: true, folders } : { path: read.at, exists: false, folders: [] });
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

async function open() {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog request={{}} phone={false} current={null} lastSent={null} home="/Users/me" onSent={(s) => sent.push(s)} onHeld={() => {}} onSaved={() => {}} onDeleted={() => {}} onClose={() => {}} />,
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
const pathField = () => inDialog('[data-home-folders-path]') as HTMLInputElement;
const folderReads = () => requests.flatMap((r) => (r.method === 'GET' && folderRead(r.path) ? [folderRead(r.path)!] : []));
const shownFolders = () => all('[data-home-folder-option]').map((r) => r.getAttribute('data-home-folder-option'));
const key = (target: Element, name: string) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
const machinesRead = () => requests.some((r) => r.path === `/api/inbox/m/${MINI}/sessions`);

async function twoMachinesMenu() {
  machines = [SELF_VIEW, view(MINI, 'Mac mini')];
  await open();
  await until(machinesRead, "Mac mini's sessions read");
  await startAndOpenMenu();
  await until(() => all('[data-compose-folder-group]').length === 2, 'two groups');
}

test.skipIf(!hasDom)('only this computer: "Another folder…" ends the list, reads here, says a missing path, and Send names the folder here', async () => {
  await open();
  await startAndOpenMenu();
  // The menu as it was, then the one new row, with no machine words.
  expect(all('[data-compose-folder-option]').map((r) => r.getAttribute('data-compose-folder-option'))).toEqual(['prj_web', INBOX_SCRATCH_PICK]);
  const row = inDialog('[data-compose-folder-other="self"]')!;
  expect(row.textContent).toBe('Another folder…');
  expect(all('[data-compose-folder-group]')).toHaveLength(0);
  act(() => row.click());
  expect(inDialog('[data-home-folders] .ib-hfb-head')!.textContent).toBe('A folder');
  expect(pathField().value).toBe('~/');
  expect(document.activeElement).toBe(pathField());
  await until(() => shownFolders().length === 2, "home's folders");
  expect(shownFolders()).toEqual(['code', 'notes']);

  type(pathField(), '~/code/nope');
  await until(() => inDialog('[data-home-folders-note="missing"]') !== null, 'the missing line');
  expect(inDialog('[data-home-folders-note="missing"]')!.textContent).toBe("There's no folder ~/code/nope. Check the path, or pick a folder below.");
  expect(inDialog('[data-home-folder-start]')).toBeNull();

  type(pathField(), '~/code/NO');
  await until(() => shownFolders().join() === 'notes-local', 'the narrowed folders');
  act(() => inDialog('[data-home-folder-option="notes-local"]')!.click());
  expect(pathField().value).toBe('~/code/notes-local/');
  await until(() => inDialog('[data-home-folder-start]') !== null, 'the Start row');
  expect(inDialog('[data-home-folder-start]')!.getAttribute('data-home-folder-start')).toBe('~/code/notes-local');
  // Every read was this computer's own route.
  expect(folderReads().every((r) => r.machine === 'self')).toBe(true);
  expect(folderReads().map((r) => r.at)).toContain('~/code/notes-local');

  act(() => inDialog('[data-home-folder-start]')!.click());
  expect(inDialog('[data-compose-folders]')).toBeNull();
  expect(inDialog('[data-compose-folder] bdi')!.textContent).toBe('notes-local');
  expect(inDialog('[data-compose-machine]')).toBeNull();
  type(inDialog('textarea') as HTMLTextAreaElement, 'Tidy the notes.');
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => sent.length === 1, 'the send');
  const posts = requests.filter((r) => r.method === 'POST');
  expect(posts.map((r) => r.path)).toEqual(['/api/inbox/messages']);
  expect(posts[0]!.body!.to).toEqual({ launch: { agent: AGENT, folder: '~/code/notes-local' } });
});

test.skipIf(!hasDom)("two machines: each group ends with its own row; Mac mini's folders are read and started through Mac mini's route", async () => {
  await twoMachinesMenu();
  expect(all('[data-compose-folder-other]').map((r) => `${r.getAttribute('data-compose-folder-other')}=${r.textContent}`)).toEqual(['self=Another folder on MacBook…', `${MINI}=Another folder on Mac mini…`]);
  // Each row is its group's last.
  const options = all('[data-compose-folder-option], [data-compose-folder-other]');
  expect(options[options.length - 1]!.getAttribute('data-compose-folder-other')).toBe(MINI);
  expect(options[2]!.getAttribute('data-compose-folder-other')).toBe('self');

  act(() => inDialog(`[data-compose-folder-other="${MINI}"]`)!.click());
  expect(inDialog('[data-home-folders] .ib-hfb-head')!.textContent).toBe('A folder on Mac mini');
  type(pathField(), '~/code/bil');
  await until(() => shownFolders().length === 3, "Mac mini's billing folders");
  expect(shownFolders()).toEqual(['billing-api', 'billing-reports', 'billing-svc']);
  expect(folderReads().filter((r) => r.at === '~/code')).toEqual([{ machine: MINI, at: '~/code' }]);
  expect(folderReads().some((r) => r.machine === 'self')).toBe(false);

  type(pathField(), '~/code/biling-svc');
  await until(() => inDialog('[data-home-folders-note="missing"]') !== null, 'the missing line');
  expect(inDialog('[data-home-folders-note="missing"]')!.textContent).toBe('Mac mini has no folder ~/code/biling-svc. Check the path, or pick a folder below.');

  type(pathField(), '~/code/billing-a');
  await until(() => shownFolders().join() === 'billing-api', 'billing-api');
  key(pathField(), 'Enter');
  expect(pathField().value).toBe('~/code/billing-api/');
  await until(() => inDialog('[data-home-folder-start]') !== null, 'the Start row');
  expect(inDialog('[data-home-folder-start]')!.getAttribute('aria-selected')).toBe('true');
  key(pathField(), 'Enter');
  // To reads like a project's: "in billing-api · Mac mini".
  expect(inDialog('[data-compose-folder] bdi')!.textContent).toBe('billing-api');
  expect(inDialog(`[data-compose-folder] [data-compose-machine="${MINI}"]`)!.textContent).toBe('· Mac mini');
  type(inDialog('textarea') as HTMLTextAreaElement, 'Retry the 409 with the same key.');
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => sent.length === 1, 'the send');
  const posts = requests.filter((r) => r.method === 'POST');
  expect(posts.map((r) => r.path)).toEqual([`/api/inbox/m/${MINI}/messages`]);
  expect(posts[0]!.body!.to).toEqual({ launch: { agent: AGENT, folder: '~/code/billing-api' } });
  expect(sent[0]).toMatchObject({ launched: true, machine: MINI, projectName: 'billing-api · Mac mini' });
});

test.skipIf(!hasDom)("this computer's row in a grouped menu reads this computer's folders, never the linked machine's", async () => {
  await twoMachinesMenu();
  act(() => inDialog('[data-compose-folder-other="self"]')!.click());
  expect(inDialog('[data-home-folders] .ib-hfb-head')!.textContent).toBe('A folder on MacBook');
  type(pathField(), '~/code/');
  await until(() => shownFolders().join() === 'notes-local,web-app', "this computer's folders");
  expect(folderReads().every((r) => r.machine === 'self')).toBe(true);
});

test.skipIf(!hasDom)("a folder that is one of that machine's projects already starts as that project", async () => {
  await twoMachinesMenu();
  act(() => inDialog(`[data-compose-folder-other="${MINI}"]`)!.click());
  type(pathField(), '~/code/billing-svc/');
  await until(() => inDialog('[data-home-folder-start]') !== null, 'the Start row');
  act(() => inDialog('[data-home-folder-start]')!.click());
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder')).toBe('prj_bill_m');
});

test.skipIf(!hasDom)('↓ and Enter open the row; Escape goes back to the list with the row still highlighted, and the dialog stays', async () => {
  await open();
  await startAndOpenMenu();
  const find = inDialog('[data-compose-folders] input')!;
  key(find, 'ArrowDown');
  key(find, 'ArrowDown');
  key(find, 'Enter');
  expect(inDialog('[data-home-folders]')).not.toBeNull();
  key(pathField(), 'Escape');
  expect(inDialog('[data-home-folders]')).toBeNull();
  expect(inDialog('[data-compose-folder-other="self"]')!.getAttribute('aria-selected')).toBe('true');
  expect(document.querySelector('dialog[data-compose]')).not.toBeNull();
  // The back arrow too.
  key(inDialog('[data-compose-folders] input')!, 'Enter');
  act(() => inDialog('[data-home-folders-back]')!.click());
  expect(inDialog('[data-compose-folder-other="self"]')).not.toBeNull();
});

test.skipIf(!hasDom)('asleep: "Mac mini is asleep" in place of the folders, nothing read, nothing to start', async () => {
  await twoMachinesMenu();
  act(() => inDialog('[data-compose-folder]')!.click());
  machines = [SELF_VIEW, view(MINI, 'Mac mini', { state: 'offline' })];
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 30));
  });
  act(() => inDialog('[data-compose-folder]')!.click());
  await until(() => all('[data-compose-folder-group]').some((g) => g.textContent === 'Mac mini · asleep'), 'the asleep caption');
  act(() => inDialog(`[data-compose-folder-other="${MINI}"]`)!.click());
  expect(inDialog('[data-home-folders-note="asleep"]')!.textContent).toBe('Mac mini is asleep');
  type(pathField(), '~/code/billing-api/');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(folderReads()).toEqual([]);
  expect(inDialog('[data-home-folder-start]')).toBeNull();
  expect(shownFolders()).toEqual([]);
});

test.skipIf(!hasDom)("a slow answer for a path no longer typed is dropped; a hidden path shows the server's words", async () => {
  await open();
  await startAndOpenMenu();
  let release!: () => void;
  slow = { path: '~/code', release: new Promise<void>((r) => (release = r)) };
  act(() => inDialog('[data-compose-folder-other="self"]')!.click());
  type(pathField(), '~/code/');
  await until(() => folderReads().some((r) => r.at === '~/code'), 'the slow read asked');
  type(pathField(), '~/n');
  await until(() => shownFolders().join() === 'notes', "home's n folders");
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(shownFolders()).toEqual(['notes']);

  type(pathField(), '~/.ssh/');
  await until(() => inDialog('[data-home-folders-note="error"]') !== null, 'the refusal');
  expect(inDialog('[data-home-folders-note="error"]')!.textContent).toBe("Hidden folders aren't listed.");
});
