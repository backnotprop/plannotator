/**
 * The held bar as the list draws it (HeldNoticeLine.tsx), with the words the owner approved on 2026-11-18
 * (newsWords.ts):
 *
 *  - The words are ONE line: the lead ("Claude Code replied in") and Show never shrink, the quoted thread name is
 *    the part cut with "…", and "from …" is left off whole (it wraps onto a line the box clips); while anything is
 *    cut, the whole sentence is the tooltip.
 *  - In a project or filter view, news elsewhere is a second line whose Show all is its own press.
 *  - The bar's arrival while the list is scrolled down moves no row: the rows on screen are where they were
 *    (holdView.ts, `HoldViewOnBar`); at the very top it takes its place above the rows.
 *
 * The page's real `.ib-notice` rules are loaded. happy-dom has no layout: a test gives the parts the sizes and
 * places that make them cut, and the list's rows the places a browser would give them.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { NewsLine } from './newsWords';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { hereLine, elsewhereLine } = await import('./newsWords');

let root: Root | null = null;
let host: HTMLElement | null = null;
let sheet: HTMLStyleElement | null = null;
const restore: (() => void)[] = [];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  sheet?.remove();
  for (const undo of restore.splice(0)) undo();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  root = null;
  host = null;
  sheet = null;
});

function noticeRules(): string {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  return css
    .split('\n')
    .filter((line) => /^\.ib-notice/.test(line))
    .join('\n');
}

const REPLY = hereLine([{ id: 'a', kind: 'reply', agent: 'Claude Code', title: 'Move the payment provider webhooks to the new queue', projectId: 'p', project: 'storefront' }])!;
const MIXED = hereLine([
  { id: 'a', kind: 'thread', agent: 'Codex', title: 'a', projectId: 'p', project: 'storefront' },
  { id: 'b', kind: 'question', agent: 'Claude Code', title: 'b', projectId: 'p', project: 'storefront' },
  { id: 'c', kind: 'reply', agent: 'Claude Code', title: 'c', projectId: 'p', project: 'storefront' },
])!;
const AWAY = elsewhereLine([
  { id: 'x', kind: 'reply', agent: 'Codex', title: 'x', projectId: 'b', project: 'billing-svc' },
  { id: 'y', kind: 'reply', agent: 'Pi', title: 'y', projectId: 'd', project: 'docs-site' },
])!;

interface Draw {
  here?: NewsLine | null;
  elsewhere?: NewsLine | null;
  sections?: InboxListSection[];
  onShowNew?: () => void;
  onShowAll?: () => void;
}

function draw({ here = null, elsewhere = null, sections = [], onShowNew = () => {}, onShowAll }: Draw) {
  const notice = here || elsewhere ? { count: here ? 1 : 0, project: null, here, elsewhere } : null;
  root!.render(
    <SidebarProvider>
      <div className="pn-inbox">
        <InboxList title="storefront" path={null} sections={sections} filtered narrow selectedThreadId={null} notice={notice} onShowNew={onShowNew} onShowAll={onShowAll} onOpen={() => {}} phone={false} rememberLook={false} />
      </div>
    </SidebarProvider>,
  );
}

function render(props: Draw): HTMLElement {
  sheet = document.createElement('style');
  sheet.textContent = noticeRules();
  document.head.append(sheet);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => draw(props));
  return host;
}

function sized(node: HTMLElement, scroll: number, client: number) {
  Object.defineProperty(node, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => client });
}

function hover(target: HTMLElement) {
  act(() => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: type !== 'pointerenter' && type !== 'mouseenter', cancelable: true, pointerType: 'mouse', clientX: 10, clientY: 10 } as PointerEventInit));
    }
  });
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const tooltipWith = (el: HTMLElement, text: string) => [...document.body.querySelectorAll('*')].some((n) => !el.contains(n) && n.children.length === 0 && n.textContent === text);

test.skipIf(!hasDom)('one arrival: the whole sentence is the text; only the quoted thread name shrinks; the lead and Show never do', () => {
  const el = render({ here: REPLY });
  const button = el.querySelector<HTMLElement>('[data-inbox-notice]')!;
  const lead = button.querySelector<HTMLElement>('.ib-notice-n')!;
  const name = button.querySelector<HTMLElement>('.ib-notice-proj')!;
  expect(button.textContent).toBe('Claude Code replied in “Move the payment provider webhooks to the new queue”Show');
  expect(lead.textContent).toBe('Claude Code replied in');
  expect(name.textContent).toBe('“Move the payment provider webhooks to the new queue”');
  expect(getComputedStyle(button).whiteSpace).toBe('nowrap');
  expect(getComputedStyle(lead).flexShrink).toBe('0');
  expect(getComputedStyle(button.querySelector('b')!).flexShrink).toBe('0');
  expect(getComputedStyle(name).textOverflow).toBe('ellipsis');
  expect(getComputedStyle(name).minWidth).toBe('0');
  // No "from …": the words never wrap, so a long name shrinks rather than going to a clipped line.
  expect(button.querySelector('.ib-notice-text')!.hasAttribute('data-drop')).toBe(false);
});

test.skipIf(!hasDom)('several: "from …" is a part of its own that wraps away whole onto the clipped line, never cut inside a name', () => {
  const el = render({ here: MIXED });
  const button = el.querySelector<HTMLElement>('[data-inbox-notice]')!;
  const text = button.querySelector<HTMLElement>('.ib-notice-text')!;
  const from = button.querySelector<HTMLElement>('.ib-notice-from')!;
  expect(button.textContent).toBe('1 new thread, 1 question, 1 reply from Codex and Claude CodeShow');
  expect(from.textContent).toBe('from Codex and Claude Code');
  expect(text.hasAttribute('data-drop')).toBe(true);
  expect(getComputedStyle(text).flexWrap).toBe('wrap');
  expect(getComputedStyle(text).overflow).toBe('hidden');
  expect(getComputedStyle(from).whiteSpace).toBe('nowrap');
});

test.skipIf(!hasDom)('while anything is cut the whole sentence is the tooltip: a cut name, or "from …" left off; whole words show none', async () => {
  const el = render({ here: REPLY });
  const button = el.querySelector<HTMLElement>('[data-inbox-notice]')!;
  sized(button.querySelector<HTMLElement>('.ib-notice-proj')!, 420, 120);
  hover(button);
  await wait(400);
  expect(tooltipWith(el, REPLY.full)).toBe(true);
  act(() => root?.unmount());
  host?.remove();
  sheet?.remove();

  const mixed = render({ here: MIXED });
  const line = mixed.querySelector<HTMLElement>('[data-inbox-notice]')!;
  // "from …" went to the second, clipped line.
  Object.defineProperty(line.querySelector('.ib-notice-from')!, 'offsetTop', { configurable: true, get: () => 20 });
  hover(line);
  await wait(400);
  expect(tooltipWith(mixed, MIXED.full)).toBe(true);
  act(() => root?.unmount());
  host?.remove();
  sheet?.remove();

  const fits = render({ here: MIXED });
  hover(fits.querySelector<HTMLElement>('[data-inbox-notice]')!);
  await wait(400);
  expect(tooltipWith(fits, MIXED.full)).toBe(false);
});

test.skipIf(!hasDom)('news here and elsewhere: two lines, here first; Show takes this list, Show all its own press', () => {
  const pressed: string[] = [];
  const el = render({ here: REPLY, elsewhere: AWAY, onShowNew: () => pressed.push('show'), onShowAll: () => pressed.push('all') });
  const bar = el.querySelector<HTMLElement>('[data-held-bar]')!;
  expect(bar.getAttribute('data-lines')).toBe('2');
  const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button.ib-notice')];
  expect(buttons.map((b) => b.textContent)).toEqual([`${REPLY.full}Show`, '2 new in other projectsShow all']);
  act(() => buttons[1]!.click());
  act(() => buttons[0]!.click());
  expect(pressed).toEqual(['all', 'show']);
});

test.skipIf(!hasDom)('the live region says the whole sentences once they arrive, never cut', () => {
  const el = render({ onShowAll: () => {} });
  act(() => draw({ here: REPLY, elsewhere: AWAY, onShowAll: () => {} }));
  expect(el.querySelector('[data-held-said]')!.textContent).toBe(`${REPLY.full}. 2 new in other projects`);
});

test.skipIf(!hasDom)('news elsewhere only: one line, Show all; a list that cannot leave its view draws none', () => {
  const el = render({ elsewhere: AWAY, onShowAll: () => {} });
  expect(el.querySelector('[data-inbox-notice]')).toBeNull();
  expect(el.querySelector('[data-inbox-notice-elsewhere]')?.textContent).toBe('2 new in other projectsShow all');
  act(() => draw({ elsewhere: AWAY }));
  expect(el.querySelector('[data-held-bar]')).toBeNull();
});

const LONG_AGO = '2026-10-10T10:00:00.000Z';
function row(id: string): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: null },
    created_at: LONG_AGO,
    last_at: LONG_AGO,
    last_agent_at: LONG_AGO,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: false,
    project: { id: 'prj_1', name: 'alpha' },
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
const ROWS: InboxListSection[] = [{ id: 'new', label: 'New since you looked', threads: Array.from({ length: 12 }, (_, n) => row(`t${n}`)) }];

/**
 * A browser's layout for the list, as the bar's arrival changes it: each row 80 px tall in the flow, the bar's 50 px
 * above them while it is drawn (96 px with two lines), the scroll box 400 px tall at the window's top. No scroll anchoring (Safari, and a
 * phone's list, which turns it off): the rows move by the bar's height unless the list makes up for it.
 */
function layOut(body: HTMLElement): { scrollTop: () => number } {
  let top = 0;
  const own = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => void (top = v) });
  body.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 380, width: 380, height: 400, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const rect = Element.prototype.getBoundingClientRect;
  const rects = Element.prototype.getClientRects;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const id = this.getAttribute('data-thread-id');
    if (id === null || !body.contains(this)) return rect.call(this);
    const bar = body.querySelector('[data-held-bar]');
    const y = (bar ? (bar.getAttribute('data-lines') === '2' ? 96 : 50) : 0) + Number(id.slice(1)) * 80 - top;
    return { top: y, bottom: y + 80, left: 0, right: 380, width: 380, height: 80, x: 0, y, toJSON() {} } as DOMRect;
  };
  Element.prototype.getClientRects = function (this: Element) {
    return (this.hasAttribute('data-thread-id') ? [this.getBoundingClientRect()] : rects.call(this)) as unknown as DOMRectList;
  };
  restore.push(() => {
    Element.prototype.getBoundingClientRect = rect;
    Element.prototype.getClientRects = rects;
    if (own) Object.defineProperty(body, 'scrollTop', own);
  });
  return { scrollTop: () => top };
}

const placeOf = (el: HTMLElement, id: string) => el.querySelector(`[data-thread-id="${id}"]`)!.getBoundingClientRect().top;

test.skipIf(!hasDom)('the bar arriving while the list is scrolled down moves no row; a second line neither; at the top it takes its place above the rows', () => {
  const el = render({ sections: ROWS });
  const body = el.querySelector<HTMLElement>('.ib-lbody')!;
  const box = layOut(body);
  body.scrollTop = 300;
  const before = placeOf(el, 't5');
  act(() => draw({ sections: ROWS, here: REPLY, onShowAll: () => {} }));
  expect(el.querySelector('[data-held-bar]')).not.toBeNull();
  expect(placeOf(el, 't5')).toBe(before);
  expect(box.scrollTop()).toBe(350);
  // A second line (news elsewhere) comes too: still nothing moves.
  act(() => draw({ sections: ROWS, here: REPLY, elsewhere: AWAY, onShowAll: () => {} }));
  expect(placeOf(el, 't5')).toBe(before);
  expect(box.scrollTop()).toBe(396);
  // The bar goes without Show (its news went): nothing moves either.
  act(() => draw({ sections: ROWS }));
  expect(placeOf(el, 't5')).toBe(before);

  // At the very top the bar is drawn above the rows, covering none: the rows move down by its height.
  body.scrollTop = 0;
  act(() => draw({ sections: ROWS, here: REPLY }));
  expect(box.scrollTop()).toBe(0);
  expect(placeOf(el, 't0')).toBe(50);
});
