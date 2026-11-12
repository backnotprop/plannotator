import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createShapeStore } from '../shared/shape/store';
import type { ShapeHost, ShapeLoaded } from '@plannotator/ui/components/shape';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('@plannotator/ui/components/shape/ShapeSurface') : {}) as typeof import('@plannotator/ui/components/shape/ShapeSurface');
const { createInboxShapeHost } = (hasDom ? await import('./shape/inboxShapeHost') : {}) as typeof import('./shape/inboxShapeHost');

let root: Root | null = null;
const dirs: string[] = [];
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function endedBoard(): ShapeLoaded {
  const dir = mkdtempSync(join(tmpdir(), 'shape-ended-label-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const made = store.update({ board: { title: 'Kettle', claim: 'Built.', views: { picture: { html: '<p data-mark="k">One whistle</p>' } } }, project: { root: dir, name: 'app' }, session: { id: 'ses_a', host: 'claude-code' } });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { shape: made.record, version: store.read(made.id)!, seen: 1, notes: [], session: { state: 'gone', agent: 'Claude Code' } };
}

async function askPanel(host: ShapeHost, id: string): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={host} id={id} initialPanel="ask" />));
  for (let i = 0; i < 50 && !el.querySelector('.shp-sidep-body') ; i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  for (let i = 0; i < 10 && !el.textContent?.includes('Session ended'); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  return el;
}

async function askPanelText(host: ShapeHost, id: string): Promise<string> {
  return (await askPanel(host, id)).textContent ?? '';
}

function fakeHost(loaded: ShapeLoaded, extra: Partial<ShapeHost>): ShapeHost {
  return {
    load: async () => loaded,
    version: async () => loaded.version,
    note: async () => { throw new Error('not in this test'); },
    ask: async () => { throw new Error('not in this test'); },
    seen: () => {},
    events: () => () => {},
    ...extra,
  };
}

test.skipIf(!hasDom)('the Inbox host says a question waits once the session ended; a host with the Ask AI fallback keeps its words', async () => {
  const loaded = endedBoard();
  const inbox = createInboxShapeHost({ subscribe: () => () => {} });
  expect(inbox.askWaitsWhenEnded).toBe(true);

  const waits = await askPanelText(fakeHost(loaded, { askWaitsWhenEnded: inbox.askWaitsWhenEnded }), loaded.shape.id);
  expect(waits).toContain('Session ended · your question waits for the agent');
  expect(waits).not.toContain('Ask AI answers');
  act(() => root?.unmount());
  document.body.innerHTML = '';

  const fallback = await askPanelText(fakeHost(loaded, {}), loaded.shape.id);
  expect(fallback).toContain('Session ended · Ask AI answers; changes wait for the agent');
});

test.skipIf(!hasDom)('the standalone page knows no sessions: no session line, never "Session ended"', async () => {
  const loaded = endedBoard();
  const { createStandaloneShapeHost } = await import('./shape/standalone/host');
  const standalone = createStandaloneShapeHost({ api: {} as never, subscribe: () => () => {} });
  expect(standalone.sessionless).toBe(true);
  const el = await askPanel(fakeHost(loaded, { askWaitsWhenEnded: standalone.askWaitsWhenEnded, sessionless: standalone.sessionless }), loaded.shape.id);
  expect(el.querySelector('.shp-sidep-body')).not.toBeNull();
  expect(el.querySelector('[data-ai-provider-session-bridge]')).toBeNull();
  expect(el.textContent).not.toContain('Session ended');
});
