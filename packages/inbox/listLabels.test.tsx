/**
 * A row's thread label and subject (design record "inbox-polish", items 2
 * and 3): the label is left out when the subject already starts with it, and
 * a label or subject cut with "…" shows ui's tooltip with the whole text on
 * hover, only while it is cut (no native title as well). happy-dom has no
 * layout, so a test gives an element the widths that make it cut. The real
 * browser shots are in the PR.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList, chipName } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };

function row(id: string, subject: string, thread_name: string | null): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject,
    author: AGENT,
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'plannotator' },
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

const REPEAT = row('msg_repeat', 'Inbox: skills in messages and the picker', 'Inbox: skills  in messages');
const OTHER = row('msg_other', 'Inbox: a menu on each sidebar project with Mark all as read', 'Inbox: project menu');
const PREFIX = row('msg_prefix', 'Searchable archive', 'search');
const VERSION = row('msg_version', 'v2.1 release', 'v2');
const HYPHEN = row('msg_hyphen', 'auth-service down', 'auth');
const COLON = row('msg_colon', 'Search: ranking for archived threads', 'search');
const DASH = row('msg_dash', 'auth - token refresh fails', 'auth');
const SECTIONS: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [REPEAT, OTHER, PREFIX, VERSION, HYPHEN, COLON, DASH] }];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  root = null;
  host = null;
});

function render(phone: boolean): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} sections={SECTIONS} filtered={false} narrow selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={phone} />
        </div>
      </SidebarProvider>,
    );
  });
  return host;
}

const rowEl = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** The pointer comes to rest on `target`, the way a mouse does. */
function hover(target: HTMLElement) {
  act(() => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: type !== 'pointerenter' && type !== 'mouseenter', cancelable: true, pointerType: 'mouse', clientX: 10, clientY: 10 } as PointerEventInit));
    }
  });
}

/** A popup outside the row holding `text`: the tooltip, portaled to the body. */
const tooltipWith = (el: HTMLElement, text: string) => [...document.body.querySelectorAll('*')].some((n) => !el.contains(n) && n.children.length === 0 && n.textContent === text);

function sized(node: HTMLElement, scroll: number, client: number) {
  Object.defineProperty(node, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => client });
}

test.skipIf(!hasDom)('the thread label is left out when the subject already starts with it, on wide and phone rows', () => {
  expect(chipName(REPEAT)).toBeNull();
  expect(chipName(OTHER)).toBe('Inbox: project menu');
  // Only where the subject's words end: a space, or ":", "-" or a dash and a space.
  expect(chipName(PREFIX)).toBe('search');
  expect(chipName(VERSION)).toBe('v2');
  expect(chipName(HYPHEN)).toBe('auth');
  expect(chipName(COLON)).toBeNull();
  expect(chipName(DASH)).toBeNull();
  expect(chipName(row('msg_same', 'Release notes', 'release notes'))).toBeNull();
  for (const phone of [false, true]) {
    const el = render(phone);
    expect(rowEl(el, REPEAT.thread_id).querySelector('.ib-keyt')).toBeNull();
    expect(rowEl(el, OTHER.thread_id).querySelector('.ib-keyt')!.textContent).toBe('Inbox: project menu');
    expect(rowEl(el, PREFIX.thread_id).querySelector('.ib-keyt')!.textContent).toBe('search');
    act(() => root?.unmount());
    host?.remove();
  }
});

test.skipIf(!hasDom)('a cut subject or label shows the whole text in a tooltip on hover; one that fits shows none, and neither has a native title', async () => {
  const el = render(false);
  const subject = rowEl(el, OTHER.thread_id).querySelector<HTMLElement>('.ib-st')!;
  const chip = rowEl(el, OTHER.thread_id).querySelector<HTMLElement>('.ib-keyt')!;
  const fits = rowEl(el, PREFIX.thread_id).querySelector<HTMLElement>('.ib-st')!;
  for (const node of [subject, chip, fits]) {
    expect(node.hasAttribute('title')).toBe(false);
    expect(node.hasAttribute('data-clip')).toBe(false);
    // Never a focus stop of its own: the row's button is.
    expect(node.tabIndex).toBe(-1);
  }
  sized(subject, 400, 180);
  sized(chip, 160, 120);
  sized(fits, 120, 120);

  hover(fits);
  await wait(400);
  expect(tooltipWith(el, PREFIX.subject!)).toBe(false);

  hover(subject);
  await wait(400);
  expect(tooltipWith(el, OTHER.subject!)).toBe(true);
  expect(subject.hasAttribute('title')).toBe(false);

  hover(chip);
  await wait(400);
  expect(tooltipWith(el, 'Inbox: project menu')).toBe(true);
});
