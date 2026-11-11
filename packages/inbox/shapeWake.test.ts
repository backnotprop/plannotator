import { afterEach, expect, test } from 'bun:test';
import { emitAskChange } from './ask/askEvents';
import { createInboxShapeHost } from './shape/inboxShapeHost';

const ID = 'shp_01J8ZK3TQ4VW7Y9A2B5C6D8E0F';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function agentWorld() {
  const prompts: string[] = [];
  const queries: Array<{ busyPolicy?: string }> = [];
  const hold: { release: Array<() => void> } = { release: [] };
  const notes: Array<{ kind: string; from: string; delivered: string | null }> = [];
  const ask: { running: string | null; heldElsewhere: boolean; posts: number; reads: number } = { running: null, heldElsewhere: false, posts: 0, reads: 0 };
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const route = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.endsWith(`/api/shapes/${ID}/notes`)) {
      notes.push({ kind: String(body.kind), from: 'you', delivered: null });
      return reply({ note: { id: 'not_1', kind: body.kind, text: body.text } });
    }
    if (url.includes(`/api/shapes/${ID}`)) return reply({ shape: { id: ID, title: 'Kettle', thread: 'thr_1' }, version: { n: 1 }, seen: 1, notes, session: { state: 'live', agent: 'Claude Code' } });
    if (url.endsWith('/ask') && init?.method !== 'POST') {
      ask.reads += 1;
      return reply({ can_ask: true, running: ask.running, conversation: null });
    }
    if (url.endsWith('/ask')) ask.posts += 1;
    // `heldElsewhere`: the session answers another thread, so this thread's read says nothing runs.
    if (url.endsWith('/ask') && (ask.running || ask.heldElsewhere)) return new Response(JSON.stringify({ error: 'Another question is running in this session.', code: 'ask_busy' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/ask')) {
      prompts.push(String(body.question));
      return reply({ provider_id: 'inbox-ask-1', conversation: { turns: [] } });
    }
    if (url.endsWith('/api/ai/session')) return reply({ sessionId: 's1' });
    if (url.endsWith('/api/ai/query')) {
      queries.push(body);
      await new Promise<void>((done) => hold.release.push(done));
      return new Response(`data: ${JSON.stringify({ type: 'text', text: 'Drew it.' })}\n\n`, { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => route(String(input), init)) as typeof fetch;
  globalThis.fetch = fetcher;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { prompts, queries, hold, settle, notes, ask };
}

const change = { kind: 'change', v: 1, text: 'Say what the customer sees.' } as never;

test('Code review on: a Change it wakes the session with the command that reads it, and waits its turn if the session is busy', async () => {
  const w = agentWorld();
  const host = createInboxShapeHost({ subscribe: () => () => {}, wakeOnChange: () => true });
  await host.note(ID, change);
  await w.settle();
  expect(w.prompts).toHaveLength(1);
  expect(w.prompts[0]).toContain(`plannotator shape read ${ID} --notes`);
  expect(w.queries[0]!.busyPolicy).toBe('wait');
  w.hold.release.shift()?.();
});

test('Code review off, or no switch given: a Change it asks nobody; it waits for the next turn', async () => {
  const w = agentWorld();
  await createInboxShapeHost({ subscribe: () => () => {}, wakeOnChange: () => false }).note(ID, change);
  await createInboxShapeHost({ subscribe: () => () => {} }).note(ID, change);
  await w.settle();
  expect(w.prompts).toEqual([]);
});

test('a question is not a change: it wakes nothing of its own', async () => {
  const w = agentWorld();
  const host = createInboxShapeHost({ subscribe: () => () => {}, wakeOnChange: () => true });
  await host.note(ID, { kind: 'ask', v: 1, text: 'Why?' } as never);
  await w.settle();
  expect(w.prompts).toEqual([]);
});

test('a burst of changes wakes it once, and once more after, for what came during the wake', async () => {
  const w = agentWorld();
  const host = createInboxShapeHost({ subscribe: () => () => {}, wakeOnChange: () => true });
  await host.note(ID, change);
  await host.note(ID, change);
  await host.note(ID, change);
  await w.settle();
  expect(w.prompts).toHaveLength(1);
  w.hold.release.shift()?.();
  await w.settle();
  expect(w.prompts).toHaveLength(2);
  w.hold.release.shift()?.();
  await w.settle();
  expect(w.prompts).toHaveLength(2);
});

test('the agent has read every note by the end of a wake: no second wake', async () => {
  const w = agentWorld();
  const host = createInboxShapeHost({ subscribe: () => () => {}, wakeOnChange: () => true });
  await host.note(ID, change);
  await w.settle();
  await host.note(ID, change);
  await w.settle();
  expect(w.prompts).toHaveLength(1);
  for (const note of w.notes) note.delivered = '2026-11-05T00:00:00Z';
  w.hold.release.shift()?.();
  await w.settle();
  expect(w.prompts).toHaveLength(1);
});

test('a Change it during another turn is not lost: it wakes the session once that turn is over, and once only', async () => {
  const w = agentWorld();
  w.ask.running = 'turn-other';
  const host = createInboxShapeHost({ subscribe: () => () => {}, wakeOnChange: () => true });
  await host.note(ID, change);
  await w.settle();
  emitAskChange('thr_1');
  await w.settle();
  expect(w.prompts).toEqual([]);
  w.ask.running = null;
  emitAskChange('thr_1');
  await w.settle();
  expect(w.prompts).toHaveLength(1);
  emitAskChange('thr_1');
  await w.settle();
  expect(w.prompts).toHaveLength(1);
  w.hold.release.shift()?.();
});

test("the session is answering another thread: this thread's read says nothing runs, and a refusal does not retry at once", async () => {
  const w = agentWorld();
  w.ask.heldElsewhere = true;
  const host = createInboxShapeHost({ subscribe: () => () => {}, wakeOnChange: () => true });
  await host.note(ID, change);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(w.ask.posts).toBe(1);
  expect(w.ask.reads).toBe(1);

  emitAskChange('thr_other');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(w.ask.posts).toBe(2);

  w.ask.heldElsewhere = false;
  emitAskChange('thr_other');
  await w.settle();
  expect(w.prompts).toHaveLength(1);
  const reads = w.ask.reads;
  emitAskChange('thr_other');
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(w.prompts).toHaveLength(1);
  expect(w.ask.reads).toBe(reads);
  w.hold.release.shift()?.();
});

test('no news ever comes of the end of that turn: it goes through after a pause, once', async () => {
  const w = agentWorld();
  w.ask.heldElsewhere = true;
  const host = createInboxShapeHost({ subscribe: () => () => {}, wakeOnChange: () => true, busyRetryMs: 40 });
  await host.note(ID, change);
  await new Promise((resolve) => setTimeout(resolve, 130));
  // A try per pause, at most: 130 ms holds the first and about three more.
  expect(w.ask.posts).toBeGreaterThanOrEqual(2);
  expect(w.ask.posts).toBeLessThanOrEqual(5);
  w.ask.heldElsewhere = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(w.prompts).toHaveLength(1);
  w.hold.release.shift()?.();
});
