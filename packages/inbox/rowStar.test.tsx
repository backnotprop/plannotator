/**
 * The star a list row shows (the owner, 2026-11-05): a press on it unstars, everything else on the row opens. The star
 * sits inside the row's own button, so one wrong branch in the row's click either opens a thread instead of unstarring it
 * or takes a row's Enter away. Starring stays in the menus: an unstarred row has no star at all. The whole window, with
 * the server, is pinnedThreads.test.tsx.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, mock, test } from 'bun:test';
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

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

/** The list, with these rows waiting and these starred. Returns what the row's presses called. */
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
  return { onOpen, onUnstar };
}

const rowEl = (id: string) => host!.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
const star = (id: string) => rowEl(id).querySelector<HTMLElement>('[data-pin-mark]');
const pointerClick = (el: Element) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
const ids = (fn: ReturnType<typeof mock>) => fn.mock.calls.map(([r]) => (r as InboxListRow).thread_id);

for (const [shape, opts] of [['wide', {}], ['three-line', { narrow: true }], ['phone', { phone: true }]] as const) {
  test.skipIf(!hasDom)(`${shape} row: its star unstars; the rest of the row and its Enter open; an unstarred row has no star`, () => {
    const { onOpen, onUnstar } = draw([row('plain'), row('starred')], { ...opts, pinned: ['starred'] });
    expect(star('plain')).toBeNull();
    expect(rowEl('plain').querySelector('[data-star-press]')).toBeNull();
    pointerClick(star('starred')!);
    expect(ids(onUnstar)).toEqual(['starred']);
    expect(onOpen).not.toHaveBeenCalled();
    // Enter or Space on the row: a click with no pointer, whose target is the row.
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
  // The merged list stamps this machine's id on its own rows too, so "has a machine" is not "another machine's".
  const { onOpen, onUnstar } = draw([row('mine', SELF), row('theirs', OTHER)], { machines: MACHINES, pinned: ['mine', 'theirs'] });
  pointerClick(star('mine')!);
  expect(ids(onUnstar)).toEqual(['mine']);
  expect(star('theirs')!.hasAttribute('data-star-press')).toBe(false);
  pointerClick(star('theirs')!);
  expect(ids(onUnstar)).toEqual(['mine']);
  expect(ids(onOpen)).toEqual(['theirs']);
});
