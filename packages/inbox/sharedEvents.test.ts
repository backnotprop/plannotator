import { afterEach, expect, jest, test } from 'bun:test';
import type { InboxEventFrame, InboxEventHandlers, InboxEventWindow } from './api';
import { dispatchInboxFrame } from './api';
import {
  browserSharedEventsEnv,
  discardPreparedInboxEvents,
  EVENTS_CHANNEL,
  EVENTS_LOCK,
  prepareInboxEvents,
  inboxEventsServedBy,
  subscribeOwnInboxEvents,
  subscribeSharedInboxEvents,
  WINDOW_LOCK_PREFIX,
  type SharedEventsEnv,
} from './sharedEvents';

const tick = () => new Promise<void>((done) => setTimeout(done, 0));
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

interface Waiter {
  tab: number;
  callback: () => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
}

class FakeLocks {
  held = new Map<string, { tab: number; release: () => void; steal: () => void }>();
  queues = new Map<string, Waiter[]>();
  dead = new Set<number>();
  paused = new Map<number, (() => void)[]>();
  steals = 0;

  run(tab: number, fn: () => void): void {
    const waiting = this.paused.get(tab);
    if (waiting) waiting.push(fn);
    else fn();
  }

  managerFor(tab: number) {
    return {
      request: (name: string, options: { signal?: AbortSignal; steal?: boolean }, callback: () => unknown): Promise<unknown> =>
        new Promise((resolve, reject) => {
          if (this.dead.has(tab)) return;
          if (options.signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
          const waiter: Waiter = { tab, callback, resolve, reject, signal: options.signal };
          if (options.steal) {
            this.steals += 1;
            this.held.get(name)?.steal();
            const queue = this.queues.get(name) ?? [];
            queue.unshift(waiter);
            this.queues.set(name, queue);
            this.pump(name);
            return;
          }
          const queue = this.queues.get(name) ?? [];
          queue.push(waiter);
          this.queues.set(name, queue);
          options.signal?.addEventListener('abort', () => {
            const q = this.queues.get(name) ?? [];
            const at = q.indexOf(waiter);
            if (at >= 0) {
              q.splice(at, 1);
              reject(new DOMException('aborted', 'AbortError'));
            }
          });
          this.pump(name);
        }),
    };
  }

  private pump(name: string): void {
    if (this.held.has(name)) return;
    const queue = this.queues.get(name) ?? [];
    const next = queue.shift();
    if (!next) return;
    let released = false;
    let stolen = false;
    const release = () => {
      if (released) return;
      released = true;
      if (this.held.get(name)?.release === release) this.held.delete(name);
      setTimeout(() => this.pump(name), 0);
    };
    const steal = () => {
      if (released) return;
      stolen = true;
      released = true;
      this.held.delete(name);
      this.run(next.tab, () => next.reject(new DOMException('stolen', 'AbortError')));
    };
    this.held.set(name, { tab: next.tab, release, steal });
    setTimeout(() => {
      this.run(next.tab, () => {
        if (this.dead.has(next.tab) || stolen) return release();
        let out: unknown;
        try {
          out = next.callback();
        } catch (error) {
          release();
          return next.reject(error);
        }
        Promise.resolve(out).then(
          (value) => {
            if (stolen) return;
            release();
            next.resolve(value);
          },
          (error) => {
            if (stolen) return;
            release();
            next.reject(error);
          },
        );
      });
    }, 0);
  }

  kill(tab: number): void {
    this.dead.add(tab);
    for (const [name, queue] of this.queues) this.queues.set(name, queue.filter((w) => w.tab !== tab));
    for (const holder of [...this.held.values()]) if (holder.tab === tab) holder.release();
  }

  holder(name: string): number | null {
    return this.held.get(name)?.tab ?? null;
  }
}
class FakeHub {
  channels = new Set<FakeChannel>();
  constructor(readonly locks: FakeLocks) {}
  open(tab: number): FakeChannel {
    const channel = new FakeChannel(this, tab);
    this.channels.add(channel);
    return channel;
  }
  kill(tab: number): void {
    for (const c of this.channels) if (c.tab === tab) this.channels.delete(c);
  }
}

class FakeChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(
    private hub: FakeHub,
    readonly tab: number,
  ) {}
  postMessage(message: unknown): void {
    if (this.closed) throw new Error('closed');
    const data = structuredClone(message);
    for (const other of this.hub.channels) {
      if (other === this) continue;
      setTimeout(() => {
        this.hub.locks.run(other.tab, () => {
          if (!other.closed && this.hub.channels.has(other)) other.onmessage?.({ data });
        });
      }, 0);
    }
  }
  close(): void {
    this.closed = true;
    this.hub.channels.delete(this);
  }
}

class FakeServer {
  constructor(readonly locks: FakeLocks) {}
  seq = 0;
  lines: { seq: number; kind: string }[] = [];
  streams = new Set<{ tab: number; stalled: boolean; push: (frame: InboxEventFrame) => void }>();
  opened: { tab: number; cursor: number }[] = [];
  stalledTabs = new Set<number>();
  stallEverything = false;

  stall(tab: number | 'all', options: { andNew?: boolean } = {}): void {
    for (const stream of this.streams) if (tab === 'all' || stream.tab === tab) stream.stalled = true;
    if (options.andNew && tab === 'all') this.stallEverything = true;
    else if (options.andNew) this.stalledTabs.add(tab as number);
  }
  heal(): void {
    this.stalledTabs.clear();
    this.stallEverything = false;
  }

  write(count = 1): number[] {
    const written: number[] = [];
    for (let i = 0; i < count; i++) {
      const line = { seq: ++this.seq, kind: 'message' };
      this.lines.push(line);
      written.push(line.seq);
      for (const stream of this.streams) stream.push(this.frameOf(line));
    }
    return written;
  }
  frameOf(line: { seq: number; kind: string }): InboxEventFrame {
    return { name: 'record', id: String(line.seq), data: JSON.stringify({ seq: line.seq, kind: line.kind, id: `m${line.seq}`, message: {} }) };
  }
  broadcast(name: InboxEventFrame['name'], data: string): void {
    for (const stream of this.streams) stream.push({ name, data, id: null });
  }
  open(tab: number, cursor: number, onFrame: (frame: InboxEventFrame) => void): () => void {
    this.opened.push({ tab, cursor });
    let open = true;
    const stream = {
      tab,
      stalled: this.stallEverything || this.stalledTabs.has(tab),
      push: (frame: InboxEventFrame) => {
        if (stream.stalled) return;
        setTimeout(() => this.locks.run(tab, () => open && !stream.stalled && onFrame(frame)), 0);
      },
    };
    stream.push({ name: 'hello', data: JSON.stringify({ serverSession: 's', cursor: this.seq }), id: null });
    for (const line of this.lines) if (line.seq > cursor) stream.push(this.frameOf(line));
    this.streams.add(stream);
    return () => {
      open = false;
      this.streams.delete(stream);
    };
  }
  closeTab(tab: number): void {
    for (const s of [...this.streams]) if (s.tab === tab) this.streams.delete(s);
  }
}

interface Tab {
  id: number;
  win: InboxEventWindow;
  records: number[];
  connects: number;
  status: number;
  reach: number;
  deliveries: number;
  drafts: (string | null)[];
  gone: { window: string; unloading: boolean }[];
  listCatchUps: number;
  live: boolean[];
  visible: boolean;
  doc: EventTarget;
  win2: EventTarget;
  unsubscribe: () => void;
}

class World {
  locks = new FakeLocks();
  hub = new FakeHub(this.locks);
  server = new FakeServer(this.locks);
  catchUpFails = false;
  timing: SharedEventsEnv['timing'] = { pingEveryMs: 40, hiddenPingEveryMs: 150, pongTimeoutMs: 30, retryMs: 20, retryMaxMs: 80 };
  tabs = new Map<number, Tab>();
  gone: { by: number; window: string; unloading: boolean }[] = [];
  catchUps: { tab: number; cursor: number }[] = [];
  catchUpDelayMs = 0;
  next = 1;

  open(cursor = this.server.seq, options: { visible?: boolean; liveTimers?: SharedEventsEnv['liveTimers'] } = {}): Tab {
    const id = this.next++;
    const tab: Tab = {
      id,
      win: { id: `w-tab-${String(id).padStart(4, '0')}`, permission: 'granted', origin: 'http://localhost:1' },
      records: [],
      connects: 0,
      status: 0,
      reach: 0,
      deliveries: 0,
      drafts: [],
      gone: [],
      listCatchUps: 0,
      live: [],
      visible: options.visible ?? false,
      doc: new EventTarget(),
      win2: new EventTarget(),
      unsubscribe: () => {},
    };
    const handlers: InboxEventHandlers = {
      onRecord: (event) => {
        if (event) tab.records.push(event.seq);
      },
      onStatus: () => {
        tab.status += 1;
      },
      onReach: () => {
        tab.reach += 1;
      },
      onDeliveries: () => {
        tab.deliveries += 1;
      },
      onDrafts: (thread) => tab.drafts.push(thread),
      onConnect: () => {
        tab.connects += 1;
      },
      onCatchUp: () => {
        tab.listCatchUps += 1;
      },
      onLive: (live) => tab.live.push(live),
    };
    const env: SharedEventsEnv = {
      locks: this.locks.managerFor(id),
      channel: () => this.hub.open(id),
      open: (c, onFrame) => this.server.open(id, c, onFrame),
      catchUp: async (c) => {
        await tick();
        if (this.catchUpFails && this.catchUpDelayMs === 0) {
          this.catchUps.push({ tab: id, cursor: c });
          throw new Error('down');
        }
        this.catchUps.push({ tab: id, cursor: c });
        const frames = this.server.lines.filter((line) => line.seq > c).map((line) => this.server.frameOf(line));
        if (this.catchUpDelayMs > 0) await new Promise((done) => setTimeout(done, this.catchUpDelayMs));
        if (this.catchUpFails) {
          this.catchUps.push({ tab: id, cursor: c });
          throw new Error('down');
        }
        return frames;
      },
      dispatch: dispatchInboxFrame,
      sendGone: (window, unloading) => {
        tab.gone.push({ window, unloading });
        this.gone.push({ by: id, window, unloading });
      },
      lifecycle: { document: tab.doc, window: tab.win2 },
      isVisible: () => tab.visible,
      timing: this.timing,
      liveTimers: options.liveTimers,
    };
    tab.unsubscribe = subscribeSharedInboxEvents(cursor, handlers, tab.win, env);
    this.tabs.set(id, tab);
    return tab;
  }

  close(tab: Tab): void {
    const event = new Event('pagehide') as Event & { persisted: boolean };
    Object.defineProperty(event, 'persisted', { value: false });
    tab.win2.dispatchEvent(event);
    tab.unsubscribe();
    this.kill(tab);
  }

  kill(tab: Tab): void {
    this.locks.kill(tab.id);
    this.hub.kill(tab.id);
    this.server.closeTab(tab.id);
    this.tabs.delete(tab.id);
  }

  leader(): number | null {
    return this.locks.holder(EVENTS_LOCK);
  }

  pause(tab: Tab): void {
    if (!this.locks.paused.has(tab.id)) this.locks.paused.set(tab.id, []);
  }
  resume(tab: Tab): void {
    const waiting = this.locks.paused.get(tab.id) ?? [];
    this.locks.paused.delete(tab.id);
    for (const fn of waiting) fn();
  }
}

let worlds: World[] = [];
afterEach(() => {
  for (const world of worlds) for (const tab of world.tabs.values()) tab.unsubscribe();
  worlds = [];
});
function world(): World {
  const w = new World();
  worlds.push(w);
  return w;
}

function expectAll(tab: Tab, from: number, to: number): void {
  const want = Array.from({ length: to - from }, (_, i) => from + i + 1);
  expect(tab.records).toEqual(want);
}

test('one tab leads: one stream, every record once', async () => {
  const w = world();
  w.server.write(3);
  const a = w.open();
  await settle();
  expect(w.leader()).toBe(a.id);
  expect(w.server.streams.size).toBe(1);
  expect(w.server.opened).toEqual([{ tab: a.id, cursor: 3 }]);
  w.server.write(5);
  await settle();
  expectAll(a, 3, 8);
  expect(a.connects).toBe(1);
  expect(inboxEventsServedBy()).toBeNull();
});

test('three tabs and then twelve: one stream, every tab gets every record once, in order', async () => {
  const w = world();
  const tabs = [w.open(), w.open(), w.open()];
  await settle();
  expect(w.server.streams.size).toBe(1);
  w.server.write(10);
  await settle();
  for (const tab of tabs) expectAll(tab, 0, 10);
  for (let i = 0; i < 9; i++) tabs.push(w.open(w.server.seq));
  await settle();
  w.server.write(20);
  await settle(12);
  expect(w.server.streams.size).toBe(1);
  expect(w.server.opened).toHaveLength(1);
  for (const tab of tabs.slice(0, 3)) expectAll(tab, 0, 30);
  for (const tab of tabs.slice(3)) expectAll(tab, 10, 30);
});

test('records at or before a tab\'s cursor are skipped (its list read had them); the rest arrive once', async () => {
  const w = world();
  const a = w.open(0);
  await settle();
  w.server.write(5);
  await settle();
  const b = w.open(3);
  w.server.write(2);
  await settle();
  expectAll(a, 0, 7);
  expect(b.records.every((seq) => seq > 3)).toBe(true);
  expect(new Set(b.records).size).toBe(b.records.length);
  expect(b.records.at(-1)).toBe(7);
});

test('followers name the leader; they report again when it changes; hello reaches every tab', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const b = w.open();
  await settle();
  expect(b.connects).toBeGreaterThanOrEqual(1);
  expect(inboxEventsServedBy()).toBe(a.win.id);
  const before = b.connects;
  w.close(a);
  await settle(12);
  expect(w.leader()).toBe(b.id);
  expect(b.connects).toBeGreaterThan(before);
  expect(inboxEventsServedBy()).toBeNull();
});

test('status, reach, deliveries and drafts reach every tab once', async () => {
  const w = world();
  const tabs = [w.open(), w.open(), w.open(), w.open()];
  await settle();
  w.server.broadcast('status', JSON.stringify({ update: null, updated: null }));
  w.server.broadcast('reach', JSON.stringify({ enabled: true, windows: 4, allowed: 4, allowed_origins: [] }));
  w.server.broadcast('deliveries', '{}');
  w.server.broadcast('drafts', JSON.stringify({ thread_id: 'msg_x' }));
  await settle();
  for (const tab of tabs) {
    expect(tab.status).toBe(1);
    expect(tab.reach).toBe(1);
    expect(tab.deliveries).toBe(1);
    expect(tab.drafts).toEqual(['msg_x']);
  }
});

test('the leader closes while an agent writes: the next tab leads at once, nothing missed or twice', async () => {
  const w = world();
  const tabs = [w.open(), w.open(), w.open()];
  await settle();
  const leader = tabs.find((t) => t.id === w.leader())!;
  w.server.write(5);
  setTimeout(() => w.server.write(3), 0);
  w.close(leader);
  w.server.write(2);
  await settle(4);
  w.server.write(4);
  await settle(16);
  expect(w.server.streams.size).toBe(1);
  expect(w.leader()).not.toBe(leader.id);
  for (const tab of tabs) if (tab !== leader) expectAll(tab, 0, w.server.seq);
  expect(w.gone).toContainEqual({ by: leader.id, window: leader.win.id, unloading: true });
});

test('the leader crashes (no pagehide, no unsubscribe): the next tab leads from the last seq it saw', async () => {
  const w = world();
  const tabs = [w.open(), w.open(), w.open()];
  await settle();
  w.server.write(4);
  await settle();
  const leader = tabs.find((t) => t.id === w.leader())!;
  w.kill(leader);
  w.server.write(3);
  await settle(16);
  w.server.write(2);
  await settle(8);
  expect(w.server.streams.size).toBe(1);
  const next = w.server.opened.at(-1)!;
  expect(next.cursor).toBe(4);
  for (const tab of tabs) if (tab !== leader) expectAll(tab, 0, 9);
});

test('the leader tells the server when a follower is gone: a crash (its lock freed) and a close', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const b = w.open();
  const c = w.open();
  await settle(10);
  w.kill(b);
  await settle(6);
  expect(w.gone).toContainEqual({ by: a.id, window: b.win.id, unloading: false });
  w.close(c);
  await settle(6);
  expect(w.gone).toContainEqual({ by: c.id, window: c.win.id, unloading: true });
  expect(w.gone.filter((g) => g.window === c.win.id && g.by === a.id)).toHaveLength(1);
  expect(w.gone.some((g) => g.by === a.id && g.window === a.win.id)).toBe(false);
});

test('a leader still running after its pagehide reports nothing more: the next leader\'s announcement and hello do not count it again', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const b = w.open();
  await settle(10);
  expect(w.leader()).toBe(a.id);
  const connects = a.connects;
  const hide = new Event('pagehide');
  Object.defineProperty(hide, 'persisted', { value: false });
  a.win2.dispatchEvent(hide);
  w.server.write(2);
  await settle(16);
  expect(w.leader()).toBe(b.id);
  expect(w.gone).toContainEqual({ by: a.id, window: a.win.id, unloading: true });
  expect(a.connects).toBe(connects);
  w.kill(a);
});

test('a frozen leader steps down so another leads; it queues again when it resumes, as a follower', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const b = w.open();
  await settle(8);
  expect(w.leader()).toBe(a.id);
  a.doc.dispatchEvent(new Event('freeze'));
  w.server.write(3);
  await settle(12);
  expect(w.leader()).toBe(b.id);
  expect(w.server.streams.size).toBe(1);
  a.doc.dispatchEvent(new Event('resume'));
  w.server.write(2);
  await settle(12);
  expect(w.leader()).toBe(b.id);
  expect(w.server.streams.size).toBe(1);
  expectAll(a, 0, 5);
  expectAll(b, 0, 5);
  w.close(b);
  w.server.write(1);
  await settle(12);
  expect(w.leader()).toBe(a.id);
  expectAll(a, 0, 6);
});

test('a frozen follower is not a candidate: the leader closing while it sleeps hands the stream to a tab that is awake', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const b = w.open();
  const c = w.open();
  await settle(8);
  b.doc.dispatchEvent(new Event('freeze'));
  await settle();
  w.close(a);
  await settle(12);
  expect(w.leader()).toBe(c.id);
  b.doc.dispatchEvent(new Event('resume'));
  w.server.write(2);
  await settle(12);
  expectAll(b, 0, 2);
  expectAll(c, 0, 2);
});

test('the back/forward cache: pagehide (persisted) steps down and says gone; pageshow joins again and reports', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const b = w.open();
  await settle(8);
  const hidden = a.connects;
  const hide = new Event('pagehide');
  Object.defineProperty(hide, 'persisted', { value: true });
  a.win2.dispatchEvent(hide);
  await settle(10);
  expect(w.leader()).toBe(b.id);
  expect(w.gone).toContainEqual({ by: a.id, window: a.win.id, unloading: true });
  expect(a.connects).toBe(hidden);
  const connects = a.connects;
  const show = new Event('pageshow');
  Object.defineProperty(show, 'persisted', { value: true });
  a.win2.dispatchEvent(show);
  w.server.write(2);
  await settle(12);
  expect(a.connects).toBeGreaterThan(connects);
  expectAll(a, 0, 2);
  expect(w.server.streams.size).toBe(1);
  const restored = a.connects;
  w.kill(b);
  await settle(16);
  expect(w.leader()).toBe(a.id);
  expect(a.connects).toBeGreaterThan(restored);
});

test('a sleeping follower behind a new leader that started past it fetches the lines between, once, in order', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const f = w.open();
  await settle(8);
  f.doc.dispatchEvent(new Event('freeze'));
  w.kill(a);
  w.server.write(3);
  const n = w.open(w.server.seq);
  await settle(10);
  expect(w.leader()).toBe(n.id);
  expect(w.server.opened.at(-1)!.cursor).toBe(3);
  w.server.write(2);
  await settle(6);
  f.doc.dispatchEvent(new Event('resume'));
  await settle(12);
  expectAll(f, 0, 5);
  expect(w.catchUps.some((c) => c.tab === f.id && c.cursor === 0)).toBe(true);
});

test('a follower that subscribed with a cursor behind the leader\'s start catches up from the leader\'s answer', async () => {
  const w = world();
  const a = w.open();
  await settle();
  w.kill(a);
  w.server.write(4);
  const n = w.open(4);
  await settle(8);
  const late = w.open(1);
  w.server.write(1);
  await settle(12);
  expectAll(late, 1, 5);
  expectAll(n, 4, 5);
});

test('a catch-up that fails (the Inbox restarting) is tried again at the next hello', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const f = w.open();
  await settle(8);
  let failing = true;
  const tabCatchUp = w.catchUps;
  void tabCatchUp;
  const realLines = w.server.lines;
  f.doc.dispatchEvent(new Event('freeze'));
  w.server.write(2);
  const originalFilter = realLines.filter.bind(realLines);
  (realLines as unknown as { filter: unknown }).filter = (...args: Parameters<typeof originalFilter>) => {
    if (failing) throw new Error('down');
    return originalFilter(...args);
  };
  f.doc.dispatchEvent(new Event('resume'));
  await settle(10);
  failing = false;
  w.server.closeTab(a.id);
  w.server.open(a.id, w.server.seq, (frame) => {
    w.hub.channels.forEach((c) => {
      if (c.tab === a.id) c.postMessage({ v: 1, type: 'frame', leader: a.win.id, frame });
    });
  });
  await settle(12);
  expectAll(f, 0, 2);
});

test('a new leader while a catch-up is in flight: the tab fetches again before it goes on, nothing missed', async () => {
  const w = world();
  const a = w.open();
  await settle();
  w.server.write(2);
  await settle();
  const n = w.open(w.server.seq);
  await settle(6);
  w.catchUpDelayMs = 60;
  const f = w.open(0);
  await settle(4);
  w.kill(a);
  w.server.write(3);
  await settle(6);
  await new Promise((done) => setTimeout(done, 250));
  w.catchUpDelayMs = 0;
  w.server.write(1);
  await settle(12);
  expect(w.leader()).toBe(n.id);
  expectAll(f, 0, 6);
  expectAll(n, 2, 6);
  expect(w.catchUps.filter((c) => c.tab === f.id).length).toBeGreaterThanOrEqual(2);
});

test('a leader whose main thread stops (no freeze) loses the stream to a visible follower; it follows when it runs again', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const b = w.open(w.server.seq, { visible: true });
  const c = w.open(w.server.seq);
  await settle(10);
  expect(w.leader()).toBe(a.id);
  w.server.write(2);
  await settle(8);
  w.pause(a);
  w.server.write(3);
  let peak = 0;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && !(b.records.length === 5 && c.records.length === 5)) {
    peak = Math.max(peak, w.server.streams.size);
    await new Promise((done) => setTimeout(done, 5));
  }
  expect(w.locks.steals).toBe(1);
  expect(w.leader()).toBe(b.id);
  expectAll(b, 0, 5);
  expectAll(c, 0, 5);
  expect(peak).toBeLessThanOrEqual(2);
  w.server.write(2);
  await settle(8);
  expectAll(c, 0, 7);
  w.resume(a);
  await settle(20);
  expect(w.server.streams.size).toBe(1);
  expect(w.leader()).toBe(b.id);
  w.server.write(1);
  await settle(12);
  expectAll(a, 0, 8);
  expectAll(b, 0, 8);
  expectAll(c, 0, 8);
  w.close(b);
  w.server.write(1);
  await settle(16);
  expect([a.id, c.id] as (number | null)[]).toContain(w.leader());
  expectAll(a, 0, 9);
  expectAll(c, 0, 9);
});

test('a leader that answers is never taken over, however often visible followers check', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const followers = [w.open(w.server.seq, { visible: true }), w.open(w.server.seq, { visible: true })];
  for (let i = 0; i < 10; i++) {
    w.server.write(1);
    await new Promise((done) => setTimeout(done, 25));
  }
  expect(w.locks.steals).toBe(0);
  expect(w.leader()).toBe(a.id);
  for (const f of followers) expectAll(f, 0, 10);
});

test('hidden followers check on a stopped leader less often; one that becomes visible checks at once', async () => {
  const w = world();
  w.timing = { ...w.timing, hiddenPingEveryMs: 60_000 };
  const a = w.open();
  await settle();
  const b = w.open();
  await settle(8);
  w.pause(a);
  w.server.write(2);
  await new Promise((done) => setTimeout(done, 200));
  expect(w.locks.steals).toBe(0);
  expect(b.records).toEqual([]);
  b.visible = true;
  b.doc.dispatchEvent(new Event('visibilitychange'));
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && b.records.length < 2) await new Promise((done) => setTimeout(done, 5));
  expect(w.locks.steals).toBe(1);
  expectAll(b, 0, 2);
  w.resume(a);
  await settle(20);
  expect(w.server.streams.size).toBe(1);
});

test('with every tab hidden, a stopped leader is still taken over (at the hidden pace), so notifications are not owed for long', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const b = w.open();
  const c = w.open();
  await settle(8);
  const pausedAt = Date.now();
  w.pause(a);
  w.server.write(2);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && (b.records.length < 2 || c.records.length < 2)) await new Promise((done) => setTimeout(done, 5));
  const tookMs = Date.now() - pausedAt;
  expectAll(b, 0, 2);
  expectAll(c, 0, 2);
  expect(tookMs).toBeGreaterThanOrEqual(100);
  expect(w.locks.steals).toBeGreaterThanOrEqual(1);
  w.resume(a);
  await settle(20);
  expect(w.server.streams.size).toBe(1);
  w.server.write(1);
  await settle(12);
  for (const t of [a, b, c]) expectAll(t, 0, 3);
});

test('a catch-up that fails keeps the gap: the frames that came meanwhile wait, and the retry fetches from the old seq', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const f = w.open();
  await settle(8);
  f.doc.dispatchEvent(new Event('freeze'));
  w.pause(f);
  w.server.write(2);
  await settle(6);
  w.locks.paused.delete(f.id);
  w.catchUpFails = true;
  f.doc.dispatchEvent(new Event('resume'));
  await settle(6);
  w.server.write(2);
  await settle(6);
  expect(f.records).toEqual([]);
  w.catchUpFails = false;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && f.records.length < 4) await new Promise((done) => setTimeout(done, 5));
  expectAll(f, 0, 4);
  expect(w.catchUps.filter((c) => c.tab === f.id).every((c) => c.cursor === 0)).toBe(true);
  expectAll(a, 0, 4);
});

test('a tab that comes to lead while its catch-up runs, and the catch-up then fails, handles its own stream (it holds nothing back)', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const f = w.open();
  await settle(8);
  f.doc.dispatchEvent(new Event('freeze'));
  w.server.write(2);
  w.catchUpDelayMs = 60;
  w.catchUpFails = true;
  f.doc.dispatchEvent(new Event('resume'));
  await settle(4);
  w.kill(a);
  await settle(10);
  expect(w.leader()).toBe(f.id);
  await new Promise((done) => setTimeout(done, 120));
  w.catchUpDelayMs = 0;
  w.server.write(5);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && f.records.length < 7) await new Promise((done) => setTimeout(done, 5));
  expectAll(f, 0, 7);
  w.server.write(1);
  await settle(8);
  expectAll(f, 0, 8);
  expect(w.server.streams.size).toBe(1);
});

test('discardPreparedInboxEvents closes the early channel when no subscription follows', async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { BroadcastChannel: g.BroadcastChannel, EventSource: g.EventSource, navigator: g.navigator };
  const closed: string[] = [];
  class Channel {
    onmessage: unknown = null;
    constructor(readonly name: string) {}
    postMessage() {}
    close() {
      closed.push(this.name);
    }
  }
  try {
    g.BroadcastChannel = Channel;
    g.EventSource = class {};
    Object.defineProperty(globalThis, 'navigator', { value: { locks: { request: () => Promise.resolve() } }, configurable: true });
    prepareInboxEvents();
    discardPreparedInboxEvents();
    expect(closed).toEqual([EVENTS_CHANNEL]);
    discardPreparedInboxEvents();
    expect(closed).toHaveLength(1);
  } finally {
    g.BroadcastChannel = saved.BroadcastChannel;
    g.EventSource = saved.EventSource;
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true });
  }
});

test('a frame that reached the early channel before the subscription: the report it starts names the leader', async () => {
  const w = world();
  const a = w.open();
  await settle();
  expect(w.leader()).toBe(a.id);
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { BroadcastChannel: g.BroadcastChannel, EventSource: g.EventSource, navigator: g.navigator, document: g.document, window: g.window };
  const tabId = 99;
  const servedAtConnect: (string | null)[] = [];
  let unsubscribe = () => {};
  try {
    g.BroadcastChannel = function (this: unknown) {
      return w.hub.open(tabId);
    };
    g.EventSource = class {};
    g.document = new EventTarget();
    g.window = new EventTarget();
    Object.defineProperty(globalThis, 'navigator', { value: { locks: w.locks.managerFor(tabId) }, configurable: true });
    prepareInboxEvents();
    w.server.broadcast('reach', JSON.stringify({ enabled: true, windows: 1, allowed: 1, allowed_origins: [] }));
    await settle();
    const win: InboxEventWindow = { id: 'w-tab-early-0099', permission: 'granted', origin: 'http://localhost:1' };
    const env: SharedEventsEnv = {
      ...browserSharedEventsEnv({ open: (c, onFrame) => w.server.open(tabId, c, onFrame), dispatch: dispatchInboxFrame }),
      catchUp: async (c) => w.server.lines.filter((line) => line.seq > c).map((line) => w.server.frameOf(line)),
      sendGone: () => {},
      lifecycle: null,
    };
    unsubscribe = subscribeSharedInboxEvents(w.server.seq, {
      onRecord: () => {},
      onStatus: () => {},
      onConnect: () => {
        servedAtConnect.push(inboxEventsServedBy());
      },
    }, win, env);
    await settle(12);
    expect(servedAtConnect.length).toBeGreaterThanOrEqual(1);
    expect(servedAtConnect).toEqual(servedAtConnect.map(() => a.win.id));
    expect(w.server.streams.size).toBe(1);
  } finally {
    unsubscribe();
    discardPreparedInboxEvents();
    g.BroadcastChannel = saved.BroadcastChannel;
    g.EventSource = saved.EventSource;
    g.document = saved.document;
    g.window = saved.window;
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true });
  }
});

test('the channel ignores what is not its own shape', async () => {
  const w = world();
  const a = w.open();
  await settle();
  const stranger = w.hub.open(999);
  for (const junk of [null, 1, 'x', { v: 2, type: 'frame' }, { v: 1, type: 'frame', leader: 'x', frame: { name: 'record', data: 1, id: null } }, { v: 1, type: 'join' }, { v: 1, type: 'nope' }]) {
    stranger.postMessage(junk);
  }
  await settle();
  expect(a.records).toEqual([]);
  expect(w.server.streams.size).toBe(1);
  void EVENTS_CHANNEL;
  void WINDOW_LOCK_PREFIX;
});

test('unsubscribe frees everything: the stream, the leader lock, the window lock', async () => {
  const w = world();
  const a = w.open();
  await settle();
  a.unsubscribe();
  await settle();
  expect(w.server.streams.size).toBe(0);
  expect(w.leader()).toBeNull();
  expect(w.locks.holder(WINDOW_LOCK_PREFIX + a.win.id)).toBeNull();
});

test('a random life of tabs (opens, closes, crashes, freezes) with an agent writing throughout: one stream, every record once per tab', async () => {
  let seed = 20261021;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let round = 0; round < 40; round++) {
    const w = world();
    const live: { tab: Tab; from: number; frozen: boolean }[] = [];
    for (let i = 0; i < 2; i++) live.push({ tab: w.open(), from: w.server.seq, frozen: false });
    await settle();
    for (let step = 0; step < 60; step++) {
      const roll = random();
      if (roll < 0.3) w.server.write(1 + Math.floor(random() * 3));
      else if (roll < 0.5 && live.length < 12) live.push({ tab: w.open(w.server.seq), from: w.server.seq, frozen: false });
      else if (roll < 0.62 && live.length > 1) {
        const [gone] = live.splice(Math.floor(random() * live.length), 1);
        w.close(gone!.tab);
      } else if (roll < 0.72 && live.length > 1) {
        const [gone] = live.splice(Math.floor(random() * live.length), 1);
        w.kill(gone!.tab);
      } else if (roll < 0.85) {
        const one = live[Math.floor(random() * live.length)]!;
        one.tab.doc.dispatchEvent(new Event(one.frozen ? 'resume' : 'freeze'));
        one.frozen = !one.frozen;
      }
      if (random() < 0.5) await tick();
      else await settle(3);
      expect(w.server.streams.size).toBeLessThanOrEqual(1);
    }
    for (const one of live) if (one.frozen) one.tab.doc.dispatchEvent(new Event('resume'));
    w.server.write(2);
    await settle(30);
    expect(w.server.streams.size).toBe(1);
    for (const one of live) {
      const want = Array.from({ length: w.server.seq - one.from }, (_, i) => one.from + i + 1);
      expect(one.tab.records).toEqual(want);
    }
  }
}, 120_000);

test('a random life with leaders stopping (no freeze) and tabs shown and hidden: at most two streams, every record once per tab', async () => {
  let seed = 7_2026_1021;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let steals = 0;
  for (let round = 0; round < 30; round++) {
    const w = world();
    const live: { tab: Tab; from: number; frozen: boolean }[] = [];
    let paused: Tab | null = null;
    for (let i = 0; i < 3; i++) live.push({ tab: w.open(w.server.seq, { visible: random() < 0.5 }), from: w.server.seq, frozen: false });
    await settle();
    for (let step = 0; step < 50; step++) {
      const roll = random();
      if (roll < 0.3) w.server.write(1 + Math.floor(random() * 3));
      else if (roll < 0.42 && live.length < 10) live.push({ tab: w.open(w.server.seq, { visible: random() < 0.5 }), from: w.server.seq, frozen: false });
      else if (roll < 0.5 && live.length > 2) {
        const at = Math.floor(random() * live.length);
        if (live[at]!.tab !== paused) w.close(live.splice(at, 1)[0]!.tab);
      } else if (roll < 0.62) {
        if (paused) {
          w.resume(paused);
          paused = null;
        } else {
          const leading = live.find((one) => one.tab.id === w.leader() && !one.frozen);
          if (leading) {
            paused = leading.tab;
            w.pause(paused);
          }
        }
      } else if (roll < 0.75) {
        const one = live[Math.floor(random() * live.length)]!;
        one.tab.visible = !one.tab.visible;
        one.tab.doc.dispatchEvent(new Event('visibilitychange'));
      } else if (roll < 0.86) {
        w.catchUpFails = !w.catchUpFails;
        w.catchUpDelayMs = random() < 0.5 ? 0 : 30;
      } else if (roll < 0.92) {
        const one = live[Math.floor(random() * live.length)]!;
        if (one.tab !== paused) {
          one.tab.doc.dispatchEvent(new Event(one.frozen ? 'resume' : 'freeze'));
          one.frozen = !one.frozen;
        }
      }
      await new Promise((done) => setTimeout(done, random() < 0.5 ? 0 : 15));
      expect(w.server.streams.size).toBeLessThanOrEqual(2);
    }
    if (paused) w.resume(paused);
    w.catchUpFails = false;
    w.catchUpDelayMs = 0;
    for (const one of live) if (one.frozen) one.tab.doc.dispatchEvent(new Event('resume'));
    w.server.write(2);
    await new Promise((done) => setTimeout(done, 300));
    await settle(30);
    steals += w.locks.steals;
    expect(w.server.streams.size).toBe(1);
    for (const one of live) {
      const want = Array.from({ length: w.server.seq - one.from }, (_, i) => one.from + i + 1);
      expect(one.tab.records).toEqual(want);
    }
  }
  expect(steals).toBeGreaterThan(5);
}, 120_000);

const STEP_MS = 50;
const BEAT_MS = 10_000;

const fakeTimerTest = test.skipIf(typeof document !== 'undefined');

function silenceWorld() {
  jest.useFakeTimers();
  const w = world();
  w.timing = undefined;
  let clock = 0;
  const beat = { on: true };
  const pass = async (ms: number) => {
    for (let t = 0; t < ms; t += STEP_MS) {
      jest.advanceTimersByTime(STEP_MS);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      clock += STEP_MS;
      if (beat.on && clock % BEAT_MS === 0) w.server.broadcast('heartbeat', '{}');
    }
  };
  const done = () => {
    for (const tab of w.tabs.values()) tab.unsubscribe();
    jest.useRealTimers();
  };
  return { w, pass, done, beat };
}

function sleepyTimers() {
  let asleep = false;
  let waiting: (() => void)[] = [];
  const timers: NonNullable<SharedEventsEnv['liveTimers']> = {
    setTimeout: (fn, ms) => {
      const timer = { cancelled: false, id: null as ReturnType<typeof setTimeout> | null };
      const run = () => {
        if (!timer.cancelled) fn();
      };
      timer.id = setTimeout(() => (asleep ? waiting.push(run) : run()), ms);
      return timer;
    },
    clearTimeout: (handle) => {
      const timer = handle as { cancelled: boolean; id: ReturnType<typeof setTimeout> | null };
      timer.cancelled = true;
      if (timer.id !== null) clearTimeout(timer.id);
    },
  };
  return {
    timers,
    sleep: () => {
      asleep = true;
    },
    wake: () => {
      asleep = false;
      const due = waiting;
      waiting = [];
      for (const fn of due) fn();
    },
  };
}

fakeTimerTest('healthy: five minutes of heartbeats with a leader and two followers: one stream, no reopen, no steal, no catch-up, no note', async () => {
  const { w, pass, done } = silenceWorld();
  try {
    const a = w.open();
    await pass(500);
    const b = w.open(w.server.seq, { visible: true });
    const c = w.open(w.server.seq);
    await pass(500);
    for (let minute = 0; minute < 5; minute++) {
      w.server.write(1);
      await pass(60_000);
    }
    expect(w.leader()).toBe(a.id);
    expect(w.server.opened).toHaveLength(1);
    expect(w.locks.steals).toBe(0);
    for (const tab of [a, b, c]) {
      expect(tab.listCatchUps).toBe(0);
      expect(tab.live).toEqual([]);
      expectAll(tab, 0, 5);
    }
    b.visible = false;
    b.doc.dispatchEvent(new Event('visibilitychange'));
    await pass(BEAT_MS);
    b.visible = true;
    b.doc.dispatchEvent(new Event('visibilitychange'));
    await pass(STEP_MS);
    expect(b.listCatchUps).toBe(0);
  } finally {
    done();
  }
});

fakeTimerTest('the leader\'s stream dies silently while it runs: it opens the stream again within the window, nobody takes it, nothing missed, no note', async () => {
  const { w, pass, done } = silenceWorld();
  try {
    const a = w.open();
    await pass(500);
    const b = w.open(w.server.seq, { visible: true });
    await pass(500);
    w.server.write(2);
    await pass(1_000);
    w.server.stall(a.id);
    w.server.write(3);
    await pass(5_000);
    expect(a.records).toEqual([1, 2]);
    expect(b.records).toEqual([1, 2]);
    await pass(30_000);
    expect(w.server.opened.map((o) => o.cursor)).toEqual([0, 2]);
    expect(w.server.opened.every((o) => o.tab === a.id)).toBe(true);
    expect(w.leader()).toBe(a.id);
    expect(w.locks.steals).toBe(0);
    expectAll(a, 0, 5);
    expectAll(b, 0, 5);
    expect(a.listCatchUps).toBe(1);
    expect(b.listCatchUps).toBe(0);
    expect(a.live).toEqual([]);
    expect(b.live).toEqual([]);
    await pass(2 * 60_000);
    expect(w.server.opened).toHaveLength(2);
    expect(a.listCatchUps).toBe(1);
  } finally {
    done();
  }
});

function throttledTimers(base: number): NonNullable<SharedEventsEnv['liveTimers']> {
  return {
    setTimeout: (fn, ms) => {
      const due = Date.now() + ms;
      const at = base + Math.ceil((due - base) / 60_000) * 60_000;
      return setTimeout(fn, Math.max(0, at - Date.now()));
    },
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}

fakeTimerTest('the leader dies without noticing (hidden, its timers held back a minute, its stream silent): the follower takes the stream within its window; no loop after', async () => {
  const { w, pass, done } = silenceWorld();
  try {
    const a = w.open(w.server.seq, { liveTimers: throttledTimers(Date.now()) });
    await pass(500);
    const b = w.open(w.server.seq, { visible: true });
    await pass(1_000);
    w.server.write(1);
    await pass(1_000);
    w.server.stall(a.id);
    w.server.write(2);
    await pass(40_000);
    expect(w.leader()).toBe(b.id);
    expect(w.locks.steals).toBe(1);
    expect(w.server.opened.filter((o) => o.tab === b.id)).toEqual([{ tab: b.id, cursor: 1 }]);
    w.server.write(2);
    await pass(1_000);
    expectAll(a, 0, 5);
    expectAll(b, 0, 5);
    expect(a.live).toEqual([]);
    expect(b.live).toEqual([]);
    expect(b.listCatchUps).toBe(1);
    await pass(3 * 60_000);
    expect(w.leader()).toBe(b.id);
    expect(w.locks.steals).toBe(1);
    expect(a.listCatchUps).toBe(0);
    expect(b.listCatchUps).toBe(1);
  } finally {
    done();
  }
});

fakeTimerTest('the computer sleeps and wakes: the leader reopens at once, the followers wait their grace and take nothing; no list is read but the leader\'s', async () => {
  const { w, pass, done, beat } = silenceWorld();
  try {
    const clocks = [sleepyTimers(), sleepyTimers(), sleepyTimers()];
    const a = w.open(w.server.seq, { liveTimers: clocks[0]!.timers });
    await pass(500);
    const b = w.open(w.server.seq, { visible: true, liveTimers: clocks[1]!.timers });
    const c = w.open(w.server.seq, { liveTimers: clocks[2]!.timers });
    await pass(30_000);
    beat.on = false;
    for (const clock of clocks) clock.sleep();
    await pass(10 * 60_000);
    beat.on = true;
    clocks[1]!.wake();
    clocks[2]!.wake();
    clocks[0]!.wake();
    await pass(10_000);
    expect(w.locks.steals).toBe(0);
    expect(w.leader()).toBe(a.id);
    for (const tab of [a, b, c]) expect(tab.live).toEqual([]);
    expect(b.listCatchUps).toBe(0);
    expect(c.listCatchUps).toBe(0);
    w.server.write(1);
    await pass(1_000);
    for (const tab of [a, b, c]) expect(tab.records.at(-1)).toBe(w.server.seq);
  } finally {
    done();
  }
});

fakeTimerTest('every stream held back (a proxy), five tabs: no follower takes the stream from a leader at work on it; each tab says "Reconnecting…" once, catches up once a window, and is live again when the stream comes back', async () => {
  const { w, pass, done } = silenceWorld();
  try {
    const a = w.open();
    await pass(500);
    const followers = [w.open(w.server.seq, { visible: true }), w.open(w.server.seq), w.open(w.server.seq), w.open(w.server.seq)];
    const tabs = [a, ...followers];
    await pass(1_000);
    w.server.stall('all', { andNew: true });
    w.server.write(2);
    await pass(2 * 60_000);
    expect(w.locks.steals).toBe(0);
    expect(w.leader()).toBe(a.id);
    expect(w.server.opened.every((o) => o.tab === a.id)).toBe(true);
    expect(w.server.opened.length).toBeLessThanOrEqual(6);
    for (const tab of tabs) {
      expect(tab.live).toEqual([false]);
      expect(tab.listCatchUps).toBeGreaterThanOrEqual(3);
      expect(tab.listCatchUps).toBeLessThanOrEqual(5);
    }
    w.server.heal();
    await pass(35_000);
    for (const tab of tabs) {
      expect(tab.live).toEqual([false, true]);
      expectAll(tab, 0, 2);
    }
    const reads = tabs.map((tab) => tab.listCatchUps);
    const opened = w.server.opened.length;
    await pass(2 * 60_000);
    expect(tabs.map((tab) => tab.listCatchUps)).toEqual(reads);
    expect(w.server.opened).toHaveLength(opened);
    expect(w.locks.steals).toBe(0);
  } finally {
    done();
  }
});

test('a window with its own stream (no Web Locks): the same watch reopens it from its last record and catches up', async () => {
  jest.useFakeTimers();
  const opened: number[] = [];
  const streams: { push: (frame: InboxEventFrame) => void; open: boolean }[] = [];
  const got: number[] = [];
  const events = { catchUps: 0, live: [] as boolean[] };
  const frame = (name: InboxEventFrame['name'], seq?: number): InboxEventFrame =>
    seq === undefined ? { name, data: '{}', id: null } : { name, id: String(seq), data: JSON.stringify({ seq, kind: 'message', id: `m${seq}`, message: {} }) };
  const unsubscribe = subscribeOwnInboxEvents(
    0,
    { onRecord: (event) => event && got.push(event.seq), onStatus: () => {}, onCatchUp: () => (events.catchUps += 1), onLive: (live) => events.live.push(live) },
    { id: 'w-own', permission: 'granted', origin: 'http://localhost:1' },
    {
      open: (cursor, onFrame) => {
        opened.push(cursor);
        const stream = { open: true, push: (f: InboxEventFrame) => stream.open && onFrame(f) };
        streams.push(stream);
        return () => {
          stream.open = false;
        };
      },
      dispatch: dispatchInboxFrame,
      lifecycle: null,
      isVisible: () => true,
    },
  );
  try {
    const first = streams[0]!;
    first.push(frame('hello'));
    first.push(frame('record', 1));
    for (let i = 0; i < 6; i++) {
      jest.advanceTimersByTime(BEAT_MS);
      first.push(frame('heartbeat'));
    }
    expect(opened).toEqual([0]);
    expect(events.catchUps).toBe(0);
    jest.advanceTimersByTime(25_000);
    expect(opened).toEqual([0, 1]);
    expect(events.catchUps).toBe(1);
    jest.advanceTimersByTime(3_000);
    expect(events.live).toEqual([false]);
    const second = streams[1]!;
    second.push(frame('hello'));
    second.push(frame('record', 1));
    second.push(frame('record', 2));
    expect(events.live).toEqual([false, true]);
    expect(got).toEqual([1, 2]);
  } finally {
    unsubscribe();
    jest.useRealTimers();
  }
});

test("a linked machine's steps line never reaches the window; its other records still do", () => {
  const got: unknown[] = [];
  const handlers: InboxEventHandlers = { onRecord: () => {}, onStatus: () => {}, onMachine: (frame) => void got.push(frame.record) };
  const machineFrame = (record: unknown): InboxEventFrame => ({ name: 'machine', id: null, data: JSON.stringify({ machine: 'mac_far', seq: 9, live: true, record }) });
  dispatchInboxFrame(machineFrame({ seq: 9, kind: 'steps', id: 'stp_x', thread_id: 'msg_far' }), handlers);
  expect(got).toEqual([]);
  const read = { seq: 10, kind: 'read', message_id: 'msg_far' };
  dispatchInboxFrame(machineFrame(read), handlers);
  expect(got).toEqual([read]);
});
