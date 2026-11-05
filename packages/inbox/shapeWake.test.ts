/**
 * In a code review, a Change it on a board wakes the session that drew it, so
 * the redraw comes without the person going back to the agent. What regresses:
 * a board with Code review off waking anyone (notes wait, as Shape always did),
 * a question being taken for a change, a burst of changes each asking the agent,
 * a change made during a wake never being picked up, a spare wake when the agent
 * has read every note, or a change made during another turn being lost.
 */
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
  /** The notes the Inbox holds: a Change it waits until the agent reads it. */
  const notes: Array<{ kind: string; from: string; delivered: string | null }> = [];
  /** Another turn holds the thread's Ask: a POST is refused, and the read says who runs. */
  const ask: { running: string | null } = { running: null };
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const route = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.endsWith(`/api/shapes/${ID}/notes`)) {
      notes.push({ kind: String(body.kind), from: 'you', delivered: null });
      return reply({ note: { id: 'not_1', kind: body.kind, text: body.text } });
    }
    if (url.includes(`/api/shapes/${ID}`)) return reply({ shape: { id: ID, title: 'Kettle', thread: 'thr_1' }, version: { n: 1 }, seen: 1, notes, session: { state: 'live', agent: 'Claude Code' } });
    if (url.endsWith('/ask') && init?.method !== 'POST') return reply({ can_ask: true, running: ask.running, conversation: null });
    if (url.endsWith('/ask') && ask.running) return new Response(JSON.stringify({ error: 'Another question is running in this session.', code: 'ask_busy' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
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
  // Still running: the Ask's news of something else moves nothing.
  emitAskChange('thr_1');
  await w.settle();
  expect(w.prompts).toEqual([]);
  w.ask.running = null;
  emitAskChange('thr_other');
  await w.settle();
  expect(w.prompts).toEqual([]);
  emitAskChange('thr_1');
  await w.settle();
  expect(w.prompts).toHaveLength(1);
  emitAskChange('thr_1');
  await w.settle();
  expect(w.prompts).toHaveLength(1);
  w.hold.release.shift()?.();
});
