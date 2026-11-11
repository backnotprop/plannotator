import { afterEach, expect, mock, setSystemTime, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { MachinesModel } from './machines';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const SELF = 'ibx_self';
const OTHER = 'ibx_other';
const MACHINES = { self: SELF, all: [], linked: [], names: new Map([[OTHER, 'MacBook']]), away: new Set<string>() } as MachinesModel;

function row(id: string, machine?: string): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'plannotator' },
    thread_name: null,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 1,
    sent: null,
    guide: false,
    ...(machine ? { machine } : {}),
  } as InboxListRow;
}

let host: HTMLElement | null = null;
let root: Root | null = null;

// A press on a star is remembered for a moment: each test starts well after the last one's.
let clock = Date.parse('2026-11-05T10:00:00.000Z');

afterEach(() => {
  setSystemTime();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

function draw(rows: InboxListRow[], opts: { pinned?: string[]; narrow?: boolean; phone?: boolean; machines?: MachinesModel } = {}) {
  const onOpen = mock((_: InboxListRow) => {});
  const onUnstar = mock((_: InboxListRow) => {});
  const sections: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: rows }];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList
            title="Inbox"
            path={null}
            sections={sections}
            filtered={false}
            narrow={opts.narrow ?? false}
            phone={opts.phone}
            selectedThreadId={null}
            notice={null}
            onShowNew={() => {}}
            onOpen={onOpen}
            onUnstar={onUnstar}
            pinned={new Set(opts.pinned ?? [])}
            machines={opts.machines}
          />
        </div>
      </SidebarProvider>,
    );
  });
  lastDraw = { sections, opts, onOpen, onUnstar };
  return { onOpen, onUnstar };
}

let lastDraw: { sections: InboxListSection[]; opts: { narrow?: boolean; phone?: boolean; machines?: MachinesModel }; onOpen: (row: InboxListRow) => void; onUnstar: (row: InboxListRow) => void } | null = null;

function draw2(ids: string[]) {
  const { opts, onOpen, onUnstar } = lastDraw!;
  const sections: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: ids.map((id) => row(id)) }];
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList
            title="Inbox"
            path={null}
            sections={sections}
            filtered={false}
            narrow={opts.narrow ?? false}
            phone={opts.phone}
            selectedThreadId={null}
            notice={null}
            onShowNew={() => {}}
            onOpen={onOpen}
            onUnstar={onUnstar}
            pinned={new Set()}
            machines={opts.machines}
          />
        </div>
      </SidebarProvider>,
    );
  });
}

const rowEl = (id: string) => host!.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
const star = (id: string) => rowEl(id).querySelector<HTMLElement>('[data-pin-mark]');
const pointerClick = (el: Element) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
const ids = (fn: ReturnType<typeof mock>) => fn.mock.calls.map(([r]) => (r as InboxListRow).thread_id);

for (const [shape, opts] of [['wide', {}], ['three-line', { narrow: true }], ['phone', { phone: true }]] as const) {
  test.skipIf(!hasDom)(`${shape} row: its star unstars; the rest of the row and its Enter open; an unstarred row has no star`, () => {
    setSystemTime(new Date(clock));
    clock += 10_000;
    const { onOpen, onUnstar } = draw([row('plain'), row('starred')], { ...opts, pinned: ['starred'] });
    expect(star('plain')).toBeNull();
    expect(rowEl('plain').querySelector('[data-star-press]')).toBeNull();
    pointerClick(star('starred')!);
    expect(ids(onUnstar)).toEqual(['starred']);
    expect(onOpen).not.toHaveBeenCalled();
    act(() => rowEl('starred').click());
    expect(ids(onOpen)).toEqual(['starred']);
    pointerClick(rowEl('plain'));
    expect(ids(onOpen)).toEqual(['starred', 'plain']);
    expect(ids(onUnstar)).toEqual(['starred']);
  });
}

test.skipIf(!hasDom)('a list with no star draws no star column', () => {
  draw([row('plain')]);
  expect(host!.querySelector('.ib-cpin')).toBeNull();
});

test.skipIf(!hasDom)("linked machines: this machine's own star unstars; a star on another machine's row is a mark, and a press there opens", () => {
  setSystemTime(new Date(clock));
  clock += 10_000;
  const { onOpen, onUnstar } = draw([row('mine', SELF), row('theirs', OTHER)], { machines: MACHINES, pinned: ['mine', 'theirs'] });
  pointerClick(star('mine')!);
  expect(ids(onUnstar)).toEqual(['mine']);
  expect(star('theirs')!.hasAttribute('data-star-press')).toBe(false);
  pointerClick(star('theirs')!);
  expect(ids(onUnstar)).toEqual(['mine']);
  expect(ids(onOpen)).toEqual(['theirs']);
});

function placeStar(id: string) {
  spyOn(star(id)!, 'getBoundingClientRect').mockImplementation(() => ({ left: 100, right: 113, top: 100, bottom: 113, x: 100, y: 100, width: 13, height: 13, toJSON: () => ({}) }) as DOMRect);
}

function pressAt(target: Element, x: number, y: number, pointerType: 'mouse' | 'touch' = 'mouse', detail = 1) {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType, clientX: x, clientY: y }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail, clientX: x, clientY: y }));
  });
}

for (const [pointer, reach] of [['mouse', 7], ['touch', 16]] as const) {
  for (const [shape, opts] of [['wide', {}], ['phone', { phone: true }]] as const) {
    test.skipIf(!hasDom)(`a ${pointer} on a ${shape} row reaches ${reach} px past the star, whatever the row's shape, and no further`, () => {
      setSystemTime(new Date(clock));
      clock += 10_000;
      const { onOpen, onUnstar } = draw([row('s')], { ...opts, pinned: ['s'] });
      placeStar('s');
      pressAt(rowEl('s'), 113 + reach + 1, 106, pointer);
      expect(onOpen.mock.calls.length).toBe(1);
      expect(onUnstar).not.toHaveBeenCalled();
      pressAt(rowEl('s'), 106, 100 - reach - 1, pointer);
      expect(onOpen.mock.calls.length).toBe(2);
      expect(onUnstar).not.toHaveBeenCalled();
      pressAt(rowEl('s'), 113 + reach, 106, pointer);
      expect(onUnstar.mock.calls.length).toBe(1);
      expect(onOpen.mock.calls.length).toBe(2);
    });
  }
}

test.skipIf(!hasDom)('a press on the star itself unstars wherever the box reads; the same place on the row opens', () => {
  setSystemTime(new Date(clock));
  clock += 10_000;
  const { onOpen, onUnstar } = draw([row('s')], { pinned: ['s'] });
  placeStar('s');
  pressAt(rowEl('s'), 500, 500);
  expect(onOpen.mock.calls.length).toBe(1);
  expect(onUnstar).not.toHaveBeenCalled();
  pressAt(star('s')!, 500, 500);
  expect(onUnstar.mock.calls.length).toBe(1);
  expect(onOpen.mock.calls.length).toBe(1);
});

test.skipIf(!hasDom)('a double press on the star: the second does nothing, even with the star gone; later, elsewhere or by Enter it opens', () => {
  const start = clock;
  clock += 10_000;
  setSystemTime(new Date(start));
  const { onOpen, onUnstar } = draw([row('s')], { pinned: ['s'] });
  placeStar('s');
  pressAt(star('s')!, 106, 106);
  expect(onUnstar.mock.calls.length).toBe(1);
  draw2(['s']);
  setSystemTime(new Date(start + 400));
  pressAt(rowEl('s'), 108, 104);
  expect(onOpen).not.toHaveBeenCalled();
  expect(onUnstar.mock.calls.length).toBe(1);
  act(() => rowEl('s').click());
  expect(onOpen.mock.calls.length).toBe(1);
  pressAt(rowEl('s'), 106 + 25, 106);
  expect(onOpen.mock.calls.length).toBe(2);
  setSystemTime(new Date(start + 401));
  pressAt(rowEl('s'), 106, 106);
  expect(onOpen.mock.calls.length).toBe(3);
});

test.skipIf(!hasDom)("a slow double click, at the person's own speed: the system's count swallows it past 400 ms, on that spot only", () => {
  const start = clock;
  clock += 10_000;
  setSystemTime(new Date(start));
  const { onOpen, onUnstar } = draw([row('s')], { pinned: ['s'] });
  placeStar('s');
  pressAt(star('s')!, 106, 106);
  expect(onUnstar.mock.calls.length).toBe(1);
  draw2(['s']);
  setSystemTime(new Date(start + 500));
  pressAt(rowEl('s'), 106, 106, 'mouse', 2);
  expect(onOpen).not.toHaveBeenCalled();
  pressAt(rowEl('s'), 106 + 25, 106, 'mouse', 2);
  expect(onOpen.mock.calls.length).toBe(1);
  pressAt(rowEl('s'), 106, 106, 'mouse', 1);
  expect(onOpen.mock.calls.length).toBe(2);
});
