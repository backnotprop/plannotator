/**
 * The open thread's header (approval "inbox-thread-header", 2026-11-02). Off a
 * phone the bar reads [full screen] | read button, Snooze clock, subject …
 * Artifacts, Expand, ⋯ | ×; the read button and the clock are icons whose
 * words are in their tooltips (E with Mark read). On a phone the bar is
 * ‹ Inbox, subject, Artifacts, Expand, ⋯, and the ⋯ sheet leads with every
 * read action the desktop has in that state, then Snooze (which swaps the
 * sheet for "‹ Snooze until"), a divider, and the rest. The title has room on
 * a phone at 320 and 390 px. The title is the thread's name by the list's
 * rule, else its subject once the body's heading scrolls away (as on main;
 * the owner, 2026-11-02), with the whole subject in its tooltip and no name
 * pill on the meta line; the body's heading stays the subject.
 *
 * The failures this catches: the read button or the clock drifting to the
 * right (or after the subject), either one showing in a phone's bar, the
 * phone's ⋯ losing a read action the desktop has (or their order), the clock
 * not opening the times (or Pick a time not snoozing), a Snooze or an Escape
 * from the clock disturbing the read button or the thread, a tooltip losing
 * its words or the E, the phone's title vanishing for want of room, and the
 * same words shown twice.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxListRow, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { inboxSnoozeChoices } from '@plannotator/core/inbox-snooze';
import { fitPhoneHead, SUBJECT_FLOOR } from './headFit';
import { PHONE_QUERY } from './phone';
import { sized, tooltipOf, unhover } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'list-look-abcdef', name: 'list-look', root: '/work/list-look', created_at: '2026-10-20T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const ROOT = 'msg_H1';
const SUBJECT = 'Customize how list rows look: density, the agent tiles, the preview line';

function message(id: string, minute: number): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: ROOT,
    reply_to: id === ROOT ? null : ROOT,
    author: AGENT,
    subject: id === ROOT ? SUBJECT : null,
    subject_question: null,
    body: `Update ${minute}.`,
    created_at: `2026-10-20T18:${String(minute).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
  };
}

const THREAD: InboxThread = {
  thread_id: ROOT,
  project: PROJECT,
  subject: SUBJECT,
  thread_name: 'customize row look',
  resolved_at: null,
  messages: [message(ROOT, 10), message('msg_H2', 11), message('msg_H3', 12)],
};

/** Six files on the first message: the Artifacts button with its count. */
const ATTACHMENTS = Array.from({ length: 6 }, (_, i) => ({
  id: `att_${i}`,
  message_id: ROOT,
  path: `/work/list-look/notes/part-${i}.md`,
  named_path: null,
  kind: 'markdown',
  sent_sha256: '0'.repeat(64),
  size: 10,
  sent_at: '2026-10-20T18:10:00.000Z',
  sent_mtime: '2026-10-20T18:10:00.000Z',
  current: null,
  changed_since_sent: false,
  unavailable: null,
}));

/** The list row the header reads (markRead.ts): only the fields its rules look at. */
function row(over: Partial<InboxListRow>): InboxListRow {
  return { section: 'quiet', unseen: 0, answered_not_sent: false, resolved_at: null, read_at: null, agent_after_archive: false, unread: false, sent: null, snoozed: null, ...over } as unknown as InboxListRow;
}
/** Read by opening it, an agent having written last: the header offers Mark unread. */
const OPENED = row({});
/** A question waits on the person: Mark read. */
const WAITING = row({ section: 'waiting', unread: true, waiting_since: '2026-10-20T18:12:00.000Z' });
/** Marked read: the pressed Read. */
const MARKED = row({ read_at: '2026-10-20T18:20:00.000Z' });

let root: Root | null = null;
let host: HTMLElement | null = null;
const restore: (() => void)[] = [];
const snoozed: string[] = [];
const calls: string[] = [];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  snoozed.length = 0;
  calls.length = 0;
  for (const undo of restore.splice(0).reverse()) undo();
});

/** A phone: the window's phone query matches (shortcut hints and the like read it), for this test only. */
function phoneQuery() {
  const saved = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === PHONE_QUERY,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  restore.push(() => {
    window.matchMedia = saved;
  });
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(state: InboxListRow, phone = false, thread: InboxThread = THREAD, drawn: 'quiet' | 'new' = 'quiet') {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/attachments')) return Response.json({ serverSession: 's', attachments: ATTACHMENTS, annotations: [] });
    return Response.json({});
  }) as typeof fetch;
  restore.push(() => {
    globalThis.fetch = savedFetch;
  });
  if (phone) phoneQuery();
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <ThreadPane
        thread={thread}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => calls.push('close')}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        row={state}
        drawn={drawn}
        onMarkRead={(read) => calls.push(read ? 'mark read' : 'move back')}
        onMarkUnread={() => calls.push('mark unread')}
        onSnooze={(until) => snoozed.push(until)}
        onUnsnooze={() => calls.push('unsnooze')}
        onPin={async () => {}}
        onArtifacts={() => {}}
        onFull={() => {}}
        phone={phone}
      />,
    );
  });
  await settle();
  await until(() => !!host!.querySelector('[data-artifacts-button]'), 'the Artifacts button');
}

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function press(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
  });
}

const head = () => host!.querySelector<HTMLElement>('.ib-phead')!;

/** The bar's controls and its subject, left to right (DOM order is the drawn order: one flex row). */
function bar(): string[] {
  const names: string[] = [];
  for (const el of head().querySelectorAll<HTMLElement>('button, [data-header-subject], .ib-vsep')) {
    if (el.classList.contains('ib-vsep')) names.push('|');
    else if (el.hasAttribute('data-header-subject')) names.push('subject');
    else if (el.hasAttribute('data-phone-back')) names.push('‹ Inbox');
    else if (el.hasAttribute('data-artifacts-button')) names.push('Artifacts');
    else if (el.hasAttribute('data-expand-all')) names.push('Expand');
    else names.push(el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '?');
  }
  return names;
}

/** An open menu's items and dividers, top to bottom ("—" for a divider). */
function menuItems(menu: Element): string[] {
  return [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) => (el.getAttribute('role') === 'separator' ? '—' : el.textContent?.trim() ?? ''));
}

const threadMenu = () => document.querySelector<HTMLElement>('[data-thread-menu]');

async function openMore() {
  await press(head().querySelector('[data-thread-more]')!);
  await until(() => !!threadMenu(), 'the ⋯ menu');
  return threadMenu()!;
}

test.skipIf(!hasDom)('desktop: the read button and the Snooze clock lead, before the subject; Artifacts, Expand, ⋯ and × stay at the right', async () => {
  await render(OPENED);
  expect(bar()).toEqual(['Hide the sidebar and the list', '|', 'Mark unread', 'Snooze', 'subject', 'Artifacts', 'Expand', 'More', '|', 'Close the thread']);
  expect(head().querySelector('[data-header-subject]')!.textContent).toBe('customize row look');
  // The read button is an icon: its words are its name, never drawn text.
  for (const button of head().querySelectorAll('[data-mark-unread], [data-thread-snooze]')) expect(button.textContent).toBe('');
  // The other states take the same slot.
  act(() => root!.unmount());
  host!.remove();
  await render(WAITING);
  expect(bar().slice(2, 5)).toEqual(['Mark read', 'Snooze', 'subject']);
  act(() => root!.unmount());
  host!.remove();
  await render(MARKED);
  expect(bar().slice(2, 5)).toEqual(['Read', 'Snooze', 'subject']);
  expect(head().querySelector('[data-mark-read]')!.getAttribute('aria-pressed')).toBe('true');
});

test.skipIf(!hasDom)('desktop ⋯ no longer repeats Snooze (the clock has it); a phone bar has neither the read button nor the clock', async () => {
  await render(WAITING);
  expect(menuItems(await openMore())).not.toContain('Snooze');
  act(() => root!.unmount());
  host!.remove();
  await render(OPENED, true);
  expect(bar()).toEqual(['‹ Inbox', 'subject', 'Artifacts', 'Expand', 'More']);
  expect(head().querySelector('[data-mark-read], [data-mark-unread], [data-thread-snooze]')).toBeNull();
});

test.skipIf(!hasDom)('tooltips: the read button says its words, with E for Mark read; the clock says Snooze', async () => {
  await render(WAITING);
  const markRead = head().querySelector('[data-mark-read]')!;
  // A button that can be disabled hangs its tooltip on a wrapper the pointer reaches (Tip's `.ib-tipwrap`).
  const tip = await tooltipOf(markRead.closest('[data-tip-wrap]') ?? markRead);
  expect(tip).toContain('Mark read');
  // E, from the registry (the keycap), with the key named for a screen reader too.
  expect(document.querySelector('[data-shortcut-hint="inbox-thread.markRead"] kbd')?.textContent).toBe('E');
  expect(markRead.getAttribute('aria-keyshortcuts')).toBe('E');
  unhover(markRead.closest('[data-tip-wrap]') ?? markRead);
  expect(await tooltipOf(head().querySelector('[data-thread-snooze]')!)).toBe('Snooze');
  act(() => root!.unmount());
  host!.remove();
  await render(OPENED);
  expect(await tooltipOf(head().querySelector('[data-mark-unread]')!)).toBe('Mark unread');
  act(() => root!.unmount());
  host!.remove();
  await render(MARKED);
  const read = head().querySelector('[data-mark-read]')!;
  // The pressed Read says what a click does (as on main): it moves the thread back to the top.
  const readTip = await tooltipOf(read.closest('[data-tip-wrap]') ?? read);
  expect(readTip).toContain('Read');
  expect(readTip).toContain('Move it back to the top');
});

test.skipIf(!hasDom)("a phone's ⋯ leads with the read action, then Snooze, a divider, Pin, and the rest", async () => {
  await render(OPENED, true);
  expect(menuItems(await openMore())).toEqual(['Mark unread', 'Snooze', '—', 'Star thread', '—', 'Copy thread', '—', 'Copy link', 'Copy thread ID', '—', 'Request guided review', '—', 'Archive thread']);
  await press(threadMenu()!.querySelector('[data-thread-unread-item]')!);
  expect(calls).toEqual(['mark unread']);
  act(() => root!.unmount());
  host!.remove();
  calls.length = 0;
  await render(WAITING, true);
  expect(menuItems(await openMore()).slice(0, 3)).toEqual(['Mark read', 'Snooze', '—']);
  await press(threadMenu()!.querySelector('[data-thread-read-item]')!);
  expect(calls).toEqual(['mark read']);
});

// Parity with the desktop's read button, state by state: a phone has no read button in its bar, no row menu and no E,
// so its ⋯ sheet is the only place these are.
test.skipIf(!hasDom)("a phone's ⋯ offers every read action the desktop has: Move back to the top when marked read, Mark read and Mark unread on a seen update held in New", async () => {
  // Marked read: the desktop's pressed Read moves it back (and its ⋯ offers Mark unread).
  await render(MARKED, true);
  expect(menuItems(await openMore()).slice(0, 4)).toEqual(['Move back to the top', 'Mark unread', 'Snooze', '—']);
  await press(threadMenu()!.querySelector('[data-thread-move-back-item]')!);
  expect(calls).toEqual(['move back']);
  act(() => root!.unmount());
  host!.remove();
  calls.length = 0;
  // A seen update the list still holds in New: the desktop's button is Mark unread, and Mark read is its E and row menu.
  const held = row({ section: 'quiet' });
  await render(held, false, THREAD, 'new');
  expect(head().querySelector('[data-mark-unread]')).not.toBeNull();
  act(() => root!.unmount());
  host!.remove();
  await render(held, true, THREAD, 'new');
  expect(menuItems(await openMore()).slice(0, 4)).toEqual(['Mark read', 'Mark unread', 'Snooze', '—']);
  await press(threadMenu()!.querySelector('[data-thread-read-item]')!);
  expect(calls).toEqual(['mark read']);
});

test.skipIf(!hasDom)("a phone's Snooze swaps the sheet for ‹ Snooze until and its times; ‹ goes back to the sheet", async () => {
  await render(OPENED, true);
  const menu = await openMore();
  await press(menu.querySelector('[data-thread-snooze-item]')!);
  await until(() => !!threadMenu()?.querySelector('[data-snooze-back]'), 'the times');
  // The times come from the menu's own rule: Later today is gone from 6 PM, and a choice on the time of one above it is dropped.
  const labels = inboxSnoozeChoices(new Date()).map((choice) => choice.label);
  expect(menuItems(threadMenu()!)).toEqual(['Snooze until', ...labels.map((label) => expect.stringContaining(label)), '—', 'Pick a time…'] as never);
  // The sheet keeps the thread's subject as its title.
  expect(threadMenu()!.querySelector('.ib-pm-title')?.textContent).toBe(SUBJECT);
  await press(threadMenu()!.querySelector('[data-snooze-back]')!);
  await until(() => !!threadMenu()?.querySelector('[data-thread-snooze-item]'), 'the sheet again');
  expect(menuItems(threadMenu()!)[0]).toBe('Mark unread');
});

test.skipIf(!hasDom)("desktop: the clock opens the times, titled Snooze until; a time snoozes; Pick a time's lists snooze too", async () => {
  await render(OPENED);
  const clock = head().querySelector('[data-thread-snooze]')!;
  const snoozeMenu = () => document.querySelector<HTMLElement>('[data-thread-snooze-menu]');
  await press(clock);
  await until(() => !!snoozeMenu(), 'the times');
  expect(snoozeMenu()!.querySelector('[data-snooze-title]')?.textContent).toBe('Snooze until');
  // Nothing to go back to: the times are this menu.
  expect(snoozeMenu()!.querySelector('[data-snooze-back]')).toBeNull();
  expect([...snoozeMenu()!.querySelectorAll('[data-snooze-choice]')].map((el) => el.getAttribute('data-snooze-choice'))).toHaveLength(inboxSnoozeChoices(new Date()).length);
  await press(snoozeMenu()!.querySelector('[data-snooze-choice]')!);
  expect(snoozed).toHaveLength(1);
  expect(Number.isNaN(Date.parse(snoozed[0]!))).toBe(false);
  await until(() => !snoozeMenu(), 'the menu to close');
  // Pick a time, as today: its two lists, ‹ Pick a time back to the times, and its Snooze.
  await press(clock);
  await until(() => !!snoozeMenu(), 'the times again');
  await press(snoozeMenu()!.querySelector('[data-snooze-pick-time]')!);
  await until(() => !!snoozeMenu()?.querySelector('[data-snooze-picker]'), 'the picker');
  await press(snoozeMenu()!.querySelector('[data-snooze-back]')!);
  await until(() => !!snoozeMenu()?.querySelector('[data-snooze-choice]'), 'the times after ‹');
  await press(snoozeMenu()!.querySelector('[data-snooze-pick-time]')!);
  await until(() => !!snoozeMenu()?.querySelector('[data-snooze-picker]'), 'the picker again');
  await press(snoozeMenu()!.querySelector('[data-snooze-go]')!);
  expect(snoozed).toHaveLength(2);
  expect(Date.parse(snoozed[1]!)).toBeGreaterThan(Date.now());
});

test.skipIf(!hasDom)('desktop: a Snooze from the clock leaves the read button as it was; Escape closes the clock menu, never the thread', async () => {
  const snoozeMenu = () => document.querySelector<HTMLElement>('[data-thread-snooze-menu]');
  for (const [state, name, pressed] of [[WAITING, 'Mark read', 'false'], [MARKED, 'Read', 'true']] as const) {
    await render(state);
    await press(head().querySelector('[data-thread-snooze]')!);
    await until(() => !!snoozeMenu(), 'the times');
    await press(snoozeMenu()!.querySelector('[data-snooze-choice]')!);
    await until(() => !snoozeMenu(), 'the menu to close');
    const read = head().querySelector('[data-mark-read]')!;
    expect(read.getAttribute('aria-label')).toBe(name);
    expect(read.getAttribute('aria-pressed')).toBe(pressed);
    act(() => root!.unmount());
    host!.remove();
    for (const undo of restore.splice(0).reverse()) undo();
  }
  expect(snoozed).toHaveLength(2);
  await render(WAITING);
  await press(head().querySelector('[data-thread-snooze]')!);
  await until(() => !!snoozeMenu(), 'the times again');
  const target = (document.activeElement && snoozeMenu()!.contains(document.activeElement) ? document.activeElement : snoozeMenu())!;
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await until(() => !snoozeMenu(), 'Escape to close the menu');
  expect(calls).not.toContain('close');
  expect(head().querySelector('[data-thread-snooze]')).not.toBeNull();
  expect(snoozed).toHaveLength(2);
});

/**
 * happy-dom has no layout: lay the phone bar out as the browser does (inbox.css's phone rules), one flex row inside
 * the header's 4 px end padding. ‹ Inbox is its chevron (22), "Inbox" (40) and its paddings (4, then 10, 6 when
 * tight); Artifacts is 52 with its count, 44 without; every other control is 44; the subject takes what is left.
 */
function layOutPhoneBar(width: number) {
  const bar = head();
  bar.style.paddingRight = '4px';
  const widthOf = (el: Element): number => {
    const fit = bar.getAttribute('data-fit') ?? '';
    if (el.classList.contains('ib-pback')) return fit.includes('back') ? 44 : 4 + 22 + 40 + (fit.includes('tight') ? 6 : 10);
    if (el.classList.contains('ib-artbtn')) return fit.includes('count') ? 44 : 52;
    if (el.classList.contains('ib-phsubj')) return 0;
    return 44;
  };
  const rects = () => {
    const kids = [...bar.children];
    const fixed = kids.reduce((sum, el) => sum + widthOf(el), 0);
    const subject = Math.max(0, width - 4 - fixed);
    let x = 0;
    const out = new Map<Element, { left: number; width: number }>();
    for (const el of kids) {
      const w = el.classList.contains('ib-phsubj') ? subject : widthOf(el);
      out.set(el, { left: x, width: w });
      x += w;
    }
    return out;
  };
  const box = (left: number, w: number) => ({ left, right: left + w, width: w, top: 0, bottom: 48, height: 48, x: left, y: 0, toJSON() {} }) as DOMRect;
  const saved = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this === bar) return box(0, width);
    const r = rects().get(this);
    if (r) return box(r.left, r.width);
    if (this.classList.contains('ib-pback-l')) return box(26, (bar.getAttribute('data-fit') ?? '').includes('back') ? 0 : 40);
    return saved.call(this);
  };
  const label = bar.querySelector<HTMLElement>('.ib-pback-l')!;
  Object.defineProperty(label, 'clientWidth', { configurable: true, get: () => ((bar.getAttribute('data-fit') ?? '').includes('back') ? 0 : 40) });
  Object.defineProperty(label, 'scrollWidth', { configurable: true, get: () => 40 });
  restore.push(() => {
    HTMLElement.prototype.getBoundingClientRect = saved;
  });
}

for (const width of [320, 390]) {
  test.skipIf(!hasDom)(`a phone at ${width} px: the title has room to read it, "Inbox" whole and the count kept`, async () => {
    for (const [thread, shown] of [[THREAD, 'customize row look'], [{ ...THREAD, thread_name: null }, SUBJECT]] as const) {
      await render(OPENED, true, thread);
      layOutPhoneBar(width);
      expect(fitPhoneHead(head())).toEqual([]);
      expect(head().hasAttribute('data-subject-off')).toBe(false);
      const title = head().querySelector<HTMLElement>('.ib-phsubj')!;
      expect(title.textContent).toBe(shown);
      expect(title.getBoundingClientRect().width).toBeGreaterThanOrEqual(SUBJECT_FLOOR);
      act(() => root?.unmount());
      host?.remove();
      for (const undo of restore.splice(0).reverse()) undo();
    }
  });
}

/**
 * The bar's title (the owner, 2026-11-02): the thread's name by the list's rule (`threadChipName`), else the subject,
 * shown as main shows it (a name always; the subject once the body's heading has scrolled away). The body keeps the
 * subject as the thread's heading. Its tooltip is the whole subject. No name pill on the meta line.
 */
const title = () => host!.querySelector<HTMLElement>('.ib-phead [data-header-subject]');
const heading = () => host!.querySelector<HTMLElement>('.ib-pbody > h2.ib-subject');
const namePill = () => host!.querySelector('.ib-pbody [data-thread-meta] .ib-key');

test.skipIf(!hasDom)('a named thread: the bar shows the name at once, its tooltip the whole subject; the heading is the subject; no name pill', async () => {
  await render(OPENED);
  expect(title()!.textContent).toBe('customize row look');
  expect(title()!.hasAttribute('data-on')).toBe(true);
  expect(title()!.getAttribute('aria-hidden')).toBe('true');
  expect(heading()!.textContent).toBe(SUBJECT);
  expect(await tooltipOf(title()!)).toBe(SUBJECT);
  expect(namePill()).toBeNull();
  // Seen words only: the screen-reader line ("Thread name: …") is the one extra, on purpose (threadNameMeta.test).
  const seen = [...host!.querySelectorAll('.ib-sr')].reduce((t, el) => t.replace(el.textContent!, ''), host!.textContent!);
  expect(seen.split('customize row look').length - 1).toBe(1);
});

test.skipIf(!hasDom)('no name: the bar holds the subject (shown once the heading scrolls away: threadNameMeta.test.tsx), its tooltip only when cut; no pill', async () => {
  await render(OPENED, false, { ...THREAD, thread_name: null });
  expect(title()!.textContent).toBe(SUBJECT);
  expect(heading()!.textContent).toBe(SUBJECT);
  expect(await tooltipOf(title()!)).toBeNull();
  unhover(title()!);
  sized(title()!, 900, 120);
  expect(await tooltipOf(title()!)).toBe(SUBJECT);
  expect(namePill()).toBeNull();
});

test.skipIf(!hasDom)('a name equal to the subject, or one the subject starts with: the subject, by the list rule, never the same words twice', async () => {
  for (const [name, subject] of [['Fix login', 'Fix login'], ['fix login', 'Fix login: the token refresh races the logout']] as const) {
    await render(OPENED, false, { ...THREAD, thread_name: name, subject, messages: THREAD.messages.map((m) => (m.id === ROOT ? { ...m, subject } : m)) });
    expect(title()!.textContent).toBe(subject);
    expect(title()!.hasAttribute('data-header-name')).toBe(false);
    expect(heading()!.textContent).toBe(subject);
    expect(namePill()).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    for (const undo of restore.splice(0).reverse()) undo();
  }
});
