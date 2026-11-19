/**
 * A tick while its write is on its way (tagWrites.ts), for a thread's tag (useThreadTagsHost.ts) and a project's
 * (useProjectTags.ts), through the window's own hook with fetch mocked.
 *
 * The failures this catches: the second of two quick ticks flickering off when the first write's list read comes back
 * (the first write took the whole patch back); a tick for a linked machine that is away vanishing while its write
 * waits in the outbox (the clock toast says "Waiting for …", the tick must stay, pending); and a held tick that never
 * goes once the list says it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { MachineView, ProjectFolder } from './api';
import type { MachinesModel } from './machines';
import type { ListTag } from './threadTags';
import type { InboxToastModel } from './components/Toast';

const hasDom = typeof document !== 'undefined';
const { act } = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { useThreadTagsHost } = (hasDom ? await import('./useThreadTagsHost') : {}) as typeof import('./useThreadTagsHost');
const { setSelfMachine, rememberMachine, resetMachineRoutes } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');
const { errorToast } = (hasDom ? await import('./toastError') : {}) as typeof import('./toastError');

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MAC = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const tag = (id: string, name: string): ListTag => ({ id, name, created_at: '2026-11-18T09:00:00.000Z', created_by: { kind: 'person' }, updated_at: '2026-11-18T09:00:00.000Z', deleted_at: null }) as ListTag;
const WORK = tag('ini_work', 'Work');
const PERSONAL = tag('ini_personal', 'Personal');
const mac = { id: MAC, name: 'MacBook', self: false, state: 'offline', marks: ['tags', 'project-tags'] } as unknown as MachineView;
const MACHINES: MachinesModel = { self: SELF, all: [], linked: [mac], names: new Map(), away: new Set() };
const row = (id: string, machine: string, tags?: string[]) => ({ thread_id: id, machine, project: { id: 'prj_bill', name: 'billing-svc' }, ...(tags ? { tags } : {}) }) as unknown as InboxListRow;
const project = (id: string, machine: string, tags?: string[]) =>
  ({ id, name: id, key: id, root: `/code/${id}`, created_at: '2026-11-01T00:00:00.000Z', threads: 1, unread: 0, listed: 1, archived: 0, machine, ...(tags ? { tags } : {}) }) as ProjectFolder;
const HELD = (route: string) =>
  Response.json(
    { outbox: { key: 'k1', machine: MAC, route, state: 'queued', queued_at: '2026-11-18T09:00:00.000Z', settled_at: null, status: null, answer: null, notice: null, dismissed: false, words: null, thread: null, machine_name: null }, machine: mac },
    { status: 202 },
  );

type Hosted = ReturnType<typeof useThreadTagsHost>;
let hosted: Hosted | null = null;
let draw: ((next: { rows: InboxListRow[]; projects: ProjectFolder[] }) => void) | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let savedFetch: typeof fetch;
const toasts: Omit<InboxToastModel, 'id'>[] = [];
/** Each list read, answered when the test says so. */
const reads: (() => void)[] = [];

function Harness({ rows, projects }: { rows: InboxListRow[]; projects: ProjectFolder[] }) {
  hosted = useThreadTagsHost({
    listTags: [WORK, PERSONAL],
    across: null,
    routeTag: null,
    machines: MACHINES,
    windowRows: rows,
    latestSections: [],
    rowOf: (id) => rows.find((r) => r.thread_id === id),
    showError: (cause) => toasts.push(errorToast(cause, 'The thread did not change.')),
    showToast: (toast) => toasts.push(toast),
    dismissToast: () => {},
    refreshList: () => new Promise<void>((resolve) => reads.push(resolve)),
    openTag: () => {},
    tagGone: () => {},
    tagColours: null,
    projects,
  });
  return null;
}

function mount(rows: InboxListRow[], projects: ProjectFolder[]) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  draw = (next) => act(() => root!.render(<Harness {...next} />));
  act(() => {
    root = createRoot(host);
    root.render(<Harness rows={rows} projects={projects} />);
  });
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  setSelfMachine(SELF);
  toasts.length = 0;
  reads.length = 0;
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  if (!hasDom) return;
  for (const read of reads.splice(0)) read();
  act(() => root?.unmount());
  root = null;
  hosted = null;
  draw = null;
  globalThis.fetch = savedFetch;
  resetMachineRoutes();
  document.body.innerHTML = '';
});

const threadTicks = (id: string) => [...hosted!.threadTagsHost!.tagsOf(id)];
const projectTicks = (id: string) => [...hosted!.threadTagsHost!.projects!.target(id).on];

test.skipIf(!hasDom)("two quick ticks on a thread: the first write's list read does not take the second tick off", async () => {
  globalThis.fetch = (async () => Response.json({ tags: [] })) as unknown as typeof fetch;
  const rows = [row('msg_a', SELF)];
  mount(rows, []);
  act(() => hosted!.threadTagsHost!.set('msg_a', WORK, true));
  await settle();
  act(() => hosted!.threadTagsHost!.set('msg_a', PERSONAL, true));
  await settle();
  expect(reads.length).toBe(2);
  // The first write's read comes back with only Work: the second tick is still on its way and stays.
  draw!({ rows: [row('msg_a', SELF, ['ini_work'])], projects: [] });
  reads.shift()!();
  await settle();
  expect(threadTicks('msg_a').sort()).toEqual(['ini_personal', 'ini_work']);
  draw!({ rows: [row('msg_a', SELF, ['ini_work', 'ini_personal'])], projects: [] });
  reads.shift()!();
  await settle();
  expect(threadTicks('msg_a').sort()).toEqual(['ini_personal', 'ini_work']);
});

test.skipIf(!hasDom)('two quick ticks on a project: the second stays while its write is in flight', async () => {
  globalThis.fetch = (async () => Response.json({ tags: [] })) as unknown as typeof fetch;
  mount([], [project('prj_bill', SELF)]);
  act(() => hosted!.threadTagsHost!.projects!.target('prj_bill').set(WORK, true));
  await settle();
  act(() => hosted!.threadTagsHost!.projects!.target('prj_bill').set(PERSONAL, true));
  await settle();
  draw!({ rows: [], projects: [project('prj_bill', SELF, ['ini_work'])] });
  reads.shift()!();
  await settle();
  expect(projectTicks('prj_bill')).toEqual(['ini_work', 'ini_personal']);
});

test.skipIf(!hasDom)("a thread tag held for a machine that is away stays ticked, says it waits, and goes once the list says it", async () => {
  rememberMachine(['msg_far'], MAC);
  globalThis.fetch = (async () => HELD('threads/msg_far/tags')) as unknown as typeof fetch;
  mount([row('msg_far', MAC)], []);
  act(() => hosted!.threadTagsHost!.set('msg_far', WORK, true));
  await settle();
  expect(toasts.map((t) => t.lead)).toEqual(['Waiting for MacBook: this applies when MacBook is back.']);
  expect(threadTicks('msg_far')).toEqual(['ini_work']);
  // A list read while the machine is still away: the tick stays.
  draw!({ rows: [row('msg_far', MAC)], projects: [] });
  await settle();
  expect(threadTicks('msg_far')).toEqual(['ini_work']);
  // The machine is back and the write landed: the list says it, and later list reads are what the thread shows.
  draw!({ rows: [row('msg_far', MAC, ['ini_work'])], projects: [] });
  await settle();
  draw!({ rows: [row('msg_far', MAC, ['ini_personal'])], projects: [] });
  await settle();
  expect(threadTicks('msg_far')).toEqual(['ini_personal']);
});

test.skipIf(!hasDom)("a project tag held for a machine that is away stays ticked, says it waits, and goes once the list says it", async () => {
  globalThis.fetch = (async () => HELD('projects/prj_far/tags')) as unknown as typeof fetch;
  mount([], [project('prj_far', MAC)]);
  act(() => hosted!.threadTagsHost!.projects!.target('prj_far').set(WORK, true));
  await settle();
  expect(toasts.map((t) => t.lead)).toEqual(['Waiting for MacBook: this applies when MacBook is back.']);
  expect(projectTicks('prj_far')).toEqual(['ini_work']);
  draw!({ rows: [], projects: [project('prj_far', MAC)] });
  await settle();
  expect(projectTicks('prj_far')).toEqual(['ini_work']);
  draw!({ rows: [], projects: [project('prj_far', MAC, ['ini_work'])] });
  await settle();
  draw!({ rows: [], projects: [project('prj_far', MAC)] });
  await settle();
  expect(projectTicks('prj_far')).toEqual([]);
});
