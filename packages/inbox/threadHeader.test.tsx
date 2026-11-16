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
import type { InboxAuthor, InboxListRow, InboxMessageWire, InboxProject, InboxReviewRow, InboxThread } from '@plannotator/core/inbox-types';
import { inboxSnoozeChoices } from '@plannotator/core/inbox-snooze';
import { fitPhoneHead, SUBJECT_FLOOR } from './headFit';
import { PHONE_QUERY } from './phone';
import { sized, tooltipOf, unhover } from './testing/tooltip';
import { reviewRowTitle, reviewViewOf, type ReviewView } from './pulls/reviewsModel';

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
/** The ⋯ menu's Priority item for the next render; none, as from an older Inbox, unless a test sets it. */
let priority: { on: boolean; onToggle: () => void } | undefined;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  snoozed.length = 0;
  calls.length = 0;
  priority = undefined;
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

async function render(state: InboxListRow, phone = false, thread: InboxThread = THREAD, drawn: 'quiet' | 'new' = 'quiet', reviewView: ReviewView | null = null) {
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
        priority={priority}
        onArtifacts={() => {}}
        onFull={() => {}}
        phone={phone}
        reviewView={reviewView}
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

test.skipIf(!hasDom)('the bar has no read button and no Snooze clock (desktop and phone): the subject comes first, then Artifacts, Expand, ⋯ (and × off a phone)', async () => {
  for (const state of [OPENED, WAITING, MARKED]) {
    await render(state);
    expect(bar()).toEqual(['subject', 'Artifacts', 'Expand', 'More', '|', 'Close the thread']);
    act(() => root!.unmount());
    host!.remove();
  }
  await render(OPENED, true);
  expect(bar()).toEqual(['‹ Inbox', 'subject', 'Artifacts', 'Expand', 'More']);
  expect(head().querySelector('.ib-readbtn, [data-mark-read], [data-mark-unread], [data-thread-snooze]')).toBeNull();
});

test.skipIf(!hasDom)('desktop ⋯: Mark read names E and Snooze names H for a screen reader (the keys did not move)', async () => {
  await render(WAITING);
  const menu = await openMore();
  expect(menu.querySelector('[data-thread-read-item]')!.getAttribute('aria-keyshortcuts')).toBe('E');
  expect(menu.querySelector('[data-thread-snooze-item]')!.getAttribute('aria-keyshortcuts')).toBe('H');
});

for (const phone of [false, true]) {
  const where = phone ? "a phone's ⋯" : 'the desktop ⋯';

  test.skipIf(!hasDom)(`${where} leads with the read action, then Snooze, a divider, Pin, and the rest`, async () => {
    await render(OPENED, phone);
    expect(menuItems(await openMore())).toEqual(['Mark unread', 'Snooze', '—', 'Star thread', '—', 'Copy thread', '—', 'Copy link', 'Copy thread ID', '—', 'Add a pull request…', '—', 'Request guided review', '—', 'Archive thread']);
    await press(threadMenu()!.querySelector('[data-thread-unread-item]')!);
    expect(calls).toEqual(['mark unread']);
    act(() => root!.unmount());
    host!.remove();
    calls.length = 0;
    await render(WAITING, phone);
    expect(menuItems(await openMore()).slice(0, 3)).toEqual(['Mark read', 'Snooze', '—']);
    await press(threadMenu()!.querySelector('[data-thread-read-item]')!);
    expect(calls).toEqual(['mark read']);
  });

  test.skipIf(!hasDom)(`${where} offers Add to Priority right after Star thread, and Remove from Priority for a thread in it`, async () => {
    priority = { on: false, onToggle: () => calls.push('priority') };
    await render(OPENED, phone);
    expect(menuItems(await openMore()).slice(0, 6)).toEqual(['Mark unread', 'Snooze', '—', 'Star thread', 'Add to Priority', '—']);
    await press(threadMenu()!.querySelector('[data-thread-priority-item]')!);
    expect(calls).toEqual(['priority']);
    act(() => root!.unmount());
    host!.remove();
    priority = { on: true, onToggle: () => {} };
    await render(OPENED, phone);
    expect(menuItems(await openMore()).slice(3, 5)).toEqual(['Star thread', 'Remove from Priority']);
  });

  test.skipIf(!hasDom)(`${where} offers every read action: Move back to the top when marked read, Mark read and Mark unread on a seen update held in New`, async () => {
    await render(MARKED, phone);
    expect(menuItems(await openMore()).slice(0, 4)).toEqual(['Move back to the top', 'Mark unread', 'Snooze', '—']);
    await press(threadMenu()!.querySelector('[data-thread-move-back-item]')!);
    expect(calls).toEqual(['move back']);
    act(() => root!.unmount());
    host!.remove();
    calls.length = 0;
    await render(row({ section: 'quiet' }), phone, THREAD, 'new');
    expect(menuItems(await openMore()).slice(0, 4)).toEqual(['Mark read', 'Mark unread', 'Snooze', '—']);
    await press(threadMenu()!.querySelector('[data-thread-read-item]')!);
    expect(calls).toEqual(['mark read']);
  });

  test.skipIf(!hasDom)(`${where}: Snooze swaps the menu for ‹ Snooze until and its times; ‹ goes back to the menu`, async () => {
    await render(OPENED, phone);
    const menu = await openMore();
    await press(menu.querySelector('[data-thread-snooze-item]')!);
    await until(() => !!threadMenu()?.querySelector('[data-snooze-back]'), 'the times');
    // The times come from the menu's own rule: Later today is gone from 6 PM, and a choice on the time of one above it is dropped.
    const labels = inboxSnoozeChoices(new Date()).map((choice) => choice.label);
    expect(menuItems(threadMenu()!)).toEqual(['Snooze until', ...labels.map((label) => expect.stringContaining(label)), '—', 'Pick a time…'] as never);
    // A phone's sheet keeps the thread's subject as its title.
    expect(threadMenu()!.querySelector('.ib-pm-title')?.textContent ?? null).toBe(phone ? SUBJECT : null);
    await press(threadMenu()!.querySelector('[data-snooze-back]')!);
    await until(() => !!threadMenu()?.querySelector('[data-thread-snooze-item]'), 'the menu again');
    expect(menuItems(threadMenu()!)[0]).toBe('Mark unread');
  });
}

test.skipIf(!hasDom)('"Snoozed until" shows while the time is ahead, never for a time gone by (an archived thread keeps its snooze until a look)', async () => {
  const at = '2026-10-20T18:00:00.000Z';
  await render(row({ resolved_at: at, snoozed: { until: new Date(Date.now() + 3_600_000).toISOString(), at } }));
  expect(host!.querySelector('[data-snooze-line]')).not.toBeNull();
  act(() => root?.unmount());
  host?.remove();
  await render(row({ resolved_at: at, snoozed: { until: new Date(Date.now() - 60_000).toISOString(), at } }));
  expect(host!.querySelector('[data-snooze-line]')).toBeNull();
  expect(host!.querySelector('[data-unsnooze]')).toBeNull();
});

async function openTimes() {
  const menu = await openMore();
  await press(menu.querySelector('[data-thread-snooze-item]')!);
  await until(() => !!threadMenu()?.querySelector('[data-snooze-choice]'), 'the times');
  return threadMenu()!;
}

test.skipIf(!hasDom)("desktop: ⋯ › Snooze's times snooze; Pick a time's lists snooze too", async () => {
  await render(OPENED);
  const times = await openTimes();
  expect([...times.querySelectorAll('[data-snooze-choice]')]).toHaveLength(inboxSnoozeChoices(new Date()).length);
  await press(times.querySelector('[data-snooze-choice]')!);
  expect(snoozed).toHaveLength(1);
  expect(Number.isNaN(Date.parse(snoozed[0]!))).toBe(false);
  await until(() => !threadMenu(), 'the menu to close');
  // Pick a time, as before: its two lists, ‹ Pick a time back to the times, and its Snooze.
  await openTimes();
  await press(threadMenu()!.querySelector('[data-snooze-pick-time]')!);
  await until(() => !!threadMenu()?.querySelector('[data-snooze-picker]'), 'the picker');
  await press(threadMenu()!.querySelector('[data-snooze-back]')!);
  await until(() => !!threadMenu()?.querySelector('[data-snooze-choice]'), 'the times after ‹');
  await press(threadMenu()!.querySelector('[data-snooze-pick-time]')!);
  await until(() => !!threadMenu()?.querySelector('[data-snooze-picker]'), 'the picker again');
  await press(threadMenu()!.querySelector('[data-snooze-go]')!);
  expect(snoozed).toHaveLength(2);
  expect(Date.parse(snoozed[1]!)).toBeGreaterThan(Date.now());
});

test.skipIf(!hasDom)('desktop: a Snooze leaves the read action as it was; Escape closes the menu, never the thread', async () => {
  for (const [state, first] of [[WAITING, 'Mark read'], [MARKED, 'Move back to the top']] as const) {
    await render(state);
    await press((await openTimes()).querySelector('[data-snooze-choice]')!);
    await until(() => !threadMenu(), 'the menu to close');
    expect(menuItems(await openMore())[0]).toBe(first);
    act(() => root!.unmount());
    host!.remove();
    for (const undo of restore.splice(0).reverse()) undo();
  }
  expect(snoozed).toHaveLength(2);
  await render(WAITING);
  const times = await openTimes();
  const target = (document.activeElement && times.contains(document.activeElement) ? document.activeElement : times)!;
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await until(() => !threadMenu(), 'Escape to close the menu');
  expect(calls).not.toContain('close');
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
/** The title's words inside its box: the tooltip's trigger. */
const words = () => title()!.querySelector<HTMLElement>('[data-header-title]');
const heading = () => host!.querySelector<HTMLElement>('.ib-pbody > h2.ib-subject');
const namePill = () => host!.querySelector('.ib-pbody [data-thread-meta] .ib-key');

// The owner, 2026-11-08: over a short name ("PRs") the tooltip opened far to the right, over the empty room after the
// words, because it hung on the title's box, which takes all the bar's free room. It hangs on the words now.
test.skipIf(!hasDom)("the title's tooltip opens over its words, not centred on the box's empty room", async () => {
  await render(OPENED);
  const box = title()!;
  const tipped = words()!;
  expect(tipped).not.toBe(box);
  expect(box.contains(tipped)).toBe(true);
  const rect = (left: number, width: number) => DOMRect.fromRect({ x: left, y: 10, width, height: 20 });
  const saved = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this === box) return rect(200, 800);
    if (this === tipped) return rect(208, 40);
    if (this.hasAttribute('data-pn-tooltip')) return rect(0, 120);
    return saved.call(this);
  };
  restore.push(() => {
    HTMLElement.prototype.getBoundingClientRect = saved;
  });
  expect(await tooltipOf(tipped)).toBe(SUBJECT);
  const popup = [...document.querySelectorAll<HTMLElement>('[data-pn-tooltip]')].at(-1)!;
  // Base UI's positioner names its anchor's size: the words' 40 px, not the box's 800.
  expect(popup.parentElement!.style.getPropertyValue('--anchor-width')).toBe('40px');
});

test.skipIf(!hasDom)('a named thread: the bar shows the name at once, its tooltip the whole subject; the heading is the subject; no name pill', async () => {
  await render(OPENED);
  expect(title()!.textContent).toBe('customize row look');
  expect(title()!.hasAttribute('data-on')).toBe(true);
  expect(title()!.getAttribute('aria-hidden')).toBe('true');
  expect(heading()!.textContent).toBe(SUBJECT);
  expect(await tooltipOf(words()!)).toBe(SUBJECT);
  expect(namePill()).toBeNull();
  // Seen words only: the screen-reader line ("Thread name: …") is the one extra, on purpose (threadNameMeta.test).
  const seen = [...host!.querySelectorAll('.ib-sr')].reduce((t, el) => t.replace(el.textContent!, ''), host!.textContent!);
  expect(seen.split('customize row look').length - 1).toBe(1);
});

test.skipIf(!hasDom)('no name: the bar holds the subject (shown once the heading scrolls away: threadNameMeta.test.tsx), its tooltip only when cut; no pill', async () => {
  await render(OPENED, false, { ...THREAD, thread_name: null });
  expect(title()!.textContent).toBe(SUBJECT);
  expect(heading()!.textContent).toBe(SUBJECT);
  expect(await tooltipOf(words()!)).toBeNull();
  unhover(words()!);
  sized(words()!, 900, 120);
  expect(await tooltipOf(words()!)).toBe(SUBJECT);
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

test.skipIf(!hasDom)("opened from Reviews, a review thread's bar says the review's title once it landed: the row's and the heading's name, not New review's", async () => {
  // A New review thread: the box named it from the question; the agent's guide then landed with its own title.
  const guideTitle = 'How a webhook delivery is retried when the subscriber is down';
  const started = { kind: 'walkthrough', changes: null, branch: null, base: null, ask: 'custom', host: 'claude-code', project_id: PROJECT.id, at: '', name: 'Webhook delivery' };
  const reviewRow = (review: unknown) =>
    ({ id: ROOT, thread_id: ROOT, reviewed: true, move: 'on_you', reason: review ? 'review_ready' : 'curating', review, started, link: null, stacks: [], pull_keys: [], landed: [], updated_at: '' }) as unknown as InboxReviewRow;
  const landed = reviewRow({ thread_id: ROOT, project_id: PROJECT.id, title: guideTitle, walkthrough: true, round: 1, first_review_id: ROOT, latest_review_id: ROOT, source: { kind: 'local' }, agent: null, answered: false, verdict: null });
  const thread: InboxThread = { ...THREAD, thread_name: 'Webhook delivery', review_started: true } as InboxThread;
  const view = (row: InboxReviewRow) => reviewViewOf(row, thread, { projectName: PROJECT.name, onWholeThread: () => {}, onOpenStack: () => {} });

  for (const phone of [false, true]) {
    await render(OPENED, phone, thread, 'quiet', view(landed));
    const rowTitle = reviewRowTitle(landed, () => '');
    expect(rowTitle).toBe(guideTitle);
    expect(title()!.textContent).toBe(rowTitle);
    expect(heading()!.textContent).toBe(rowTitle);
    expect(title()!.hasAttribute('data-header-name')).toBe(true);
    act(() => root?.unmount());
    host?.remove();
    for (const undo of restore.splice(0).reverse()) undo();
  }

  // Still curating: no title yet, so the row, the heading and the bar all keep the thread's name.
  const curating = reviewRow(null);
  await render(OPENED, false, thread, 'quiet', view(curating));
  expect(reviewRowTitle(curating, () => '')).toBe('Webhook delivery');
  expect(title()!.textContent).toBe('Webhook delivery');
  expect(heading()!.textContent).toBe('Webhook delivery');
  // Under the request, a walkthrough being written says so in its own words, not "Curating the review…".
  expect(document.querySelector('[data-review-curating]')?.textContent).toBe('Writing the walkthrough…');
});
