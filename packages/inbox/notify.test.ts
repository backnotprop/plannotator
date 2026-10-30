/**
 * The one-time notifications line: "moved" only when the Inbox changed port
 * under the same name. The tailnet address (another device, another name)
 * is another permission, so it gets the plain ask. And which threads notify
 * (approval "inbox-notify-every-thread"): every new thread (its root's first line), a question
 * unless its thread is on screen, bursts by where the person is.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxMessage } from '@plannotator/core/inbox-types';
import {
  askKind,
  burstNotificationText,
  FRONT_BURST_MS,
  inboxNotificationOptions,
  isNewAgentThread,
  notifiableItems,
  NOTIFICATION_TAG,
  startsNewBurst,
  threadNotificationText,
  type NotifyItem,
} from './notify';

const saved = (allowed_origin: string | null) => ({ enabled: true, dismissed: false, allowed_origin });

describe('askKind', () => {
  test('a port change on this computer reads as moved', () => {
    expect(askKind(saved('http://localhost:52817'), 'default', 'http://localhost:61000')).toBe('moved');
    expect(askKind(saved('http://127.0.0.1:52817'), 'default', 'http://localhost:61000')).toBe('moved');
  });
  test('moving to plannotator.localhost (the cookie switch, #2184) reads as moved, at once', () => {
    expect(askKind(saved('http://localhost:52817'), 'default', 'http://plannotator.localhost:52817', false)).toBe('moved');
    expect(askKind(saved('http://plannotator.localhost:52817'), 'default', 'http://localhost:61000')).toBe('moved');
  });
  test('the tailnet address and back again are each a plain ask, not "moved"', () => {
    expect(askKind(saved('http://localhost:52817'), 'default', 'https://studio.tail0000.ts.net:52817')).toBe('ask');
    expect(askKind(saved('https://studio.tail0000.ts.net:52817'), 'default', 'http://localhost:52817')).toBe('ask');
  });
  test('nothing when this address is allowed, the person said Not now, or turned them off', () => {
    expect(askKind(saved('http://localhost:1'), 'granted', 'https://studio.tail0000.ts.net:1')).toBeNull();
    expect(askKind({ ...saved(null), dismissed: true }, 'default', 'http://localhost:1')).toBeNull();
    expect(askKind({ ...saved(null), dismissed: true }, 'denied', 'http://localhost:1')).toBeNull();
    expect(askKind({ ...saved(null), enabled: false }, 'default', 'http://localhost:1')).toBeNull();
    expect(askKind(saved(null), 'default', 'http://localhost:1')).toBe('ask');
  });
  test("the owner's case: allowed at 127.0.0.1, now at localhost on the same port, no permission: moved, at once", () => {
    expect(askKind(saved('http://127.0.0.1:59812'), 'default', 'http://localhost:59812', false)).toBe('moved');
  });
  test('the plain ask and the blocked line wait for a thread (never on an empty first run); moved does not', () => {
    expect(askKind(saved(null), 'default', 'http://localhost:1', false)).toBeNull();
    expect(askKind(saved(null), 'denied', 'http://localhost:1', false)).toBeNull();
    expect(askKind(saved(null), 'denied', 'http://localhost:1', true)).toBe('blocked');
    expect(askKind(saved('http://localhost:1'), 'default', 'http://localhost:2', false)).toBe('moved');
  });
  test('allowed here before but the permission was reset: the plain ask', () => {
    expect(askKind(saved('http://localhost:1'), 'default', 'http://localhost:1')).toBe('ask');
  });
});

describe('inboxNotificationOptions', () => {
  // A new notice replaces the last (one tag) and still alerts (renotify): without
  // renotify Chrome replaces a notice that carries the tag silently.
  test('every notice carries the one tag and renotify', () => {
    const options = inboxNotificationOptions({ body: 'Pick a retry policy' });
    expect(options.tag).toBe(NOTIFICATION_TAG);
    expect(options.renotify).toBe(true);
    expect(options.body).toBe('Pick a retry policy');
  });
});

describe('which threads notify', () => {
  const agent = { kind: 'agent' as const, host: 'claude-code', session: 'ses_1', name: null };
  const root = (over: Partial<InboxMessage> = {}): InboxMessage =>
    ({
      id: 'msg_1',
      project_id: 'prj_1',
      thread_id: 'msg_1',
      reply_to: null,
      author: agent,
      subject: 'Retry policy',
      body: 'Hello',
      created_at: '2026-10-15T10:00:00.000Z',
      resolved_at: null,
      idempotency_key: null,
      ...over,
    }) as InboxMessage;

  test("a new agent root is a new thread; a root this page knew, a reply, or a person's root is not", () => {
    expect(isNewAgentThread(root(), true, new Set())).toBe(true);
    expect(isNewAgentThread(root(), true, new Set(['msg_1']))).toBe(false);
    expect(isNewAgentThread(root({ id: 'msg_2', reply_to: 'msg_1' }), true, new Set())).toBe(false);
    expect(isNewAgentThread(root({ author: { kind: 'person' } }), true, new Set())).toBe(false);
    expect(isNewAgentThread(root({ started_by_person: true }), true, new Set())).toBe(false);
  });

  test('a root already looked at, read, archived or read by its agent is a rewrite, not a new thread', () => {
    expect(isNewAgentThread(root({ person_seen_seq: 4 }), true, new Set())).toBe(false);
    expect(isNewAgentThread(root({ person_read_seq: 4 }), true, new Set())).toBe(false);
    expect(isNewAgentThread(root({ resolved_at: '2026-10-15T10:01:00.000Z' }), true, new Set())).toBe(false);
    expect(isNewAgentThread(root({ agent_checked_seq: 4 }), true, new Set())).toBe(false);
  });

  test("only the root's first line is a new thread: an Unarchive's line looks like a fresh root but is not first", () => {
    // An archived-before-load thread unarchived: resolved_at null, never looked at, unknown to the page.
    expect(isNewAgentThread(root(), false, new Set())).toBe(false);
    // An Inbox without the field notifies no new thread.
    expect(isNewAgentThread(root(), undefined, new Set())).toBe(false);
  });

  test('a new thread always notifies; a question notifies unless its thread is on screen', () => {
    const items: NotifyItem[] = [
      { threadId: 'open', author: agent, asks: true, fresh: false, keys: [] },
      { threadId: 'other', author: agent, asks: true, fresh: false, keys: [] },
      { threadId: 'brand-new', author: agent, asks: false, fresh: true, keys: [] },
    ];
    const onScreen = (id: string) => id === 'open' || id === 'brand-new';
    expect(notifiableItems(items, onScreen).map((item) => item.threadId)).toEqual(['other', 'brand-new']);
    expect(notifiableItems(items, () => false)).toHaveLength(3);
  });

  test('away, a burst lasts until the tab is back; in front, notices within the window are one burst', () => {
    expect(startsNewBurst(null, false, 0)).toBe(true);
    expect(startsNewBurst({ front: false, at: 0 }, false, FRONT_BURST_MS * 10)).toBe(false);
    expect(startsNewBurst({ front: true, at: 0 }, true, FRONT_BURST_MS)).toBe(false);
    expect(startsNewBurst({ front: true, at: 0 }, true, FRONT_BURST_MS + 1)).toBe(true);
    // The person's place changed: a notice raised in front never joins the away burst, nor the other way.
    expect(startsNewBurst({ front: true, at: 0 }, false, 1)).toBe(true);
    expect(startsNewBurst({ front: false, at: 0 }, true, 1)).toBe(true);
  });

  test('a new thread that asks nothing is not titled as waiting on the person; a burst holding one is not counted as waiting', () => {
    const base = { project: 'billing-svc', agent: 'Claude Code', subject: 'Deploy notes' };
    const news = threadNotificationText({ ...base, section: 'new', asks: false });
    const asking = threadNotificationText({ ...base, section: 'waiting', asks: true });
    expect(news.title.startsWith('billing-svc: Claude Code')).toBe(true);
    expect(news.title).not.toBe(asking.title);
    expect(news.body).toBe('Deploy notes');
    // A Stopped thread reads as stopped whatever brought the notice.
    expect(threadNotificationText({ ...base, section: 'stopped', asks: false }).title).toBe(
      threadNotificationText({ ...base, section: 'stopped' }).title,
    );
    const waiting = burstNotificationText(['a', 'b']);
    const mixed = burstNotificationText(['a', 'b'], { waiting: false });
    expect(mixed.title).not.toBe(waiting.title);
    expect(mixed.title.startsWith('2 ')).toBe(true);
    expect(mixed.body).toBe(waiting.body);
  });
});
