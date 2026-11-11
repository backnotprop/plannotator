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

const TREES: Record<string, Record<string, string[]>> = {
  self: {
    '~': ['code', 'Documents', 'notes'],
    '~/code': ['notes-local', 'web-app'],
    '~/code/notes-local': [],
    '~/code/web-app': ['src'],
    '~/Documents': ['Archive'],
    '~/Documents/Archive': ['2024'],
    '/Volumes/Studio SSD': ['footage', 'renders'],
    '/Volumes/Studio SSD/footage': ['day-1'],
  },
  [MINI]: { '~': ['code'], '~/code': ['billing-api', 'billing-reports', 'billing-svc', 'infra'], '~/code/billing-api': [], '~/code/billing-svc': ['src'] },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
let machines: MachineView[] = [SELF_VIEW];
const UNWRITABLE = new Set(['~/Documents/Archive']);
let slow: { path: string; release: Promise<void> } | null = null;
let sent: ComposeSent[] = [];
let here: InboxComposeLaunch = HERE;
let slowDrive: string | null = null;

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
  saved = [];
  slow = null;
  machines = [SELF_VIEW];
  here = HERE;
  slowDrive = null;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (method === 'POST' && path.startsWith('/api/inbox/drafts/')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      saved.push({ path, body });
      return Response.json({ draft: { v: 1, id: 'drf_01ARZ3NDEKTSV4RRFFQ69G5FT2', created_at: 'x', updated_at: 'y', files: [], ...body, status: 'none' } });
    }
    if (method === 'POST') {
      if (path === `/api/inbox/m/${MINI}/messages` || path === '/api/inbox/messages') return Response.json({ thread_id: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FT1', launch: { id: 'lch_1', state: 'starting' } });
      return Response.json({});
    }
    const read = folderRead(path);
    if (read) {
      if (slow && slow.path === read.at) await slow.release;
      if (read.at.split('/').some((s) => s.startsWith('.'))) return Response.json({ error: "Hidden folders aren't listed.", code: 'folder_hidden' }, { status: 422 });
      if (slowDrive && read.at.startsWith(slowDrive)) return Response.json({ error: 'Backup isn\'t responding.', code: 'folder_slow', drive: 'Backup' }, { status: 504 });
      const tree = TREES[read.machine] ?? {};
      const folders = tree[read.at];
      if (folders) return Response.json({ path: read.at, exists: true, state: 'folder', folders, writable: !UNWRITABLE.has(read.at) });
      let up = read.at;
      while (up !== '~' && up !== '/' && !tree[up]) up = up.slice(0, up.lastIndexOf('/')) || (up.startsWith('/') ? '/' : '~');
      return Response.json({ path: read.at, exists: false, folders: [], ...(tree[up] ? { nearest: { path: up, folders: tree[up] } } : {}) });
    }
    if (path.startsWith('/api/inbox/machines')) return Response.json({ self: SELF, machines });
    if (path.startsWith(`/api/inbox/m/${MINI}/sessions`)) return Response.json({ serverSession: 't', home: '/Users/mini', projects: [], launch: MINI_BLOCK });
    if (path.startsWith('/api/inbox/sessions')) return Response.json({ serverSession: 's', home: '/Users/me', projects: [], launch: here });
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

let saved: { path: string; body: Record<string, unknown> }[] = [];

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
const pathField = () => inDialog('[data-home-folders-path]') as HTMLInputElement;
const folderReads = () => requests.flatMap((r) => (r.method === 'GET' && folderRead(r.path) ? [folderRead(r.path)!] : []));
const shownFolders = () => all('[data-home-folder-option]').map((r) => r.getAttribute('data-home-folder-option'));
const line = () => inDialog('[data-home-folders-note="line"]')?.textContent ?? null;
const belowCreate = () => {
  const after = inDialog('[data-home-folders-after]');
  return after ? all('[data-home-folder-option]').filter((r) => after.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING).map((r) => r.getAttribute('data-home-folder-option')) : [];
};
const key = (target: Element, name: string) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
const machinesRead = () => requests.some((r) => r.path === `/api/inbox/m/${MINI}/sessions`);

async function twoMachinesMenu() {
  machines = [SELF_VIEW, view(MINI, 'Mac mini')];
  await open();
  await until(machinesRead, "Mac mini's sessions read");
  await startAndOpenMenu();
  await until(() => all('[data-compose-folder-group]').length === 2, 'two groups');
}

test.skipIf(!hasDom)('only this computer: "Another folder…" ends the list, reads here, offers Create for a missing name, and Send names the folder here', async () => {
  await open();
  await startAndOpenMenu();
  expect(all('[data-compose-folder-option]').map((r) => r.getAttribute('data-compose-folder-option'))).toEqual(['prj_web', INBOX_SCRATCH_PICK]);
  const row = inDialog('[data-compose-folder-other="self"]')!;
  expect(row.textContent).toBe('Another folder…');
  expect(all('[data-compose-folder-group]')).toHaveLength(0);
  act(() => row.click());
  expect(inDialog('[data-home-folders] .ib-hfb-head')!.textContent).toBe('A folder');
  expect(pathField().value).toBe('~/');
  expect(document.activeElement).toBe(pathField());
  await until(() => shownFolders().length === 3, "home's folders");
  expect(shownFolders()).toEqual(['code', 'Documents', 'notes']);

  type(pathField(), '~/code/nope');
  await until(() => inDialog('[data-home-folder-create]') !== null, 'the Create row');
  expect(inDialog('[data-home-folder-create]')!.textContent).toBe('Create nope and start~/code/nope');
  expect(inDialog('[data-home-folder-create]')!.getAttribute('aria-selected')).toBe('true');
  expect(all('[data-home-folder-start]')).toHaveLength(0);
  expect(inDialog('[data-home-folders-after]')!.textContent).toBe("A new, empty folder. Or pick one that's there:");
  expect(belowCreate()).toEqual(['notes-local', 'web-app']);
  type(pathField(), '~/cod/notes');
  await until(() => line() === "There's no ~/cod.", 'the typo line');
  expect(inDialog('[data-home-folder-row="fix"]')!.textContent).toBe('Go to ~/code/notes');
  key(pathField(), 'Enter');
  expect(pathField().value).toBe('~/code/notes');
  await until(() => inDialog('[data-home-folder-create]') !== null, 'the quiet Create row');
  expect(all('[data-home-folder-row]').map((r) => r.getAttribute('data-home-folder-row'))).toEqual(['folder', 'create']);
  expect(inDialog('[data-home-folder-create]')!.className).toContain('ib-hfb-quiet');
  type(pathField(), '~/code/');
  await until(() => shownFolders().join() === 'notes-local,web-app', "code's folders");
  expect(line()).toBeNull();

  type(pathField(), '~/code/NO');
  await until(() => shownFolders().join() === 'notes-local', 'the narrowed folders');
  act(() => inDialog('[data-home-folder-option="notes-local"]')!.click());
  expect(pathField().value).toBe('~/code/notes-local/');
  await until(() => inDialog('[data-home-folder-start]') !== null, 'the Start row');
  expect(inDialog('[data-home-folder-start]')!.getAttribute('data-home-folder-start')).toBe('~/code/notes-local');
  expect(folderReads().every((r) => r.machine === 'self')).toBe(true);
  expect(folderReads().map((r) => r.at)).toContain('~/code/notes-local');

  act(() => inDialog('[data-home-folder-start]')!.click());
  expect(all('[data-compose-folders]')).toHaveLength(0);
  expect(inDialog('[data-compose-folder] bdi')!.textContent).toBe('notes-local');
  expect(all('[data-compose-machine]')).toHaveLength(0);
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
  await until(() => inDialog('[data-home-folder-create]') !== null, 'the Create row');
  expect(belowCreate()).toEqual(['billing-svc', 'billing-api', 'billing-reports', 'infra']);
  expect(folderReads().filter((r) => r.at === '~/code/biling-svc')).toEqual([{ machine: MINI, at: '~/code/biling-svc' }]);
  type(pathField(), '~/code/billing-api/x');
  await until(() => inDialog('[data-home-folder-create="~/code/billing-api/x"]') !== null, 'Create in an empty folder');
  expect(all('[data-home-folders-after]')).toHaveLength(0);
  expect(shownFolders()).toEqual([]);

  type(pathField(), '~/code/billing-a');
  await until(() => shownFolders().join() === 'billing-api', 'billing-api');
  key(pathField(), 'Enter');
  expect(pathField().value).toBe('~/code/billing-api/');
  await until(() => inDialog('[data-home-folder-start]') !== null, 'the Start row');
  expect(inDialog('[data-home-folder-start]')!.getAttribute('aria-selected')).toBe('true');
  key(pathField(), 'Enter');
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
  expect(all('[data-home-folders]')).toHaveLength(0);
  expect(inDialog('[data-compose-folder-other="self"]')!.getAttribute('aria-selected')).toBe('true');
  expect(document.querySelector('dialog[data-compose]')).not.toBeNull();
  key(inDialog('[data-compose-folders] input')!, 'Enter');
  act(() => inDialog('[data-home-folders-back]')!.click());
  expect(inDialog('[data-compose-folder-other="self"]')).not.toBeNull();
});

test.skipIf(!hasDom)('asleep: no "Another folder on Mac mini…" row; a browser open when Mac mini falls asleep says so and reads nothing more', async () => {
  await twoMachinesMenu();
  act(() => inDialog(`[data-compose-folder-other="${MINI}"]`)!.click());
  await until(() => shownFolders().join() === 'code', "Mac mini's home");
  machines = [SELF_VIEW, view(MINI, 'Mac mini', { state: 'offline' })];
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 30));
  });
  await until(() => inDialog('[data-home-folders-note="asleep"]') !== null, 'the asleep line');
  expect(inDialog('[data-home-folders-note="asleep"]')!.textContent).toBe('Mac mini is asleep');
  const before = folderReads().length;
  type(pathField(), '~/code/billing-api/');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(folderReads()).toHaveLength(before);
  // Absence by count: after this test's many renders, Bun's toBeNull() was seen passing on an element.
  expect(all('[data-home-folder-start]')).toHaveLength(0);
  expect(shownFolders()).toEqual([]);
  act(() => inDialog('[data-home-folders-back]')!.click());
  await until(() => all('[data-compose-folder-group]').some((g) => g.textContent === 'Mac mini · asleep'), 'the asleep caption');
  expect(all('[data-compose-folder-other]').map((r) => r.getAttribute('data-compose-folder-other'))).toEqual(['self']);
});

test.skipIf(!hasDom)('a slow answer for a path no longer typed is dropped; a hidden path is said and never read', async () => {
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

  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  const reads = folderReads().length;
  type(pathField(), '~/.ssh/');
  await until(() => line() === "Hidden folders aren't offered.", 'the hidden line');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  expect(folderReads()).toHaveLength(reads);
});

async function browseHere(path: string) {
  await open();
  await startAndOpenMenu();
  act(() => inDialog('[data-compose-folder-other="self"]')!.click());
  type(pathField(), path);
}

function paste(input: HTMLInputElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } };
  event.clipboardData = { getData: () => text };
  act(() => {
    input.focus();
    input.select();
    input.dispatchEvent(event);
  });
}

test.skipIf(!hasDom)('Create a folder: picked, To carries the new-folder mark, and the Send asks the server to make it (A4, A13)', async () => {
  await browseHere('~/code/pricing-page');
  await until(() => inDialog('[data-home-folder-create]') !== null, 'the Create row');
  key(pathField(), 'Enter');
  const chip = inDialog('[data-compose-folder]')!;
  expect(chip.hasAttribute('data-compose-folder-new')).toBe(true);
  expect(chip.querySelector('bdi')!.textContent).toBe('pricing-page');
  expect(chip.getAttribute('aria-label')).toBe('Start in: pricing-page, a new folder at ~/code/pricing-page, made when you send. Change');
  type(inDialog('textarea') as HTMLTextAreaElement, 'Add a pricing page.');
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => sent.length === 1, 'the send');
  expect(requests.filter((r) => r.method === 'POST')[0]!.body!.to).toEqual({ launch: { agent: AGENT, folder: '~/code/pricing-page', create: true } });
});

test.skipIf(!hasDom)('A10: a folder that can not be written offers no Create, and its folders are still there', async () => {
  await browseHere('~/Documents/Archive/q3');
  await until(() => line() !== null, 'the line');
  expect(line()).toBe("Can't make a folder in ~/Documents/Archive: no permission.");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });
  expect(all('[data-home-folder-create]')).toHaveLength(0);
  expect(shownFolders()).toEqual(['2024']);
});

test.skipIf(!hasDom)('B4: a path pasted into "Find a project" keeps the projects under it, and "Another folder…" opens there', async () => {
  await open();
  await startAndOpenMenu();
  paste(inDialog('[data-compose-folders] input') as HTMLInputElement, '"/Users/me/code/web-app"');
  expect((inDialog('[data-compose-folders] input') as HTMLInputElement).value).toBe('/Users/me/code/web-app');
  expect(all('[data-compose-folder-option]').map((r) => r.getAttribute('data-compose-folder-option'))).toEqual(['prj_web']);
  const other = inDialog('[data-compose-folder-other="self"]')!;
  expect(other.getAttribute('aria-label')).toBe('Another folder, ~/code/web-app');
  act(() => other.click());
  expect(pathField().value).toBe('~/code/web-app');
  await until(() => inDialog('[data-home-folder-start]') !== null, 'the Start row');
  expect(inDialog('[data-home-folder-start]')!.getAttribute('data-home-folder-start')).toBe('~/code/web-app');
});

test.skipIf(!hasDom)('B3: a pasted path is cleaned in the window (file://, quotes, Terminal escapes), as the server refuses backslashes', async () => {
  await browseHere('~/');
  paste(pathField(), 'file:///Users/me/code/notes-local/');
  expect(pathField().value).toBe('~/code/notes-local/');
  paste(pathField(), "'/Users/me/code/Client\\ Work'");
  expect(pathField().value).toBe('~/code/Client Work');
});

test.skipIf(!hasDom)('D2: back from the browser keeps the path typed; "Another folder…" opens on it again', async () => {
  await browseHere('~/code/no');
  key(pathField(), 'Escape');
  expect(all('[data-home-folders]')).toHaveLength(0);
  act(() => inDialog('[data-compose-folder-other="self"]')!.click());
  expect(pathField().value).toBe('~/code/no');
});

test.skipIf(!hasDom)('D8, D9: a kept draft keeps the Create pick; reopened, it comes back, and a folder there by now loses the mark', async () => {
  await browseHere('~/code/pricing-page');
  await until(() => inDialog('[data-home-folder-create]') !== null, 'the Create row');
  key(pathField(), 'Enter');
  type(inDialog('textarea') as HTMLTextAreaElement, 'Add a pricing page.');
  key(inDialog('textarea')!, 'Escape');
  await until(() => saved.length === 1, 'the draft saved');
  const start = saved[0]!.body.start;
  expect(start).toEqual({ agent: AGENT, machine: null, folder: '~/code/pricing-page', name: 'pricing-page', create: true });
  act(() => root?.unmount());
  host?.remove();
  const draft = { v: 1, id: 'drf_01ARZ3NDEKTSV4RRFFQ69G5FT2', created_at: 'x', updated_at: 'y', body: 'Add a pricing page.', to: null, project: null, files: [], status: 'none', start };
  await open({ draft });
  await until(() => inDialog('[data-compose-folder]') !== null, 'the folder button');
  expect(inDialog('[data-compose-folder]')!.hasAttribute('data-compose-folder-new')).toBe(true);
  act(() => root?.unmount());
  host?.remove();
  TREES.self!['~/code/pricing-page'] = [];
  try {
    await open({ draft });
    await until(() => inDialog('[data-compose-folder]') !== null && !inDialog('[data-compose-folder]')!.hasAttribute('data-compose-folder-new'), 'the mark dropped');
    expect(inDialog('[data-compose-folder] bdi')!.textContent).toBe('pricing-page');
  } finally {
    delete TREES.self!['~/code/pricing-page'];
  }
});

test.skipIf(!hasDom)('G3 (q-5e334740): Tab on a highlighted folder fills it in as a shell does; with no folder highlighted, or Shift+Tab, focus moves as usual', async () => {
  await open();
  await startAndOpenMenu();
  act(() => inDialog('[data-compose-folder-other="self"]')!.click());
  await until(() => shownFolders().length === 3, "home's folders");
  const tab = (shift = false) => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
    act(() => {
      pathField().dispatchEvent(event);
    });
    return event;
  };
  type(pathField(), '~/code/no');
  await until(() => shownFolders().join() === 'notes-local', 'the suggestion');
  expect(tab(true).defaultPrevented).toBe(false);
  expect(pathField().value).toBe('~/code/no');
  expect(tab().defaultPrevented).toBe(true);
  expect(pathField().value).toBe('~/code/notes-local/');
  await until(() => inDialog('[data-home-folder-start]') !== null, 'the folder filled in');
  type(pathField(), '~/code/nope');
  await until(() => inDialog('[data-home-folder-create]')?.getAttribute('aria-selected') === 'true', 'the Create row');
  expect(tab().defaultPrevented).toBe(false);
  expect(pathField().value).toBe('~/code/nope');
});

test.skipIf(!hasDom)('drives: a row each after "Another folder…", opening the browser at the drive; an unplugged project says so; a slow drive says it and offers Try again', async () => {
  here = {
    ...HERE,
    projects: [
      ...HERE.projects,
      { id: 'prj_old', name: 'old-site', root: '/Volumes/Archive/old-site', exists: false },
      { id: 'prj_tools', name: 'footage-tools', root: '/Volumes/Studio SSD/clients/footage-tools', exists: true },
    ],
    drives: [
      { path: '/Volumes/Backup', name: 'Backup', network: true },
      { path: '/Volumes/Studio SSD', name: 'Studio SSD' },
    ],
    finder: true,
  };
  slowDrive = '/Volumes/Backup';
  await open();
  await startAndOpenMenu();
  const old = inDialog('[data-compose-folder-option="prj_old"]')!;
  expect(old.textContent).toContain("old-site · Archive isn't connected");
  expect(old.textContent).toContain('Connect it to start here');
  expect(old.getAttribute('aria-disabled')).toBe('true');
  act(() => old.click());
  expect(inDialog('[data-compose-folder-option="prj_old"]')).not.toBeNull();
  expect(inDialog('[data-compose-note="folder-missing"]')).toBeNull();
  expect(inDialog('[data-compose-folder-option="prj_tools"] [data-folder-drive-path]')!.textContent!.replace(/\u00a0/g, ' ')).toBe('Studio SSD › clients › footage-tools');
  expect(all('[data-compose-folder-drive]').map((r) => r.textContent)).toEqual(['Backup… · network drive/Volumes/Backup', 'Studio SSD…/Volumes/Studio SSD']);
  act(() => inDialog('[data-compose-folder-drive="/Volumes/Studio SSD"]')!.click());
  expect(pathField().value).toBe('/Volumes/Studio SSD/');
  await until(() => inDialog('[data-home-folder-start]') !== null, "the drive's Start row");
  expect(inDialog('[data-home-folder-start]')!.getAttribute('data-home-folder-start')).toBe('/Volumes/Studio SSD');
  expect(shownFolders()).toEqual(['footage', 'renders']);
  expect(all('[data-home-folders-place]').map((b) => `${b.textContent}${b.getAttribute('aria-checked') === 'true' ? ' (on)' : ''}`)).toEqual(['Home', 'Backup', 'Studio SSD (on)']);
  expect(inDialog('[data-home-folders-finder]')).toBeNull();

  act(() => inDialog('[data-home-folders-place="/Volumes/Backup"]')!.click());
  await until(() => inDialog('[data-home-folders-note="slow"]') !== null, 'the slow line');
  expect(inDialog('[data-home-folders-note="slow"]')!.textContent).toBe("Backup isn't responding. Try again");
  await until(() => inDialog('[data-home-folders-place="/Volumes/Backup"]')!.hasAttribute('data-quiet'), 'Backup marked');
  expect(inDialog('[data-home-folders-place="/Volumes/Backup"]')!.textContent).toBe("Backup · isn't responding");
  act(() => inDialog('[data-home-folders-place="/Volumes/Studio SSD"]')!.click());
  await until(() => shownFolders().includes('footage'), "the drive's folders");
  const asked = requests.filter((r) => r.path.includes(encodeURIComponent('/Volumes/Backup'))).length;
  act(() => inDialog('[data-home-folders-place="/Volumes/Backup"]')!.click());
  expect(inDialog('[data-home-folders-note="slow"]')!.textContent).toBe("Backup isn't responding. Try again");
  await new Promise((r) => setTimeout(r, 300));
  expect(requests.filter((r) => r.path.includes(encodeURIComponent('/Volumes/Backup'))).length).toBe(asked);
  slowDrive = null;
  TREES.self!['/Volumes/Backup'] = ['jobs'];
  act(() => inDialog('[data-home-folders-retry]')!.click());
  await until(() => shownFolders().join() === 'jobs', "Backup's folders after Try again");
  expect(requests.some((r) => r.path.includes('fresh=1'))).toBe(true);
  expect(inDialog('[data-home-folders-place="/Volumes/Backup"]')!.hasAttribute('data-quiet')).toBe(false);

  act(() => inDialog('[data-home-folders-place="/Volumes/Studio SSD"]')!.click());
  await until(() => shownFolders().includes('footage'), "the drive's folders");
  act(() => inDialog('[data-home-folder-option="footage"]')!.click());
  await until(() => inDialog('[data-home-folder-start="/Volumes/Studio SSD/footage"]') !== null, 'Start in footage');
  act(() => inDialog('[data-home-folder-start="/Volumes/Studio SSD/footage"]')!.click());
  type(inDialog('textarea') as HTMLTextAreaElement, 'Grade the second pass.');
  act(() => inDialog('[data-compose-send]')!.click());
  await until(() => requests.some((r) => r.method === 'POST' && r.path === '/api/inbox/messages'), 'the Send');
  const send = requests.find((r) => r.method === 'POST' && r.path === '/api/inbox/messages')!;
  expect((send.body!.to as { launch: { folder: string } }).launch.folder).toBe('/Volumes/Studio SSD/footage');
  delete TREES.self!['/Volumes/Backup'];
});
