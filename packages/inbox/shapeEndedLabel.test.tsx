/**
 * Once the agent's session ended, a comment box on the board says what happens to a
 * question (owner's call on #2592, "A"), above its words, before anything is asked:
 * in the Inbox nothing answers then, so it reads "Session ended · your question
 * waits for the agent"; a host with an Ask AI fallback keeps "Session ended · Ask
 * AI answers; changes wait for the agent". The standalone page knows no sessions
 * (every board reads `gone`), so it shows no session line at all. What regresses:
 * the Inbox promising an Ask AI answer that never comes, a host with the fallback
 * losing its words, or the standalone page saying "Session ended" while the agent
 * is live. (The board's side panel is References only: the line moved here.)
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
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

/** A board whose session ended, as the store keeps it. */
function endedBoard(): ShapeLoaded {
  const dir = mkdtempSync(join(tmpdir(), 'shape-ended-label-'));
  dirs.push(dir);
  const store = createShapeStore({ dataDir: join(dir, 'data') });
  const made = store.update({ board: { title: 'Kettle', claim: 'Built.', views: { picture: { html: '<p data-mark="k">One whistle</p>' } } }, project: { root: dir, name: 'app' }, session: { id: 'ses_a', host: 'claude-code' } });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { shape: made.record, version: store.read(made.id)!, seen: 1, notes: [], session: { state: 'gone', agent: 'Claude Code' } };
}

/** The whole board's comment box (Global comment), as the person opens it before asking. */
async function askBox(host: ShapeHost, id: string): Promise<HTMLElement | null> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={host} id={id} />));
  const button = () => el.querySelector<HTMLElement>('.shp-general, [aria-label="Global comment"]');
  for (let i = 0; i < 50 && !button(); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  await act(async () => button()!.click());
  for (let i = 0; i < 20 && !document.querySelector('[data-comment-popover]'); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  return document.querySelector<HTMLElement>('[data-comment-popover]');
}

async function askBoxText(host: ShapeHost, id: string): Promise<string> {
  return (await askBox(host, id))?.textContent ?? '';
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
  // The Inbox's own host carries the flag (it has no Ask AI fallback).
  const inbox = createInboxShapeHost({ subscribe: () => () => {} });
  expect(inbox.askWaitsWhenEnded).toBe(true);

  const waits = await askBoxText(fakeHost(loaded, { askWaitsWhenEnded: inbox.askWaitsWhenEnded }), loaded.shape.id);
  expect(waits).toContain('Session ended · your question waits for the agent');
  expect(waits).not.toContain('Ask AI answers');
  act(() => root?.unmount());
  document.body.innerHTML = '';

  const fallback = await askBoxText(fakeHost(loaded, {}), loaded.shape.id);
  expect(fallback).toContain('Session ended · Ask AI answers; changes wait for the agent');
});

test.skipIf(!hasDom)('the standalone page knows no sessions: no session line, never "Session ended"', async () => {
  const loaded = endedBoard();
  const { createStandaloneShapeHost } = await import('./shape/standalone/host');
  const standalone = createStandaloneShapeHost({ api: {} as never, subscribe: () => () => {} });
  expect(standalone.sessionless).toBe(true);
  const box = await askBox(fakeHost(loaded, { askWaitsWhenEnded: standalone.askWaitsWhenEnded, sessionless: standalone.sessionless }), loaded.shape.id);
  expect(box).not.toBeNull();
  expect(box!.querySelector('[data-shape-talk]')).toBeNull();
  expect(box!.textContent).not.toContain('Session ended');
});
