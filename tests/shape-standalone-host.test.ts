import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShapeEvent } from '@plannotator/ui/components/shape';
import { createShapeStore } from '../packages/shared/shape/store';
import { startShapeServer, type ShapeServer } from '../packages/server/shape';
import { createShapePageApi, ShapeApiError } from '../packages/inbox/shape/standalone/api';
import { createStandaloneShapeHost } from '../packages/inbox/shape/standalone/host';

const roots: string[] = [];
const servers: ShapeServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shape-page-host-')));
  roots.push(root);
  const dataDir = join(root, 'data');
  mkdirSync(join(root, 'app'), { recursive: true });
  const store = createShapeStore({ dataDir });
  const made = store.update({
    board: { title: 'Kettle', claim: 'Built.', views: { picture: { html: '<p data-mark="k">One whistle</p>' } } },
    project: { root: join(root, 'app'), name: 'app' },
    session: { id: 'ses_a', host: 'claude-code' },
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const server = await startShapeServer({ dataDir, shape: true, register: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const api = createShapePageApi({ fetch: (input, init) => fetch(`${base}${input as string}`, init) });
  const frames = new Set<(ids: string[]) => void>();
  const host = createStandaloneShapeHost({ api, subscribe: (l) => (frames.add(l), () => frames.delete(l)), copy: () => {} });
  return { dataDir, store, id: made.id, api, host, server, emit: (ids: string[]) => frames.forEach((l) => l(ids)) };
}

test('a Change it from the page waits until the agent reads its notes', async () => {
  const w = await world();
  await w.api.info();
  const loaded = await w.host.load(w.id);
  expect(loaded.session.state).toBe('gone');
  const note = await w.host.note(w.id, { kind: 'change', v: 1, view: 'picture', part: 'k', text: 'Two whistles' });
  expect(w.store.waiting(w.id).map((n) => n.id)).toEqual([note.id]);
  w.store.markDelivered(w.id, [note.id]);
  expect(w.store.waiting(w.id)).toEqual([]);
});

test('an Ask is stored with no answer; the agent answers with `shape answer` and the open board hears it', async () => {
  const w = await world();
  await w.api.info();
  expect(w.host.askWaitsWhenEnded).toBe(true);
  await w.host.load(w.id);
  const events: ShapeEvent[] = [];
  const stop = w.host.events(w.id, (e) => events.push(e));
  const { question, answer } = await w.host.ask(w.id, { kind: 'ask', v: 1, view: 'picture', part: 'k', text: 'Why one?' }, () => {});
  expect(answer).toBeNull();
  expect(w.store.notes(w.id).map((n) => n.id)).toEqual([question.id]);
  const answered = w.store.answer(w.id, { re: question.id, text: 'Two would be noise.', from: { host: 'claude-code', id: 'ses_a' } });
  expect(answered.ok).toBe(true);
  w.emit([w.id]);
  for (let i = 0; i < 40 && !events.some((e) => e.type === 'note' && e.note.text === 'Two would be noise.'); i++) await Bun.sleep(25);
  expect(events.some((e) => e.type === 'note' && e.note.text === 'Two would be noise.')).toBe(true);
  stop();
});

test('Copy prompt is the command any session runs to pick up what waits', async () => {
  const w = await world();
  expect(w.host.resumePrompt!(w.id)).toBe(`plannotator shape read ${w.id} --notes`);
});

test("every write carries the page's serverSession: a server that keeps refusing it saves nothing, and the page hears it", async () => {
  const w = await world();
  const earlierDir = realpathSync(mkdtempSync(join(tmpdir(), 'shape-page-earlier-')));
  roots.push(earlierDir);
  const earlier = await startShapeServer({ dataDir: earlierDir, shape: true, register: false });
  servers.push(earlier);
  const leftOpen = createShapePageApi({
    fetch: (input, init) => fetch(`http://127.0.0.1:${input === '/api/shape-server' ? earlier.port : w.server.port}${input as string}`, init),
  });
  await leftOpen.info();
  const refused = await leftOpen.note(w.id, { kind: 'change', v: 1, view: 'picture', text: 'x' }).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(ShapeApiError);
  expect((refused as ShapeApiError).status).toBe(409);
  expect(w.store.notes(w.id)).toEqual([]);
  await w.api.info();
  expect((await w.api.note(w.id, { kind: 'change', v: 1, view: 'picture', text: 'y' })).note.text).toBe('y');
});

test('a page left open across a restart on the same address: its Change it goes through once, to the same boards', async () => {
  const w = await world();
  await w.api.info();
  const port = w.server.port;
  const before = w.server.serverSession;
  w.server.stop();
  const restarted = await startShapeServer({ dataDir: w.dataDir, shape: true, register: false, port });
  servers.push(restarted);
  expect(restarted.port).toBe(port);
  expect(restarted.serverSession).not.toBe(before);
  const note = await w.host.note(w.id, { kind: 'change', v: 1, view: 'picture', part: 'k', text: 'Two whistles' });
  expect(note.text).toBe('Two whistles');
  expect(w.store.waiting(w.id).map((n) => n.text)).toEqual(['Two whistles']);
  expect((await w.api.note(w.id, { kind: 'change', v: 1, view: 'picture', text: 'Louder' })).note.text).toBe('Louder');
  expect(w.store.waiting(w.id).map((n) => n.text)).toEqual(['Two whistles', 'Louder']);
});
