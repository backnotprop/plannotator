/**
 * The tabs' shared event stream (sharedEvents.ts) over fakes that behave like
 * the browser's pieces: a Web Locks manager (exclusive locks, a FIFO queue
 * per name, abort while queued, every lock of a tab freed when the tab dies),
 * BroadcastChannel (every other channel of the name gets each message, in
 * order, a task later; never the sender) and the server's event stream (hello,
 * a replay after the cursor, then each line live). Each "tab" is one
 * subscription with its own handlers; a crash drops the tab without running
 * its unsubscribe or its pagehide.
 *
 * What is proved: one stream per origin whatever the tabs do; every tab
 * handles every record after its cursor exactly once and in order, through
 * closes, crashes, freezes and the back/forward cache, with records written
 * during each handover; the leader tells the server a follower is gone when
 * that tab's lock is freed; followers name their leader (`served_by`).
 */
import { afterEach, expect, test } from 'bun:test';
import type { InboxEventFrame, InboxEventHandlers, InboxEventWindow } from './api';
import { dispatchInboxFrame } from './api';
import {
  browserSharedEventsEnv,
  discardPreparedInboxEvents,
  EVENTS_CHANNEL,
  EVENTS_LOCK,
  prepareInboxEvents,
  inboxEventsServedBy,
  subscribeSharedInboxEvents,
  WINDOW_LOCK_PREFIX,
  type SharedEventsEnv,
} from './sharedEvents';

// ── Fakes ──

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
  /** A paused tab's main thread runs nothing: what the locks tell it waits (`resume`). */
  paused = new Map<number, (() => void)[]>();
  steals = 0;

  /** Run `fn` in `tab`'s main thread: at once, or when it resumes. */
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
            // Take the lock now: the holder's request rejects (AbortError) and the lock is free for this one, first in line.
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
    // Granted a task later, as the browser does.
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

  /** The tab is gone: every lock it holds is freed, its queued requests dropped. */
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

/** The server: a store of lines with one seq counter, and the streams open on it. */
class FakeServer {
  constructor(readonly locks: FakeLocks) {}
  seq = 0;
  lines: { seq: number; kind: string }[] = [];
  streams = new Set<{ tab: number; push: (frame: InboxEventFrame) => void }>();
  opened: { tab: number; cursor: number }[] = [];

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
      // Frames arrive a task later, in order, like a socket.
      push: (frame: InboxEventFrame) => setTimeout(() => this.locks.run(tab, () => open && onFrame(frame)), 0),
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
  drafts: string[];
  gone: { window: string; unloading: boolean }[];
  visible: boolean;
  doc: EventTarget;
  win2: EventTarget;
  unsubscribe: () => void;
}

class World {
  locks = new FakeLocks();
  hub = new FakeHub(this.locks);
  server = new FakeServer(this.locks);
  /** Catch-ups fail while this is set (the Inbox restarting). */
  catchUpFails = false;
  /** Timings every tab gets (the leader check, the catch-up retry). */
  timing: SharedEventsEnv['timing'] = { pingEveryMs: 40, hiddenPingEveryMs: 150, pongTimeoutMs: 30, retryMs: 20, retryMaxMs: 80 };
  tabs = new Map<number, Tab>();
  gone: { by: number; window: string; unloading: boolean }[] = [];
  catchUps: { tab: number; cursor: number }[] = [];
  catchUpDelayMs = 0;
  next = 1;

  open(cursor = this.server.seq, options: { visible?: boolean } = {}): Tab {
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
    };
    const env: SharedEventsEnv = {
      locks: this.locks.managerFor(id),
      channel: () => this.hub.open(id),
      open: (c, onFrame) => this.server.open(id, c, onFrame),
      catchUp: async (c) => {
        // The server answers with the lines as they are when the request reaches it; the answer can then be slow.
        await tick();
        if (this.catchUpFails && this.catchUpDelayMs === 0) {
          this.catchUps.push({ tab: id, cursor: c });
          throw new Error('down');
        }
        this.catchUps.push({ tab: id, cursor: c });
        const frames = this.server.lines.filter((line) => line.seq > c).map((line) => this.server.frameOf(line));
        if (this.catchUpDelayMs > 0) await new Promise((done) => setTimeout(done, this.catchUpDelayMs));
        // A slow answer fails at its end (the Inbox went away meanwhile).
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
    };
    tab.unsubscribe = subscribeSharedInboxEvents(cursor, handlers, tab.win, env);
    this.tabs.set(id, tab);
    return tab;
  }

  /** The tab closes normally: pagehide, then the page goes (its locks freed). */
  close(tab: Tab): void {
    const event = new Event('pagehide') as Event & { persisted: boolean };
    Object.defineProperty(event, 'persisted', { value: false });
    tab.win2.dispatchEvent(event);
    tab.unsubscribe();
    this.kill(tab);
  }

  /** The tab crashes: nothing of it runs again. */
  kill(tab: Tab): void {
    this.locks.kill(tab.id);
    this.hub.kill(tab.id);
    this.server.closeTab(tab.id);
    this.tabs.delete(tab.id);
  }

  leader(): number | null {
    return this.locks.holder(EVENTS_LOCK);
  }

  /** The tab's main thread stops (a debugger, a long script): nothing of it runs until `resume`. No freeze event. */
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

/** Every record after `from` up to the server's seq, once and in order. */
function expectAll(tab: Tab, from: number, to: number): void {
  const want = Array.from({ length: to - from }, (_, i) => from + i + 1);
  expect(tab.records).toEqual(want);
}

// ── Tests ──

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
  // B read the list at seq 5, but the leader's frames for 3..5 can still be in flight to it.
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
  // B learned A is its leader (one report for that), and A's hello was before B: B's own report comes from the leader answer.
  expect(b.connects).toBeGreaterThanOrEqual(1);
  expect(inboxEventsServedBy()).toBe(a.win.id);
  const before = b.connects;
  w.close(a);
  await settle(12);
  expect(w.leader()).toBe(b.id);
  // B now leads: its own stream's hello (served_by null).
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
  // Writes on both sides of the handover, some while the old leader's frames are still in flight.
  setTimeout(() => w.server.write(3), 0);
  w.close(leader);
  w.server.write(2);
  await settle(4);
  w.server.write(4);
  await settle(16);
  expect(w.server.streams.size).toBe(1);
  expect(w.leader()).not.toBe(leader.id);
  for (const tab of tabs) if (tab !== leader) expectAll(tab, 0, w.server.seq);
  // The leader's pagehide said it was gone.
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
  w.server.write(3); // written with no stream open: the next leader's replay brings them
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
  // C said it itself at pagehide; the leader also saw its lock go.
  expect(w.gone).toContainEqual({ by: c.id, window: c.win.id, unloading: true });
  expect(w.gone.filter((g) => g.window === c.win.id && g.by === a.id)).toHaveLength(1);
  // The leader never reports itself.
  expect(w.gone.some((g) => g.by === a.id && g.window === a.win.id)).toBe(false);
});

test('a leader still running after its pagehide reports nothing more: the next leader\'s announcement and hello do not count it again', async () => {
  // The page is not gone the moment pagehide fires: its scripts can still hear the next leader. A report
  // then (served_by the next leader) could reach the server after every `gone` and count a closed tab.
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
  // A is next in line again: B closes, A leads.
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
  // Going into the cache, it heard B lead but did not report: it counts again only at pageshow.
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
  // Back from the cache it is live: its later reports (a leader change, a hello) go out again.
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
  // Written with no stream open; then a new tab reads the list past them and leads from there.
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
  // A tab whose list read was before those lines, subscribing only now.
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
  // The server goes away for F's catch-up only.
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
  // The leader's stream reconnects: its hello is passed on, and F tries again.
  w.server.closeTab(a.id);
  w.server.open(a.id, w.server.seq, (frame) => {
    // Stand-in for the leader's EventSource reconnecting: pass the hello on as the leader would.
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
  // N is next in line for the stream.
  const n = w.open(w.server.seq);
  await settle(6);
  // F subscribes behind (its list read was older); its catch-ups are slow.
  w.catchUpDelayMs = 60;
  const f = w.open(0);
  await settle(4);
  // The leader dies while F's catch-up is in flight: N leads, and F hears of it mid catch-up.
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
  // A stops: it keeps its lock and its stream, and passes nothing on.
  w.pause(a);
  w.server.write(3);
  let peak = 0;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && !(b.records.length === 5 && c.records.length === 5)) {
    peak = Math.max(peak, w.server.streams.size);
    await new Promise((done) => setTimeout(done, 5));
  }
  // B checked, heard nothing, took the lock and leads; C follows it.
  expect(w.locks.steals).toBe(1);
  expect(w.leader()).toBe(b.id);
  expectAll(b, 0, 5);
  expectAll(c, 0, 5);
  // Two streams at most while A is stopped (its own is still open on the server).
  expect(peak).toBeLessThanOrEqual(2);
  w.server.write(2);
  await settle(8);
  expectAll(c, 0, 7);
  // A runs again: its lock was taken, so it closes its stream and follows B; nothing lost or twice.
  w.resume(a);
  await settle(20);
  expect(w.server.streams.size).toBe(1);
  expect(w.leader()).toBe(b.id);
  w.server.write(1);
  await settle(12);
  expectAll(a, 0, 8);
  expectAll(b, 0, 8);
  expectAll(c, 0, 8);
  // It is in line again: B closes, A or C leads.
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
  // Each follower checked several times; the leader answered each.
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
  // Hidden, and its next check a minute away: nothing taken yet.
  expect(w.locks.steals).toBe(0);
  expect(b.records).toEqual([]);
  // B becomes visible: it checks at once, hears nothing, and leads.
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
  // At the hidden pace (150 ms here), not the visible one; one or two steals (two hidden tabs may both time out).
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
  // F sleeps through 1 and 2 (what the leader passed on while it was frozen never reaches it).
  w.pause(f);
  w.server.write(2);
  await settle(6);
  w.locks.paused.delete(f.id);
  w.catchUpFails = true;
  f.doc.dispatchEvent(new Event('resume'));
  await settle(6);
  // 3 and 4 arrive from the leader while F cannot fetch 1 and 2: they wait.
  w.server.write(2);
  await settle(6);
  expect(f.records).toEqual([]);
  w.catchUpFails = false;
  // The retry timer (no hello needed) fetches from 0.
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
  // F sleeps; when it wakes its catch-up is slow and will fail.
  f.doc.dispatchEvent(new Event('freeze'));
  w.server.write(2);
  w.catchUpDelayMs = 60;
  w.catchUpFails = true;
  f.doc.dispatchEvent(new Event('resume'));
  await settle(4);
  // The leader goes while F's catch-up is in flight: F leads.
  w.kill(a);
  await settle(10);
  expect(w.leader()).toBe(f.id);
  // The catch-up fails; F's own stream replays from its last seq.
  await new Promise((done) => setTimeout(done, 120));
  w.catchUpDelayMs = 0;
  w.server.write(5);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && f.records.length < 7) await new Promise((done) => setTimeout(done, 5));
  expectAll(f, 0, 7);
  // It keeps going: a later record reaches it too, and nobody else leads.
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
    // Twice is nothing.
    discardPreparedInboxEvents();
    expect(closed).toHaveLength(1);
  } finally {
    g.BroadcastChannel = saved.BroadcastChannel;
    g.EventSource = saved.EventSource;
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true });
  }
});

test('a frame that reached the early channel before the subscription: the report it starts names the leader', async () => {
  // A new tab listens on the channel before its first list read (prepareInboxEvents); a
  // `reach` frame the leader passes on meanwhile (another tab just got counted) waits in
  // the backlog. Handling it on subscribe tells this tab its leader and reports
  // (`onConnect`). That report must carry `served_by`, or the server never counts the
  // tab: the leader's answer to its join names the same leader and reports nothing new.
  // (The browser proof saw "Expected: 8, Received: 7" in notify_reach.)
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
      // The page's own env, so the early channel and its backlog are the ones used.
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
  // A seeded generator, so a failure replays.
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
      // Every record after the tab's cursor, once, in order.
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
        // The leader stops (one at a time), or the stopped one runs again.
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
        // The Inbox goes away and comes back: catch-ups fail (some at the end of a slow answer), then work again.
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
    // Retries back off to 80 ms here.
    await new Promise((done) => setTimeout(done, 300));
    await settle(30);
    steals += w.locks.steals;
    expect(w.server.streams.size).toBe(1);
    for (const one of live) {
      const want = Array.from({ length: w.server.seq - one.from }, (_, i) => one.from + i + 1);
      expect(one.tab.records).toEqual(want);
    }
  }
  // The rounds did take streams over (the property is not vacuous).
  expect(steals).toBeGreaterThan(5);
}, 120_000);
