import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { adoptSavedTextSize, resetInboxTextSizeForTests } = (hasDom ? await import('./textSize') : {}) as typeof import('./textSize');

function row(n: number, open: number, actions = 0): InboxListRow {
  return {
    thread_id: `msg_${n}`,
    project_id: 'prj_1',
    subject: `Thread ${n}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${n}`, name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open, picked: 0, stopped: false, holds_up: [], prompt: null, actions },
    waiting_on_person: open > 0,
    project: { id: 'prj_1', name: 'plannotator' },
    thread_name: null,
    section: 'waiting',
    unread: n % 2 === 0,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  } as InboxListRow;
}

function read(counts: [number, number][]): InboxListSection[] {
  const rows = counts.map(([open, actions], i) => row(i, open, actions));
  return [{ id: 'waiting', label: 'Waiting on you', threads: JSON.parse(JSON.stringify(rows)) }];
}

const CELL_RIGHT = 1000.37;
const GAP = 8;
const undrawn = new Set<string>();
let listUndrawn = false;

function partWidth(part: Element): number {
  const digits = (part.querySelector('[aria-hidden="true"]:not(svg)')?.textContent ?? '').length;
  const scale = (Number(document.documentElement.style.getPropertyValue('--inbox-text-size')) || 14) / 14;
  if (part.classList.contains('ib-b-act')) return (27.6 + 7.43 * digits) * scale;
  if (part.classList.contains('ib-qn')) return (19.2 + 7.43 * digits) * scale;
  return 0;
}

function rect(left: number, width: number): DOMRect {
  return { left, right: left + width, width, x: left, y: 0, top: 0, bottom: width ? 20 : 0, height: width ? 20 : 0, toJSON: () => ({}) } as DOMRect;
}

function box(el: Element): DOMRect {
  const cell = el.classList.contains('ib-cq') ? el : el.parentElement?.classList.contains('ib-cq') ? el.parentElement : null;
  const rowId = cell?.parentElement?.getAttribute('data-thread-id') ?? '';
  if (!cell || listUndrawn || undrawn.has(rowId)) return rect(0, 0);
  if (el === cell) return rect(CELL_RIGHT - 84, 84);
  const parts = [...cell.children];
  let right = CELL_RIGHT;
  for (let i = parts.length - 1; i >= 0; i--) {
    const width = partWidth(parts[i]!);
    if (parts[i] === el) return rect(right - width, width);
    right -= width + GAP;
  }
  return rect(0, 0);
}

function perRowWidth(list: HTMLElement, pinColumn: boolean): string {
  let widest = 0;
  if (pinColumn) {
    for (const cell of list.querySelectorAll<HTMLElement>('.ib-row > .ib-cq')) {
      const lefts = [...cell.children].map((part) => part.getBoundingClientRect()).filter((b) => b.width > 1).map((b) => b.left);
      if (lefts.length) widest = Math.max(widest, cell.getBoundingClientRect().right - Math.min(...lefts));
    }
  }
  return widest > 84 ? `${Math.ceil(widest)}px` : '';
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const reads = new Set<Element>();
let boxSpy: ReturnType<typeof spyOn> | null = null;
let rectsSpy: ReturnType<typeof spyOn> | null = null;

function setUp(): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  boxSpy = spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const cell = this.closest('.ib-cq');
    if (cell) reads.add(cell);
    return box(this);
  });
  rectsSpy = spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const shown = !listUndrawn;
    return (shown ? [rect(0, 1)] : []) as unknown as DOMRectList;
  });
}

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  boxSpy?.mockRestore();
  rectsSpy?.mockRestore();
  root = null;
  host = null;
  boxSpy = null;
  rectsSpy = null;
  reads.clear();
  undrawn.clear();
  listUndrawn = false;
  resetInboxTextSizeForTests();
});

function draw(sections: InboxListSection[], opts: { pinned?: string[]; narrow?: boolean; selected?: string | null } = {}): void {
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
            selectedThreadId={opts.selected ?? null}
            notice={null}
            onShowNew={() => {}}
            onOpen={() => {}}
            pinned={new Set(opts.pinned ?? ['msg_0'])}
          />
        </div>
      </SidebarProvider>,
    );
  });
}

const list = () => host!.querySelector<HTMLElement>('section.ib-listcol')!;
const column = () => list().style.getPropertyValue('--ib-cq-w');
function expected(pinColumn = true): string {
  const before = new Set(reads);
  const width = perRowWidth(list(), pinColumn);
  reads.clear();
  for (const cell of before) reads.add(cell);
  return width;
}

const DATA: [string, [number, number][]][] = [
  ['no counts', [[0, 0], [0, 0], [0, 0]]],
  ['one question', [[1, 0], [0, 0]]],
  ['nine questions', [[9, 0], [1, 0]]],
  ['ten questions', [[10, 0], [3, 0]]],
  ['one action item', [[1, 1], [2, 0]]],
  ['an action item and a question', [[2, 1], [1, 0]]],
  ['12 and 12', [[24, 12], [1, 0], [2, 1]]],
  ['99 and 99', [[198, 99], [5, 2]]],
  ['99+ and 99+', [[250, 120], [24, 12], [1, 0]]],
  ['99+ questions only', [[100, 0], [3, 3]]],
  ['99+ action items only', [[100, 100], [9, 9]]],
  ['many alike, one wide', [...Array.from({ length: 40 }, (): [number, number] => [2, 1]), [130, 101], ...Array.from({ length: 40 }, (): [number, number] => [3, 0])]],
  ['the same action items, more questions later', [[13, 12], [24, 12]]],
  ['the same questions, action items later', [[12, 0], [24, 12]]],
  ['the wide counts last', [[1, 0], [2, 1], [5, 0], [7, 2], [250, 120]]],
];

test.skipIf(!hasDom)('the column is as wide as the per-row measure gives, for every set of counts', () => {
  setUp();
  const seen = new Set<string>();
  for (const [name, counts] of DATA) {
    draw(read(counts));
    const want = expected();
    expect({ name, width: column() }).toEqual({ name, width: want });
    seen.add(want);
  }
  expect(seen.has('')).toBe(true);
  expect([...seen].filter(Boolean).length).toBeGreaterThan(2);
});

test.skipIf(!hasDom)('no pinned row: the column keeps its 84px and no counts are read', () => {
  setUp();
  draw(read([[250, 120], [24, 12]]));
  expect(column()).not.toBe('');
  reads.clear();
  draw(read([[250, 120], [24, 12]]), { pinned: [] });
  expect(column()).toBe('');
  expect(reads.size).toBe(0);
});

test.skipIf(!hasDom)('a row whose counts are not drawn: the next alike row is read; a list not drawn keeps 84px', () => {
  setUp();
  undrawn.add('msg_0');
  draw(read([[250, 120], [250, 120], [1, 0]]));
  expect(column()).toBe(expected());
  expect(column()).not.toBe('');
  act(() => root?.unmount());
  root = createRoot(host!);
  undrawn.clear();
  listUndrawn = true;
  draw(read([[250, 120], [1, 0]]));
  expect(column()).toBe('');
  listUndrawn = false;
  draw(read([[250, 120], [1, 0]]), { selected: 'msg_1' });
  expect(column()).toBe(expected());
  expect(column()).not.toBe('');
});

test.skipIf(!hasDom)('a long list reads one cell for each different counts, never one per row', () => {
  setUp();
  const counts = Array.from({ length: 300 }, (_, i): [number, number] => (i % 3 === 0 ? [2, 1] : i % 3 === 1 ? [12, 0] : [0, 0]));
  counts[150] = [130, 101];
  draw(read(counts));
  expect(list().querySelectorAll('.ib-row > .ib-cq').length).toBe(300);
  expect(column()).toBe(expected());
  expect(reads.size).toBe(3);
});

test.skipIf(!hasDom)('the same counts read again, a new selection and the open of a thread read no counts', () => {
  setUp();
  const counts = Array.from({ length: 60 }, (_, i): [number, number] => [(i % 4) * 7 + 1, i % 2]);
  draw(read(counts));
  const fitted = column();
  expect(fitted).toBe(expected());
  reads.clear();
  draw(read(counts));
  draw(read(counts), { selected: 'msg_3' });
  expect(reads.size).toBe(0);
  draw(read(counts), { narrow: true, selected: 'msg_3' });
  expect(reads.size).toBe(0);
  expect(column()).toBe('');
  draw(read(counts));
  expect(column()).toBe(fitted);
  expect(reads.size).toBeLessThanOrEqual(new Set(counts.map(([o, a]) => `${o}/${a}`)).size);
  reads.clear();
  const wider = counts.map((c, i): [number, number] => (i === 9 ? [250, 120] : c));
  draw(read(wider));
  expect(reads.size).toBeGreaterThan(0);
  expect(column()).toBe(expected());
  expect(column()).not.toBe(fitted);
});

test.skipIf(!hasDom)('a new text size fits the column again, to the new widest', () => {
  setUp();
  resetInboxTextSizeForTests();
  draw(read([[1, 0], [24, 12], [2, 1]]));
  const at14 = column();
  expect(at14).toBe(expected());
  expect(at14).not.toBe('');
  act(() => adoptSavedTextSize(15));
  expect(document.documentElement.style.getPropertyValue('--inbox-text-size')).toBe('15');
  expect(column()).toBe(expected());
  expect(column()).not.toBe(at14);
});

test.skipIf(!hasDom)('opening the Snoozed band on the widest counts widens the column', () => {
  setUp();
  const waiting = [row(0, 1), row(1, 2, 1)];
  const snoozed = { ...row(2, 250, 120), section: 'snoozed' as InboxListRow['section'] };
  const sections = (): InboxListSection[] =>
    JSON.parse(
      JSON.stringify([
        { id: 'waiting', label: 'Waiting on you', threads: waiting },
        { id: 'snoozed', label: 'Snoozed', threads: [snoozed] },
      ]),
    );
  draw(sections());
  expect(list().querySelector('[data-thread-id="msg_2"]')).toBeNull();
  expect(column()).toBe(expected());
  expect(column()).toBe('');
  act(() => list().querySelector<HTMLButtonElement>('[data-section-id="snoozed"] button.ib-band')!.click());
  expect(list().querySelector('.ib-row[data-thread-id="msg_2"]')).not.toBeNull();
  expect(column()).toBe(expected());
  expect(column()).not.toBe('');
});

test.skipIf(!hasDom)('the widest rows leaving narrow the column again, down to its 84px', () => {
  setUp();
  draw(read([[1, 0], [24, 12], [250, 120]]));
  const widest = column();
  expect(widest).toBe(expected());
  draw(read([[1, 0], [24, 12]]));
  expect(column()).toBe(expected());
  expect(column()).not.toBe(widest);
  expect(column()).not.toBe('');
  draw(read([[1, 0], [2, 1]]));
  expect(column()).toBe('');
  expect(column()).toBe(expected());
});
