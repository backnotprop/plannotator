/**
 * useInboxNotifications against a recording Notification constructor and a
 * scripted "tab in front" (approval "inbox-notify-every-thread"): a new
 * thread (its root's first line) notifies in front or away, a question
 * notifies in front unless its thread is open and visible, plain news never
 * does, a later line of a root (an Unarchive of a thread archived before the
 * page loaded) is never a new thread, a burst collapses into one notice and
 * drops a thread the person opened, a notice is silent only when the bell
 * owns its sound, and two tabs raise each item once.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxListRow, InboxMessage, InboxQuestion, InboxSectionId } from '@plannotator/core/inbox-types';
import type { InboxEvent, ListModel } from './api';
import type { InboxNotifications } from './notify';
import { FROZEN_NOTICE_MS, NOTICE_CLAIMS_KEY, TEST_NOTIFICATION_TAG } from './notify';

const hasDom = typeof document !== 'undefined';
const { useInboxNotifications } = (hasDom ? await import('./notify') : {}) as typeof import('./notify');

interface Raised {
  title: string;
  body: string;
  tag: string;
  silent: boolean;
}

let raised: Raised[] = [];
let front = { visible: true, focused: true };
const saved: { notification?: unknown; hasFocus?: () => boolean; visibility?: PropertyDescriptor } = {};

function installStubs() {
  raised = [];
  class RecordingNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = async () => 'granted' as NotificationPermission;
    onclick: (() => void) | null = null;
    constructor(title: string, options: NotificationOptions = {}) {
      raised.push({ title, body: options.body ?? '', tag: options.tag ?? '', silent: options.silent === true });
    }
    close() {}
  }
  saved.notification = (window as unknown as { Notification?: unknown }).Notification;
  (window as unknown as { Notification: unknown }).Notification = RecordingNotification;
  (globalThis as unknown as { Notification: unknown }).Notification = RecordingNotification;
  saved.hasFocus = document.hasFocus;
  saved.visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (front.visible ? 'visible' : 'hidden') });
  document.hasFocus = () => front.focused;
}

function restoreStubs() {
  // Put back "none" as none: a property set to undefined reads as support (see tour.test.tsx).
  if (saved.notification === undefined) {
    delete (window as unknown as { Notification?: unknown }).Notification;
    delete (globalThis as unknown as { Notification?: unknown }).Notification;
  } else {
    (window as unknown as { Notification: unknown }).Notification = saved.notification;
    (globalThis as unknown as { Notification: unknown }).Notification = saved.notification;
  }
  document.hasFocus = saved.hasFocus!;
  if (saved.visibility) Object.defineProperty(document, 'visibilityState', saved.visibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
/** One hook per tab: tabs[0] is this tab; a second Probe stands for another tab (same storage). */
const tabs: InboxNotifications[] = [];
let onScreen: string | null = null;
let questionsHeard = 0;
let bell = false;
let otherTabInFront = false;

function Probe({ index }: { index: number }) {
  tabs[index] = useInboxNotifications({
    settings: { enabled: true, dismissed: false, allowed_origin: null },
    onSettings: () => {},
    openThread: () => {},
    openList: () => {},
    onQuestions: () => {
      questionsHeard++;
    },
    bellCovers: () => bell,
    otherTabInFront: () => otherTabInFront,
    threadOnScreen: (threadId) => threadId === onScreen,
  });
  return null;
}

const claude: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
let seq = 0;

/** A message line; a root's is its first line unless `first: false` (a rewrite: a look, an archive, an Unarchive). */
function message(id: string, threadId: string, over: Partial<InboxMessage> = {}, first = true): InboxEvent {
  return {
    seq: ++seq,
    kind: 'message',
    id,
    first,
    message: {
      id,
      project_id: 'prj_1',
      thread_id: threadId,
      reply_to: id === threadId ? null : threadId,
      author: claude,
      subject: id === threadId ? `Subject ${threadId}` : null,
      body: 'Body',
      created_at: '2026-10-15T10:00:00.000Z',
      resolved_at: null,
      idempotency_key: null,
      ...over,
    } as InboxMessage,
  };
}

function question(messageId: string, key: string): InboxEvent {
  return {
    seq: ++seq,
    kind: 'question',
    id: `${messageId}/${key}`,
    question: { message_id: messageId, key, state: 'open', revision: 0 } as unknown as InboxQuestion,
  };
}

function list(threads: { id: string; section: InboxSectionId; project?: string }[]): ListModel {
  const rows = threads.map(
    (t) =>
      ({
        thread_id: t.id,
        project: { id: 'prj_1', name: t.project ?? 'billing-svc' },
        subject: `Subject ${t.id}`,
        section: t.section,
      }) as unknown as InboxListRow,
  );
  return { sections: [{ id: 'new', label: 'New', threads: rows }] } as unknown as ListModel;
}

/** One event-stream batch, then the list read that follows it, in every tab given (this one by default). */
async function batch(events: InboxEvent[], after: ListModel, which: InboxNotifications[] = [tabs[0]!]) {
  await act(async () => {
    for (const tab of which) {
      for (const event of events) tab.observe(event);
      tab.flush(after);
    }
    // The claim (claimNotices) settles on a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function away() {
  front = { visible: false, focused: false };
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function back() {
  front = { visible: true, focused: true };
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

function mountTabs(count: number) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <Probe key={index} index={index} />
        ))}
      </>,
    );
  });
}

describe.if(hasDom)('useInboxNotifications', () => {
  beforeEach(async () => {
    front = { visible: true, focused: true };
    onScreen = null;
    questionsHeard = 0;
    bell = false;
    otherTabInFront = false;
    tabs.length = 0;
    window.localStorage.clear();
    installStubs();
    mountTabs(1);
    // The page's first list read: these threads were already here.
    await batch([], list([{ id: 'old', section: 'waiting' }]));
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    restoreStubs();
    window.localStorage.clear();
  });

  test('a new thread that asks nothing notifies with the tab in front, and the sound hears nothing', async () => {
    await batch([message('t1', 't1')], list([{ id: 'old', section: 'waiting' }, { id: 't1', section: 'new' }]));
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title.startsWith('billing-svc: Claude Code')).toBe(true);
    expect(raised[0]!.body).toBe('Subject t1');
    expect(questionsHeard).toBe(0);
  });

  test('an Unarchive of a thread archived before the page loaded is not a new thread', async () => {
    // Unknown to the page (the window's list leaves archived threads out), created before load, open again, never looked at.
    const unarchived = message('arch', 'arch', { created_at: '2026-10-01T09:00:00.000Z', resolved_at: null }, false);
    await batch([unarchived], list([{ id: 'old', section: 'waiting' }, { id: 'arch', section: 'quiet' }]));
    expect(raised).toHaveLength(0);
  });

  test('a question in the thread open and visible raises nothing in front; away, or in another thread, it does', async () => {
    onScreen = 'old';
    await batch([message('m1', 'old'), question('m1', 'q-1')], list([{ id: 'old', section: 'waiting' }]));
    expect(raised).toHaveLength(0);
    // The sound still hears it (it decides for itself, and rings only with no Inbox tab in front).
    expect(questionsHeard).toBe(1);

    away();
    await batch([message('m2', 'old'), question('m2', 'q-2')], list([{ id: 'old', section: 'waiting' }]));
    expect(raised).toHaveLength(1);
    back();

    onScreen = 'elsewhere';
    await batch([message('m3', 'old'), question('m3', 'q-3')], list([{ id: 'old', section: 'waiting' }]));
    expect(raised).toHaveLength(2);
    expect(raised.every((r) => r.body === 'Subject old')).toBe(true);
  });

  test('plain news in a known thread never notifies, in front or away', async () => {
    await batch([message('m1', 'old')], list([{ id: 'old', section: 'new' }]));
    away();
    await batch([message('m2', 'old')], list([{ id: 'old', section: 'new' }]));
    expect(raised).toHaveLength(0);
  });

  test('a later line of a root the page already listed (a look) is never a new thread', async () => {
    await batch([message('old', 'old', {}, false)], list([{ id: 'old', section: 'quiet' }]));
    expect(raised).toHaveLength(0);
  });

  test('a burst collapses into one notice on the one tag; one with a thread that asks nothing is not counted as waiting', async () => {
    away();
    await batch([message('t1', 't1'), question('t1', 'q-1')], list([{ id: 't1', section: 'waiting' }]));
    await batch([message('t2', 't2'), question('t2', 'q-2')], list([{ id: 't1', section: 'waiting' }, { id: 't2', section: 'waiting', project: 'docs-site' }]));
    expect(raised.map((r) => r.tag)).toEqual([raised[0]!.tag, raised[0]!.tag]);
    const waitingBurst = raised.at(-1)!;
    expect(waitingBurst.title.startsWith('2 ')).toBe(true);
    expect(waitingBurst.body).toBe('billing-svc, docs-site');
    await batch(
      [message('t3', 't3')],
      list([
        { id: 't1', section: 'waiting' },
        { id: 't2', section: 'waiting', project: 'docs-site' },
        { id: 't3', section: 'new' },
      ]),
    );
    const mixed = raised.at(-1)!;
    expect(mixed.title.startsWith('3 ')).toBe(true);
    expect(mixed.title.replace('3', '2')).not.toBe(waitingBurst.title);
  });

  test('a notice raised in front does not join the next away burst', async () => {
    await batch([message('t1', 't1')], list([{ id: 't1', section: 'new' }]));
    away();
    await batch([message('t2', 't2'), question('t2', 'q-1')], list([{ id: 't1', section: 'new' }, { id: 't2', section: 'waiting' }]));
    expect(raised).toHaveLength(2);
    // One thread in this burst: its own banner, not "2 … in billing-svc".
    expect(raised[1]!.body).toBe('Subject t2');
  });

  test('in front, a thread the person opened leaves the burst', async () => {
    await batch([message('t1', 't1')], list([{ id: 't1', section: 'new' }]));
    // The person opens t1; the next new thread is a notice of its own, not "2 new".
    onScreen = 't1';
    await batch([message('t2', 't2')], list([{ id: 't1', section: 'new' }, { id: 't2', section: 'new' }]));
    expect(raised).toHaveLength(2);
    expect(raised[1]!.body).toBe('Subject t2');
  });

  test('silent only when the bell owns the sound: a question, this tab away, the bell on', async () => {
    bell = true;
    // In front: the bell never rings here, so the notice keeps the system's sound.
    await batch([message('m1', 'old'), question('m1', 'q-1')], list([{ id: 'old', section: 'waiting' }]));
    away();
    // Away, a new thread that asks nothing: the bell does not ring for it.
    await batch([message('t1', 't1')], list([{ id: 'old', section: 'waiting' }, { id: 't1', section: 'new' }]));
    // Away, a question: the bell's.
    await batch([message('t2', 't2'), question('t2', 'q-2')], list([{ id: 't2', section: 'waiting' }]));
    // The bell off (or not armed): the system's sound again.
    bell = false;
    await batch([message('t3', 't3'), question('t3', 'q-3')], list([{ id: 't3', section: 'waiting' }]));
    expect(raised.map((r) => r.silent)).toEqual([false, false, true, false]);
  });

  test('two tabs raise each item once; a tab away defers to another tab in front', async () => {
    act(() => root?.unmount());
    host?.remove();
    tabs.length = 0;
    mountTabs(2);
    await batch([], list([]), tabs);
    away();
    await batch([message('t1', 't1'), question('t1', 'q-1')], list([{ id: 't1', section: 'waiting' }]), tabs);
    expect(raised).toHaveLength(1);
    await batch([message('t2', 't2')], list([{ id: 't1', section: 'waiting' }, { id: 't2', section: 'new' }]), [tabs[1]!, tabs[0]!]);
    expect(raised).toHaveLength(2);

    // Another Inbox tab is in front: this one, away, leaves it to that tab.
    otherTabInFront = true;
    await batch([message('t3', 't3')], list([{ id: 't3', section: 'new' }]), [tabs[0]!]);
    expect(raised).toHaveLength(2);
  });

  test('a tab that may not notify claims nothing, so it never swallows an item a tab that may would show', async () => {
    const Recording = (window as unknown as { Notification: { permission: NotificationPermission } }).Notification;
    Recording.permission = 'default';
    away();
    await batch([message('t1', 't1'), question('t1', 'q-1')], list([{ id: 't1', section: 'waiting' }]));
    expect(raised).toEqual([]);
    expect(window.localStorage.getItem(NOTICE_CLAIMS_KEY)).toBeNull();
    Recording.permission = 'denied';
    await batch([message('t2', 't2'), question('t2', 'q-2')], list([{ id: 't2', section: 'waiting' }]));
    expect(window.localStorage.getItem(NOTICE_CLAIMS_KEY)).toBeNull();
    // The same item, in a tab allowed to notify: it raises it.
    Recording.permission = 'granted';
    act(() => window.dispatchEvent(new Event('focus')));
    away();
    await batch([message('t3', 't3'), question('t3', 'q-3')], list([{ id: 't3', section: 'waiting' }]));
    expect(raised).toHaveLength(1);
    expect(window.localStorage.getItem(NOTICE_CLAIMS_KEY)).toContain('q-3');
  });

  test('the permission is read again when the tab comes back (a change made in site settings)', () => {
    const Recording = (window as unknown as { Notification: { permission: NotificationPermission } }).Notification;
    expect(tabs[0]!.permission).toBe('granted');
    Recording.permission = 'denied';
    back();
    expect(tabs[0]!.permission).toBe('denied');
    Recording.permission = 'granted';
  });

  test('the ask stays on every load until resolved: a list with threads is enough, no new question needed', async () => {
    const Recording = (window as unknown as { Notification: { permission: NotificationPermission } }).Notification;
    Recording.permission = 'default';
    act(() => root?.unmount());
    host?.remove();
    tabs.length = 0;
    mountTabs(1);
    expect(tabs[0]!.ask).toBeNull();
    await batch([], list([]));
    expect(tabs[0]!.ask).toBeNull();
    await batch([], list([{ id: 'old', section: 'quiet' }]));
    expect(tabs[0]!.ask).toBe('ask');
    Recording.permission = 'granted';
    back();
    expect(tabs[0]!.ask).toBeNull();
  });

  test('Send a test notification: raised on its own tag when allowed, refused when not', async () => {
    let result: string | undefined;
    await act(async () => {
      result = await tabs[0]!.sendTest();
    });
    expect(result).toBe('sent');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.tag).toBe(TEST_NOTIFICATION_TAG);
    expect(raised[0]!.title).toContain('test notification');
    const Recording = (window as unknown as { Notification: { permission: NotificationPermission } }).Notification;
    Recording.permission = 'default';
    await act(async () => {
      result = await tabs[0]!.sendTest();
    });
    expect(result).toBe('not-allowed');
    expect(raised).toHaveLength(1);
    Recording.permission = 'granted';
  });

  test('a tab the browser froze for a minute or more, or discarded, says so once', () => {
    expect(tabs[0]!.slept).toBeNull();
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      act(() => document.dispatchEvent(new Event('freeze')));
      now += 10_000;
      act(() => document.dispatchEvent(new Event('resume')));
      expect(tabs[0]!.slept).toBeNull();
      act(() => document.dispatchEvent(new Event('freeze')));
      now += FROZEN_NOTICE_MS + 1;
      act(() => document.dispatchEvent(new Event('resume')));
      expect(tabs[0]!.slept).toBe('frozen');
      act(() => tabs[0]!.dismissSlept());
      expect(tabs[0]!.slept).toBeNull();
    } finally {
      Date.now = realNow;
    }
    // A reload after Memory Saver discarded the tab.
    act(() => root?.unmount());
    host?.remove();
    tabs.length = 0;
    Object.defineProperty(document, 'wasDiscarded', { configurable: true, value: true });
    try {
      mountTabs(1);
      expect(tabs[0]!.slept).toBe('discarded');
    } finally {
      delete (document as unknown as Record<string, unknown>).wasDiscarded;
    }
  });

  test('every (re)connect of the event stream reports the permission as it is now, not as the stream URL says', async () => {
    const posted: { window: string; permission: string }[] = [];
    const realFetch = globalThis.fetch;
    const RealEventSource = (globalThis as Record<string, unknown>).EventSource;
    const sources: { url: string; listeners: Map<string, (event: Event) => void> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/inbox/window') posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ notify_reach: { enabled: true, windows: 1, allowed: 1, allowed_origins: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    (globalThis as Record<string, unknown>).EventSource = class {
      listeners = new Map<string, (event: Event) => void>();
      constructor(public url: string) {
        sources.push(this);
      }
      addEventListener(name: string, listener: (event: Event) => void) {
        this.listeners.set(name, listener);
      }
      close() {}
    };
    const Recording = (window as unknown as { Notification: { permission: NotificationPermission } }).Notification;
    try {
      const { subscribeInboxEvents } = await import('./api');
      // Opened while the browser had not been asked.
      Recording.permission = 'default';
      back();
      const stop = subscribeInboxEvents(0, { onRecord: () => {}, onStatus: () => {}, onConnect: tabs[0]!.reportWindow }, tabs[0]!.windowReport());
      expect(sources[0]!.url).toContain('permission=default');
      // Allowed since; then the stream drops and reconnects (past the grace, or the Inbox restarted).
      Recording.permission = 'granted';
      back();
      posted.length = 0;
      await act(async () => {
        sources[0]!.listeners.get('hello')!(new Event('hello'));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(posted.map((p) => p.permission)).toEqual(['granted']);
      expect(posted[0]!.window).toBe(tabs[0]!.windowReport().id);
      stop();
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as Record<string, unknown>).EventSource = RealEventSource;
      Recording.permission = 'granted';
    }
  });

  test('the window report carries this tab: one id per page, its permission and origin', () => {
    const report = tabs[0]!.windowReport();
    expect(report.id.length).toBeGreaterThanOrEqual(8);
    expect(report.permission).toBe('granted');
    expect(report.origin).toBe(window.location.origin);
    expect(tabs[0]!.windowReport().id).toBe(report.id);
  });
});
