/**
 * Thread tabs (threadTabs.ts, issue #4027): `&alone` in the address, the tab channel's anchored set and its hand-off to
 * the main tab, the main tab's counts, and who notifies for which thread. No browser: tabs share a fake channel.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListSection } from '@plannotator/core/inbox-types';
import { hashOf } from './app/writeRoute';
import { routeOf } from './app/route';
import { inboxTabCount } from './tabCount';
import {
  ANCHOR_TTL_MS,
  OPEN_ACK_MS,
  createTabHub,
  excludedFromCounts,
  notifiesThread,
  parseTabMessage,
  routeClick,
  type TabHub,
  type TabMessage,
  type TabPort,
  type TabRole,
} from './threadTabs';

describe('the address', () => {
  test('`&alone` is read with a thread, and written back as a bare flag', () => {
    const route = routeOf('#thread=thr_a&alone');
    expect(route.thread).toBe('thr_a');
    expect(route.alone).toBe(true);
    expect(hashOf(route)).toBe('#thread=thr_a&alone');
  });

  test('without `&alone` the route is a main tab, and `alone` never rides without a thread', () => {
    expect(routeOf('#thread=thr_a').alone).toBe(false);
    expect(routeOf('#alone').alone).toBe(false);
    expect(hashOf({ ...routeOf('#thread=thr_a&alone'), alone: false })).toBe('#thread=thr_a');
    expect(hashOf({ page: 'inbox', project: null, thread: null, alone: true })).toBe('');
  });

  test('the rest of a thread route keeps its spelling beside `&alone`', () => {
    const route = routeOf('#project=prj_1&thread=thr_a&alone&msg=msg_9');
    expect(route).toMatchObject({ project: 'prj_1', thread: 'thr_a', alone: true, msg: 'msg_9' });
    expect(routeOf(hashOf(route))).toMatchObject({ project: 'prj_1', thread: 'thr_a', alone: true, msg: 'msg_9' });
  });
});

/** Tabs on one fake channel: a message reaches every tab but the sender. */
function bus() {
  const ports = new Set<{ handler: ((m: TabMessage) => void) | null }>();
  const sent: TabMessage[] = [];
  return {
    sent,
    port(): TabPort {
      const me = { handler: null as ((m: TabMessage) => void) | null };
      ports.add(me);
      return {
        post: (message) => {
          sent.push(message);
          for (const other of ports) if (other !== me) other.handler?.(message);
        },
        listen: (handler) => {
          me.handler = handler;
          return () => {
            me.handler = null;
          };
        },
      };
    },
  };
}

function world() {
  let clock = 1_000;
  const channel = bus();
  const timers: { run: () => void; at: number; live: boolean }[] = [];
  const opened: string[] = [];
  const tab = (id: string, role: TabRole, label = id): TabHub =>
    createTabHub({
      port: channel.port(),
      tab: id,
      role,
      now: () => clock,
      onOpen: (route) => opened.push(`${label}:${route}`),
      setTimer: (run, ms) => {
        const entry = { run, at: clock + ms, live: true };
        timers.push(entry);
        return () => {
          entry.live = false;
        };
      },
    });
  return {
    tab,
    opened,
    advance(ms: number) {
      clock += ms;
      for (const t of timers) if (t.live && t.at <= clock) ((t.live = false), t.run());
    },
  };
}

const thread = (id: string): TabRole => ({ kind: 'thread', thread: id });
const main: TabRole = { kind: 'main' };

describe('the anchored set a main tab keeps', () => {
  test('a thread tab that loads after the main tab is anchored at once; a main tab loading later pings and learns it', () => {
    const w = world();
    const early = w.tab('main-1', main);
    w.tab('thr-tab-a', thread('thr_a'));
    expect([...early.anchored()]).toEqual(['thr_a']);
    const late = w.tab('main-2', main);
    expect([...late.anchored()]).toEqual(['thr_a']);
  });

  test('a tab that says it is gone is not anchored any more; a thread tab itself holds no set', () => {
    const w = world();
    const m = w.tab('main-1', main);
    const t = w.tab('thr-tab-a', thread('thr_a'));
    expect(t.anchored().size).toBe(0);
    t.close();
    expect(m.anchored().size).toBe(0);
  });

  test('a tab not heard from for three beats expires; hearing it again keeps it', () => {
    const w = world();
    const m = w.tab('main-1', main);
    const t = w.tab('thr-tab-a', thread('thr_a'));
    w.advance(ANCHOR_TTL_MS - 1);
    t.beat();
    w.advance(ANCHOR_TTL_MS - 1);
    expect([...m.anchored()]).toEqual(['thr_a']);
    w.advance(2);
    expect(m.anchored().size).toBe(0);
  });

  test('listeners hear a change once, not on every beat', () => {
    const w = world();
    const m = w.tab('main-1', main);
    let heard = 0;
    m.subscribe(() => heard++);
    const t = w.tab('thr-tab-a', thread('thr_a'));
    t.beat();
    t.beat();
    expect(heard).toBe(1);
    t.close();
    expect(heard).toBe(2);
  });

  test('a thread tab that goes to the full Inbox is no longer anchored', () => {
    const w = world();
    const m = w.tab('main-1', main);
    const t = w.tab('thr-tab-a', thread('thr_a'));
    t.setRole(main);
    expect(m.anchored().size).toBe(0);
  });
});

describe('a thread tab asks the main tab to open a link', () => {
  test('only the most recently used main tab opens it, and the asker is acked', () => {
    const w = world();
    const a = w.tab('main-a', main);
    w.advance(10);
    const b = w.tab('main-b', main);
    const t = w.tab('thr-tab-a', thread('thr_a'));
    w.advance(10);
    a.used();
    let unanswered = 0;
    t.requestOpen('#thread=thr_z', () => unanswered++);
    expect(w.opened).toEqual(['main-a:#thread=thr_z']);
    w.advance(OPEN_ACK_MS + 1);
    expect(unanswered).toBe(0);
    // Focus moves to the other: it answers the next one.
    w.advance(10);
    b.used();
    t.requestOpen('#thread=thr_y', () => unanswered++);
    expect(w.opened).toEqual(['main-a:#thread=thr_z', 'main-b:#thread=thr_y']);
  });

  test('with no main tab, nobody answers and the asker opens it itself after the wait', () => {
    const w = world();
    const t = w.tab('thr-tab-a', thread('thr_a'));
    w.tab('thr-tab-b', thread('thr_b'));
    let unanswered = 0;
    t.requestOpen('#thread=thr_z', () => unanswered++);
    w.advance(OPEN_ACK_MS - 1);
    expect(unanswered).toBe(0);
    w.advance(2);
    expect(unanswered).toBe(1);
    expect(w.opened).toEqual([]);
  });

  test('a main tab that closed does not hold the answer', () => {
    const w = world();
    const a = w.tab('main-a', main);
    w.advance(10);
    const b = w.tab('main-b', main);
    b.used();
    b.close();
    const t = w.tab('thr-tab-a', thread('thr_a'));
    t.requestOpen('#thread=thr_z', () => {});
    expect(w.opened).toEqual(['main-a:#thread=thr_z']);
    expect(a.anchored().size).toBe(1);
  });
});

describe('the channel reads only what it knows', () => {
  test('a malformed message is dropped, a known one kept', () => {
    expect(parseTabMessage({ type: 'thread', tab: 'x', thread: '' })).toBeNull();
    expect(parseTabMessage({ type: 'main', tab: 'x', usedAt: 'now' })).toBeNull();
    expect(parseTabMessage({ type: 'nope' })).toBeNull();
    expect(parseTabMessage(null)).toBeNull();
    expect(parseTabMessage({ type: 'open-in-main', id: 'i', route: '#thread=t' })).toEqual({ type: 'open-in-main', id: 'i', route: '#thread=t' });
  });
});

describe('what a click does', () => {
  const base = { enabled: true, anchored: new Set(['thr_a']), modified: false };
  test('off: nothing changes, whatever the click', () => {
    expect(routeClick({ ...base, enabled: false, role: main, thread: 'thr_a', modified: true })).toBe('default');
    expect(routeClick({ ...base, enabled: false, role: thread('thr_b'), thread: 'thr_a' })).toBe('default');
  });
  test('main tab: ⌘-click opens a thread tab; a plain click on an anchored thread focuses it; any other is as before', () => {
    expect(routeClick({ ...base, role: main, thread: 'thr_x', modified: true })).toBe('open-alone');
    expect(routeClick({ ...base, role: main, thread: 'thr_a' })).toBe('focus-anchored');
    expect(routeClick({ ...base, role: main, thread: 'thr_x' })).toBe('default');
    expect(routeClick({ ...base, role: main, thread: null, modified: true })).toBe('default');
  });
  test('thread tab: any plain click to another thread or page goes to the main tab; its own thread and ⌘-clicks are as before', () => {
    expect(routeClick({ ...base, role: thread('thr_b'), thread: 'thr_x' })).toBe('ask-main');
    expect(routeClick({ ...base, role: thread('thr_b'), thread: null })).toBe('ask-main');
    expect(routeClick({ ...base, role: thread('thr_b'), thread: 'thr_b' })).toBe('default');
    expect(routeClick({ ...base, role: thread('thr_b'), thread: 'thr_x', modified: true })).toBe('default');
  });
});

describe('the main tab\'s count', () => {
  const row = (id: string, unseen: number) => ({ thread_id: id, unseen, resolved_at: null }) as unknown as InboxListSection['threads'][number];
  const sections = [{ threads: [row('thr_a', 2), row('thr_b', 1), row('thr_c', 0)] }] as unknown as InboxListSection[];
  const anchored = new Set(['thr_a']);

  test('anchored threads are left out, unless the sub-option puts them back', () => {
    expect(inboxTabCount(sections)).toBe(2);
    expect(inboxTabCount(sections, excludedFromCounts(anchored, false))).toBe(1);
    expect(inboxTabCount(sections, excludedFromCounts(anchored, true))).toBe(2);
  });
});

describe('who notifies', () => {
  const anchored = new Set(['thr_a']);
  test('a thread tab notifies only for its own thread', () => {
    expect(notifiesThread({ alone: 'thr_a', anchored: new Set() }, 'thr_a')).toBe(true);
    expect(notifiesThread({ alone: 'thr_a', anchored: new Set() }, 'thr_b')).toBe(false);
  });
  test('a main tab skips anchored threads and raises the rest', () => {
    expect(notifiesThread({ alone: null, anchored }, 'thr_a')).toBe(false);
    expect(notifiesThread({ alone: null, anchored }, 'thr_b')).toBe(true);
  });
});
