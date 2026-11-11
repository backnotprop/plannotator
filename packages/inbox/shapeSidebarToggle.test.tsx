import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createShapeStore } from '../shared/shape/store';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';
import type { InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  // The real board (tsconfig `paths` points the window's typecheck at its .d.ts). By a path in a variable: the
  // window's strict typecheck must not follow it into review-editor.
  const seam: string = './shape/ShapeBoard.tsx';
  const real = (await import(seam)) as Record<string, unknown>;
  mock.module('#shape-board', () => real);
}
const { ShapeLayer } = (hasDom ? await import('./shape/ShapeParts') : {}) as typeof import('./shape/ShapeParts');
const { Sidebar, SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
const dirs: string[] = [];
const restore: Array<() => void> = [];
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  for (const undo of restore.splice(0)) undo();
  document.body.innerHTML = '';
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function board(): ShapeLoaded {
  const dir = mkdtempSync(join(tmpdir(), 'shape-sidebar-toggle-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const made = store.update({ board: { title: 'Kettle', claim: 'Built.', views: { picture: { html: '<p data-mark="k">One whistle</p>' } } }, project: { root: dir, name: 'relay' }, session: { id: 'ses_a', host: 'claude-code' } });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { shape: made.record, version: store.read(made.id)!, seen: 1, notes: [], session: { state: 'live', agent: 'Claude Code' } };
}

function windowIs(phone: boolean) {
  const saved = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: phone && query.includes('max-width: 767px'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  restore.push(() => (window.matchMedia = saved));
}

async function mount(options: { thread?: InboxThread; phone?: boolean } = {}): Promise<{ el: HTMLElement; stored: boolean[] }> {
  windowIs(options.phone ?? false);
  // happy-dom lays nothing out, so every width reads 0, a phone's: the board is desktop-wide.
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
  restore.push(() => (width ? Object.defineProperty(HTMLElement.prototype, 'clientWidth', width) : delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth));
  const loaded = board();
  const host: ShapeHost = {
    load: async () => loaded,
    version: async () => loaded.version,
    note: async () => { throw new Error('not in this test'); },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
  };
  const stored: boolean[] = [];
  function Window() {
    const [open, setOpen] = useState(true);
    return (
      <SidebarProvider
        open={open}
        onOpenChange={(next) => {
          stored.push(next);
          setOpen(next);
        }}
      >
        <Sidebar>
          <nav data-test-nav="">Inbox</nav>
        </Sidebar>
        <main className="ib-main" data-shape-open="">
          <ShapeLayer host={host} id={loaded.shape.id} onClose={() => {}} thread={options.thread ?? null} />
        </main>
      </SidebarProvider>
    );
  }
  const el = document.createElement('div');
  el.className = 'pn-inbox';
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<Window />));
  for (let i = 0; i < 100 && !el.querySelector('.shp-head h1'); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(el.querySelector('.shp-head h1')?.textContent).toBe('Kettle');
  return { el, stored };
}

const sidebarState = (el: ParentNode) => el.querySelector('[data-slot="sidebar"][data-state]')?.getAttribute('data-state') ?? null;
const boardToggle = (el: ParentNode) => el.querySelector<HTMLButtonElement>('.shp-head [data-sidebar="trigger"]');

const THREAD = { thread_id: 'thr_1', messages: [], project: { root: '/work/relay', repo: null } } as unknown as InboxThread;

for (const [where, thread] of [['the Shape page', undefined], ['a board over its thread', THREAD]] as const) {
  test.skipIf(!hasDom)(`${where}: the toggle sits left of the title, and closes and opens the sidebar`, async () => {
    const { el, stored } = await mount({ thread });
    const toggle = boardToggle(el);
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-label')).toBe('Toggle Sidebar');
    const row = el.querySelector('.shp-title-row')!;
    expect(row.firstElementChild!.contains(toggle)).toBe(true);
    expect(row.children[1]!.tagName).toBe('H1');
    expect(sidebarState(el)).toBe('expanded');

    act(() => toggle!.click());
    expect(sidebarState(el)).toBe('collapsed');
    expect(boardToggle(el)).toBe(toggle);
    act(() => toggle!.click());
    expect(sidebarState(el)).toBe('expanded');
    expect(stored).toEqual([false, true]);
  });
}

test.skipIf(!hasDom)('⌘/Ctrl+B closes and opens the sidebar with the board open', async () => {
  const { el, stored } = await mount();
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }));
  });
  expect(sidebarState(el)).toBe('collapsed');
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
  });
  expect(sidebarState(el)).toBe('expanded');
  expect(stored).toEqual([false, true]);
});

test.skipIf(!hasDom)('a phone has no toggle on the board: its sidebar is a sheet, and the board is as it was', async () => {
  const { el } = await mount({ phone: true });
  expect(boardToggle(el)).toBeNull();
  expect(el.querySelector('.shp-head-start')).toBeNull();
  expect(el.querySelector('.shp-title-row')!.firstElementChild!.tagName).toBe('H1');
});
