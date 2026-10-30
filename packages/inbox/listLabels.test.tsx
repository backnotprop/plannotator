/**
 * A row's title and preview (approval "list-rows-mail-icons", 2026-10-30): a
 * named thread's name is its title and its subject the grey preview, even when
 * the subject starts with the name (the approved "Okta SSO" row); an unnamed
 * thread's subject is its title, with no preview. A preview cut with "…"
 * shows ui's tooltip with the whole text on hover, only while it is cut (no
 * native title as well; design record "inbox-polish", item 3). happy-dom has
 * no layout, so a test gives an element the widths that make it cut.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
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

function render(phone: boolean, threads: InboxListRow[] = SECTIONS[0]!.threads as InboxListRow[]): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} sections={[{ id: 'waiting', label: 'Waiting on you', threads }]} filtered={false} narrow selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={phone} />
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

test.skipIf(!hasDom)('the name is the title and the subject the preview; an unnamed thread has its subject as the title and no preview', () => {
  const UNNAMED = row('msg_unnamed', 'Refund events: trust the webhook?', null);
  const SAME = row('msg_same', 'Release notes', 'Release notes');
  const lines = (r: HTMLElement) => ({
    title: r.querySelector('.ib-title, .ib-m2')!.textContent,
    preview: r.querySelector('.ib-pv')?.textContent ?? null,
  });
  for (const phone of [false, true]) {
    const el = render(phone, [OTHER, PREFIX, COLON, UNNAMED, SAME]);
    expect(lines(rowEl(el, OTHER.thread_id))).toEqual({ title: 'Inbox: project menu', preview: OTHER.subject });
    // The subject starts with the name: both still show, as the approved pictures draw "Okta SSO".
    expect(lines(rowEl(el, COLON.thread_id))).toEqual({ title: 'search', preview: COLON.subject });
    expect(lines(rowEl(el, UNNAMED.thread_id))).toEqual({ title: UNNAMED.subject!, preview: null });
    // A subject that only repeats the name is not drawn twice.
    expect(lines(rowEl(el, SAME.thread_id))).toEqual({ title: 'Release notes', preview: null });
    // No row draws the old thread pill.
    expect(el.querySelector('.ib-lbody .ib-key')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
  }
});

test.skipIf(!hasDom)('a cut preview shows the whole text in a tooltip on hover; one that fits shows none; the title is never a cut line', async () => {
  const el = render(false);
  const preview = rowEl(el, OTHER.thread_id).querySelector<HTMLElement>('.ib-pv')!;
  const fits = rowEl(el, PREFIX.thread_id).querySelector<HTMLElement>('.ib-pv')!;
  for (const node of [preview, fits]) {
    expect(node.hasAttribute('title')).toBe(false);
    expect(node.hasAttribute('data-clip')).toBe(false);
    // Never a focus stop of its own: the row's button is.
    expect(node.tabIndex).toBe(-1);
  }
  sized(preview, 400, 180);
  sized(fits, 120, 120);

  hover(fits);
  await wait(400);
  expect(tooltipWith(el, PREFIX.subject!)).toBe(false);

  hover(preview);
  await wait(400);
  expect(tooltipWith(el, OTHER.subject!)).toBe(true);
  expect(preview.hasAttribute('title')).toBe(false);

  // Beside a thread the title wraps, whole: it is plain text, never a cut line with a tooltip.
  const title = rowEl(el, OTHER.thread_id).querySelector<HTMLElement>('.ib-l2 > .ib-title')!;
  expect(title.textContent).toBe('Inbox: project menu');
  sized(title, 400, 180);
  hover(title);
  await wait(400);
  expect([...document.body.querySelectorAll('[data-pn-tooltip]')].some((n) => n.textContent === 'Inbox: project menu')).toBe(false);
});
