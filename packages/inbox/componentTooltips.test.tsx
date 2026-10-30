/**
 * The Inbox's hover text is ui's Tooltip component, never the browser's
 * native `title` (the owner, 2026-10-17: "I want an actual component
 * tooltip"). A cut project label in a list row, a sidebar project and a
 * thread chip open the component tooltip quickly on hover; a label that fits
 * opens nothing; and none of them carries a native title. A chip cut by a
 * fraction of a pixel (its ellipsis painted while scrollWidth equals
 * clientWidth, seen on a two-line row at a device scale of 2) counts as cut.
 * happy-dom has no layout, so each test gives an element the sizes a real
 * browser measured.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { openTooltips, sized, tooltipOf, unhover } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { isTextCut } = (hasDom ? await import('./components/Tip') : {}) as typeof import('./components/Tip');

const LONG_PROJECT = 'northwind-industries-holdings-platform';

function row(id: string, project: string, thread_name: string | null): InboxListRow {
  return {
    thread_id: id,
    project_id: `prj_${id}`,
    subject: 'Reconcile the ledger after the nightly run',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: `prj_${id}`, name: project },
    thread_name,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  };
}

const LONG = row('msg_long', LONG_PROJECT, 'reconciliation-run');
const SHORT = row('msg_short', 'api', null);
const SECTIONS: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [LONG, SHORT] }];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SidebarProvider>{node}</SidebarProvider>));
  return host;
}

const list = (narrow: boolean) =>
  mount(<InboxList title="Inbox" path={null} sections={SECTIONS} filtered={false} narrow={narrow} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={false} />);

const label = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-thread-id="${id}"] .ib-p`)!;

/** Every element under `el` with a native title. */
const nativeTitles = (el: HTMLElement) => [...el.querySelectorAll('[title]')].map((node) => node.getAttribute('title'));

test.skipIf(!hasDom)('a cut project label in a list row opens the component tooltip; one that fits opens none; neither has a native title', async () => {
  for (const narrow of [false, true]) {
    const el = list(narrow);
    expect(nativeTitles(el)).toEqual([]);
    const fits = label(el, SHORT.thread_id);
    sized(fits, 30, 30);
    expect(await tooltipOf(fits)).toBeNull();
    unhover(fits);
    const cut = label(el, LONG.thread_id);
    sized(cut, 260, 120);
    expect(await tooltipOf(cut)).toBe(LONG_PROJECT);
    expect(cut.hasAttribute('title')).toBe(false);
    // The label is no focus stop of its own: the row's button is.
    expect(cut.tabIndex).toBe(-1);
    unhover(cut);
    act(() => root?.unmount());
    host?.remove();
  }
});

test.skipIf(!hasDom)('a chip cut by a fraction of a pixel counts as cut: two-line row, scrollWidth equal to clientWidth, the ellipsis painted', async () => {
  const el = list(true);
  const chip = el.querySelector<HTMLElement>(`[data-thread-id="${LONG.thread_id}"] .ib-keyt`)!;
  expect(chip.textContent).toBe('reconciliation-run');
  // What Chromium measured at a device scale of 2 beside an open thread: the box 97.546875 px, the text 97.61 px,
  // and both integer widths 98.
  sized(chip, 98, 98);
  const realRect = chip.getBoundingClientRect.bind(chip);
  chip.getBoundingClientRect = () => ({ ...realRect().toJSON(), width: 97.546875 }) as DOMRect;
  const realRange = document.createRange.bind(document);
  document.createRange = () => {
    const range = realRange();
    range.getBoundingClientRect = () => ({ width: 97.61, height: 14, x: 0, y: 0, top: 0, left: 0, right: 97.61, bottom: 14, toJSON: () => ({}) }) as DOMRect;
    return range;
  };
  try {
    expect(isTextCut(chip)).toBe(true);
    expect(await tooltipOf(chip)).toBe('reconciliation-run');
    expect(chip.hasAttribute('title')).toBe(false);
  } finally {
    document.createRange = realRange;
  }
  // A chip whose text fits its box exactly is not cut.
  const fitting = document.createElement('span');
  document.body.append(fitting);
  sized(fitting, 98, 98);
  expect(isTextCut(fitting)).toBe(false);
  fitting.remove();
});

const noop = () => {};
const folder = (name: string) => ({ id: `prj_${name}`, key: `${name}-abc123`, name, root: `/Users/ramos/src/${name}`, created_at: '2026-10-14T10:00:00.000Z', threads: 1, unread: 1, listed: 1, archived: 0 });

for (const withMenu of [true, false]) {
  test.skipIf(!hasDom)(`a sidebar project shows its whole name and its folder in the component tooltip${withMenu ? '' : ' (no project menu)'}, with no native title`, async () => {
    const el = mount(
      <Sidebar
        page="inbox"
        projectId={null}
        inboxCount={1}
        projects={[folder(LONG_PROJECT)]}
        projectCounts={new Map([[`prj_${LONG_PROJECT}`, 1]])}
        update={null}
        restarting={false}
        updated={null}
        onInbox={noop}
        onProject={noop}
        onSettings={noop}
        onUpdate={noop}
        onWhatsNew={noop}
        onProjectAction={withMenu ? noop : undefined}
      />,
    );
    expect(nativeTitles(el)).toEqual([]);
    const project = el.querySelector<HTMLElement>('.ib-proj')!;
    expect(project.querySelector('.ib-name')!.textContent).toBe(LONG_PROJECT);
    // The folder is never on the row, so the tooltip opens whether or not the name is cut.
    const tip = await tooltipOf(project);
    expect(tip).toContain(LONG_PROJECT);
    expect(tip).toContain(`/Users/ramos/src/${LONG_PROJECT}`);
    expect(openTooltips().length).toBe(1);
    // The row's accessible name is its own text, never the tooltip; a screen reader hears the folder as its description.
    expect(project.textContent).toBe(`${LONG_PROJECT}1`);
    const described = document.getElementById(project.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe(`/Users/ramos/src/${LONG_PROJECT}`);
  });
}
