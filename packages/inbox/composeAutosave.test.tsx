/**
 * A New message is a draft from the first key (the owner: "The moment I start typing text, that's a draft."): saved to
 * the dialog's own draft id after a pause in typing, and at once as the page hides or goes, so a reload, an update's
 * restart or a killed tab loses nothing. The page's "Leave page?" asks only while words are not saved yet. A Send takes
 * the draft a pause saved; emptied, the draft the dialog made goes again; Escape still keeps it ("Draft saved").
 *
 * The real ComposeDialog over its `transport` seam (no Inbox server), the window's draft saves answered by a stubbed
 * fetch. DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DraftView, StartThreadInput } from './api';
import type { ComposeRequest } from './compose/ComposeDialog';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const { COMPOSE_AUTOSAVE_MS } = (hasDom ? await import('./compose/composeAutosave') : {}) as typeof import('./compose/composeAutosave');
const catalog = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');

const ROOT = '/Users/me/work/ledger';

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** The draft saves and deletes the window made, as sent (`keepalive` too). */
let saves: { id: string; body: Record<string, unknown>; keepalive: boolean; at: number }[];
let deletes: string[];
let saved: DraftView[];
let sent: StartThreadInput[];

beforeEach(() => {
  if (!hasDom) return;
  saves = [];
  deletes = [];
  saved = [];
  sent = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const gone = /\/drafts\/([^/?]+)\/delete$/.exec(url);
    if (gone && init?.method === 'POST') {
      deletes.push(decodeURIComponent(gone[1]!));
      return Response.json({ ok: true, deleted: true });
    }
    const draft = /\/drafts\/([^/?]+)$/.exec(url);
    if (draft && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      saves.push({ id: decodeURIComponent(draft[1]!), body, keepalive: init.keepalive === true, at: Date.now() });
      const now = new Date(Date.now() + saves.length).toISOString();
      const view = { v: 1, id: decodeURIComponent(draft[1]!), created_at: now, updated_at: now, body: body.body, to: body.to ?? null, project: body.project ?? null, files: [], status: 'none' };
      return Response.json({ draft: view });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  catalog.resetSkillCatalogCache();
  catalog.setSkillCatalogTransport(async () => []);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  catalog.resetSkillCatalogTransport();
  catalog.resetSkillCatalogCache();
});

const dialog = () => document.querySelector('dialog[data-compose]') as HTMLDialogElement | null;
const field = () => dialog()!.querySelector<HTMLTextAreaElement>('[data-compose-text] textarea')!;

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}
const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

async function open(request: ComposeRequest = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={request}
        phone={false}
        current={{ id: 'p1', root: ROOT, name: 'ledger' }}
        lastSent={null}
        home="/Users/me"
        onSent={() => {}}
        onSaved={(view) => saved.push(view)}
        onDeleted={() => {}}
        onClose={() => {}}
        transport={{
          sessions: async () => ({
            serverSession: 's',
            home: '/Users/me',
            projects: [
              {
                project: { id: 'p1', name: 'ledger', root: ROOT },
                sessions: [{ session: 'ses_1', host: 'claude-code', started_at: new Date(Date.now() - 60_000).toISOString(), last_seen_at: new Date().toISOString(), busy: false, idle_since: null, last_thread: null }],
              },
            ],
          }),
          startThread: async (input: StartThreadInput) => {
            sent.push(input);
            return { thread_id: 't1' };
          },
          drafts: true,
          uploads: false,
        }}
      />,
    );
  });
  await until(() => dialog()?.querySelector('button[data-compose-to]:not([data-loading])') != null, 'To');
}

async function type(value: string) {
  const el = field();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    el.focus();
    setter.call(el, value);
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Whether the page's "Leave page?" would ask now. */
function leaveAsks(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

test.skipIf(!hasDom)('words typed in New message are saved as its draft after a pause in typing, and "Leave page?" asks only until then', async () => {
  await open();
  await type('Add a progress line to the CLI.');
  expect(leaveAsks()).toBe(true);
  await until(() => saves.length === 1, 'the draft saved', COMPOSE_AUTOSAVE_MS + 1500);
  expect(saves[0]!.body.body).toBe('Add a progress line to the CLI.');
  await until(() => !leaveAsks(), '"Leave page?" no longer asking');
  // Typing on saves again, on the draft it made (its base), to the same id.
  await type('Add a progress line to the CLI. And a summary.');
  await until(() => saves.length === 2, 'the second save', COMPOSE_AUTOSAVE_MS + 1500);
  expect(saves[1]!.id).toBe(saves[0]!.id);
  expect(saves[1]!.body.body).toBe('Add a progress line to the CLI. And a summary.');
  expect(typeof saves[1]!.body.base).toBe('string');
});

test.skipIf(!hasDom)('the page going (a reload, a closed tab) inside the pause: the words are sent at once with keepalive', async () => {
  await open();
  await type('Typed just before the reload.');
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  await until(() => saves.length === 1, 'the save as the page went', 200);
  expect(saves[0]!.keepalive).toBe(true);
  expect(saves[0]!.body.body).toBe('Typed just before the reload.');
});

test.skipIf(!hasDom)('a phone hiding the page inside the pause: the words are sent at once', async () => {
  await open();
  await type('Typed on the phone, then another app.');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  try {
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await until(() => saves.length === 1, 'the save as the page hid', 200);
    expect(saves[0]!.body.body).toBe('Typed on the phone, then another app.');
  } finally {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  }
});

test.skipIf(!hasDom)('Escape after a pause saved the words still keeps them as a draft ("Draft saved")', async () => {
  await open();
  await type('Kept by the pause.');
  await until(() => saves.length === 1, 'the draft saved', COMPOSE_AUTOSAVE_MS + 1500);
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await until(() => saved.length === 1, 'onSaved');
  expect(saved[0]!.body).toBe('Kept by the pause.');
});

test.skipIf(!hasDom)('the words emptied after a pause saved them: the draft the dialog made goes again', async () => {
  await open();
  await type('Second thoughts.');
  await until(() => saves.length === 1, 'the draft saved', COMPOSE_AUTOSAVE_MS + 1500);
  await type('');
  await until(() => deletes.length === 1, 'the draft deleted', COMPOSE_AUTOSAVE_MS + 1500);
  expect(deletes[0]).toBe(saves[0]!.id);
});

test.skipIf(!hasDom)('a Send after a pause saved the words takes that draft, and no save lands after it', async () => {
  await open({ session: 'ses_1' });
  await type('Ship it.');
  await until(() => saves.length === 1, 'the draft saved', COMPOSE_AUTOSAVE_MS + 1500);
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => sent.length === 1, 'the Send');
  expect(sent[0]!.draft_id).toBe(saves[0]!.id);
  const after = saves.length;
  await wait(COMPOSE_AUTOSAVE_MS + 200);
  expect(saves.length).toBe(after);
});
