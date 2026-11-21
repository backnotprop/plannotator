/**
 * The list's ↑ ↓ and a message's attachment arrows check where a key came from before they look over the whole page
 * for an open dialog (`modalOpen`): that look visits every element, and on a long thread it ran several times for every
 * key typed in the reply box, which queued held Backspace up for seconds. What would regress: a key typed in a text
 * field running the page-wide look again, or the order change letting a key through that a dialog held back, or
 * holding one back that moved focus before.
 * DOM test: DOM_TESTS=1.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { useTileArrows } = (hasDom ? await import('./useTileArrows') : {}) as typeof import('./useTileArrows');

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: (() => void)[] = [];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const restore of restores.splice(0).reverse()) restore();
  document.querySelectorAll('dialog').forEach((dialog) => dialog.remove());
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

/** Counts the page-wide dialog look (`modalOpen`'s query) from here on. */
function countModalLooks(): { readonly count: number } {
  const seen = { count: 0 };
  const own = document.querySelectorAll;
  document.querySelectorAll = function (this: Document, selectors: string) {
    if (selectors.includes('dialog[open]')) seen.count++;
    return own.call(this, selectors);
  } as typeof own;
  restores.push(() => {
    delete (document as { querySelectorAll?: unknown }).querySelectorAll;
  });
  return seen;
}

const press = (el: Element, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
};

const openDialog = () => {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  document.body.append(dialog);
};

function listRow(id: string): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_a',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-11-07T10:00:00.000Z',
    last_at: '2026-11-07T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_a', name: 'api' },
    thread_name: null,
    section: 'new',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  } as InboxListRow;
}

function mountList(): HTMLElement {
  const sections: InboxListSection[] = [{ id: 'new', label: 'New', threads: [listRow('thr_a'), listRow('thr_b'), listRow('thr_c')] }];
  return mount(
    <SidebarProvider>
      <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={false} onRowAction={() => {}} />
      <textarea data-reply="" />
    </SidebarProvider>,
  );
}

test.skipIf(!hasDom)('the list: ↓ from a row moves to the next row, not under a dialog; keys typed in a field never look for a dialog', () => {
  const el = mountList();
  const row = (id: string) => el.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
  const looks = countModalLooks();
  act(() => row('thr_a').focus());
  press(row('thr_a'), 'ArrowDown');
  expect(document.activeElement).toBe(row('thr_b'));
  // A key the list takes still asks whether a dialog is open.
  expect(looks.count).toBeGreaterThan(0);
  press(row('thr_b'), 'ArrowUp');
  expect(document.activeElement).toBe(row('thr_a'));
  // Typing in the reply box (outside the list): the arrows and Backspace are the field's, and no page-wide look runs.
  const field = el.querySelector<HTMLTextAreaElement>('[data-reply]')!;
  act(() => field.focus());
  const before = looks.count;
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Backspace', 'x']) {
    const event = press(field, key);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(document.activeElement).toBe(field);
  expect(looks.count - before).toBe(0);
  // Under a dialog, ↓ on a row stays put, as before.
  openDialog();
  act(() => row('thr_a').focus());
  const held = press(row('thr_a'), 'ArrowDown');
  expect(document.activeElement).toBe(row('thr_a'));
  expect(held.defaultPrevented).toBe(false);
});

function Tiles() {
  const section = useRef<HTMLElement>(null);
  useTileArrows(section, false);
  return (
    <section ref={section}>
      <div className="ib-tiles">
        {['a', 'b', 'c'].map((id) => (
          <button key={id} type="button" data-attachment-id={id}>
            {id}
          </button>
        ))}
      </div>
      <textarea data-reply="" />
    </section>
  );
}

test.skipIf(!hasDom)('attachment tiles: → moves to the next tile, not under a dialog; keys typed in the reply box never look for a dialog', () => {
  const el = mount(<Tiles />);
  const tiles = [...el.querySelectorAll<HTMLElement>('[data-attachment-id]')];
  // One row of tiles (happy-dom draws nothing).
  tiles.forEach((tile, i) => {
    const box = { left: i * 110, top: 0, width: 100, height: 80 };
    const rect = { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box };
    Object.defineProperty(tile, 'getBoundingClientRect', { configurable: true, value: () => rect });
  });
  const looks = countModalLooks();
  act(() => tiles[0]!.focus());
  press(tiles[0]!, 'ArrowRight');
  expect(document.activeElement).toBe(tiles[1]!);
  expect(looks.count).toBeGreaterThan(0);
  const field = el.querySelector<HTMLTextAreaElement>('[data-reply]')!;
  act(() => field.focus());
  const before = looks.count;
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    const event = press(field, key);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(document.activeElement).toBe(field);
  expect(looks.count - before).toBe(0);
  openDialog();
  act(() => tiles[1]!.focus());
  press(tiles[1]!, 'ArrowRight');
  expect(document.activeElement).toBe(tiles[1]!);
});
