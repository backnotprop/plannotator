/**
 * A project's ⋯ → Add tag (components/ProjectTagMenu.tsx, useProjectTags.ts): the thread menu's tag list, on the
 * project. A tick writes to the machine whose project it is: this Inbox's by the tag's id, a linked machine's by the
 * tag's name (it makes the tag there when it has none), and only on a machine that takes project tags.
 *
 * The failures this catches: no Add tag in the project menu; a tick that does not write, or writes a linked machine's
 * project here (or by an id that machine never had); Add tag offered on an older machine's project, whose door has no
 * route for it; a typed new tag that is not made; the menu closing on a tick (several tags are allowed); and Add tag
 * on an Inbox that keeps no tags.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxInitiative } from '@plannotator/core/inbox-types';
import type { MachineView, ProjectFolder } from './api';
import type { MachinesModel } from './machines';
import type { ThreadTagsHost } from './threadTags';

const hasDom = typeof document !== 'undefined';
const { ProjectRow } = (hasDom ? await import('./components/ProjectRow') : {}) as typeof import('./components/ProjectRow');
const { ThreadTagsContext } = (hasDom ? await import('./threadTags') : {}) as typeof import('./threadTags');
const { useProjectTags } = (hasDom ? await import('./useProjectTags') : {}) as typeof import('./useProjectTags');
const { setSelfMachine, resetMachineRoutes } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MAC = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const OLD = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAX';
const tag = (id: string, name: string): InboxInitiative => ({ id, name, created_at: '2026-11-18T09:00:00.000Z', created_by: { kind: 'person' }, updated_at: '2026-11-18T09:00:00.000Z', deleted_at: null });
const WORK = tag('ini_work', 'Work');
const PERSONAL = tag('ini_personal', 'Personal');
const project = (id: string, name: string, machine: string, tags?: string[]): ProjectFolder =>
  ({ id, name, key: name, root: `/code/${name}`, created_at: '2026-11-01T00:00:00.000Z', threads: 2, unread: 0, listed: 2, archived: 0, machine, ...(tags ? { tags } : {}) }) as ProjectFolder;
const view = (id: string, name: string, marks: string[]): MachineView => ({ id, name, self: false, state: 'online', marks }) as unknown as MachineView;
const MACHINES: MachinesModel = { self: SELF, all: [], linked: [view(MAC, 'MacBook', ['tags', 'project-tags']), view(OLD, 'Mini', ['tags'])], names: new Map(), away: new Set() };
const PROJECTS = [project('prj_bill', 'billing-svc', SELF, ['ini_personal']), project('prj_far', 'site', MAC), project('prj_old', 'notes', OLD)];

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const posted: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  resetMachineRoutes();
  setSelfMachine(SELF);
  posted.length = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push({ url: String(input), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return Response.json({ tags: [] });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  resetMachineRoutes();
  document.body.innerHTML = '';
});

function Harness({ keepsTags }: { keepsTags: boolean }) {
  const own = () => [] as readonly string[];
  const tags = useProjectTags({ projects: PROJECTS, machines: MACHINES, tagsOfRow: own, showError: () => {}, showToast: () => {}, dismissToast: () => {}, refreshList: async () => {} });
  const value: ThreadTagsHost = { tags: [WORK, PERSONAL], tagsOf: () => [], counts: new Map(), can: () => true, set: () => {}, createAndSet: () => {}, listed: null, projects: tags.projectTagsHost };
  return (
    <ThreadTagsContext.Provider value={keepsTags ? value : null}>
      {PROJECTS.map((p) => (
        <ProjectRow key={p.id} project={p} count={0} on={false} held={false} readable phone={false} onOpen={() => {}} onAction={() => {}} />
      ))}
    </ThreadTagsContext.Provider>
  );
}

function mount(keepsTags = true) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness keepsTags={keepsTags} />);
  });
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
  await settle();
}
async function click(target: HTMLElement) {
  await act(async () => target.click());
  await settle();
}
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
async function openMenu(id: string) {
  await press($(`[data-pmore="${id}"]`)!);
  return $(`[data-project-menu="${id}"]`);
}
async function closeMenu() {
  act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
}

test.skipIf(!hasDom)("a project's ⋯ has Add tag after the batches; its list ticks the project's tags and a tick writes this Inbox's project by the tag's id", async () => {
  mount();
  const menu = await openMenu('prj_bill');
  expect(menu?.querySelector('[data-project-action="archive"] + [role="separator"] + [data-add-tag-item]')).not.toBeNull();
  // The item counts the project's tags, as a thread's does.
  expect(menu!.querySelector('[data-add-tag-item]')!.textContent).toContain('1');
  await click(menu!.querySelector<HTMLElement>('[data-add-tag-item]')!);
  expect($('[data-tag-pick="ini_personal"]')?.getAttribute('aria-checked')).toBe('true');
  expect($('[data-tag-pick="ini_work"]')?.getAttribute('aria-checked')).toBe('false');
  await click($('[data-tag-pick="ini_work"]')!);
  expect(posted).toEqual([{ url: '/api/inbox/projects/prj_bill/tags', body: expect.objectContaining({ tag: 'ini_work', on: true }) }]);
  // Several tags are allowed: the list stays open.
  expect($('[data-tag-pick="ini_personal"]')).not.toBeNull();
});

test.skipIf(!hasDom)('a typed name that is no tag makes it on the project', async () => {
  mount();
  await openMenu('prj_bill');
  await click($('[data-add-tag-item]')!);
  const field = $('[data-tag-find]') as HTMLInputElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(field, 'Clients');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  await click($('[data-tag-new]')!);
  expect(posted).toEqual([{ url: '/api/inbox/projects/prj_bill/tags', body: expect.objectContaining({ name: 'Clients', on: true }) }]);
});

test.skipIf(!hasDom)("a linked machine's project is tagged there by the tag's name, and only when that machine takes project tags", async () => {
  mount();
  expect((await openMenu('prj_old'))?.querySelector('[data-add-tag-item]')).toBeNull();
  await closeMenu();
  await openMenu('prj_far');
  await click($('[data-add-tag-item]')!);
  await click($('[data-tag-pick="ini_work"]')!);
  expect(posted).toEqual([{ url: `/api/inbox/m/${MAC}/projects/prj_far/tags`, body: expect.objectContaining({ name: 'Work', on: true }) }]);
});

test.skipIf(!hasDom)('an Inbox that keeps no tags offers no Add tag on a project', async () => {
  mount(false);
  const menu = await openMenu('prj_bill');
  expect(menu).not.toBeNull();
  expect(menu!.querySelector('[data-add-tag-item]')).toBeNull();
});
