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
/** The draft saves and deletes the window made, as sent (`keepalive` too), and how each save was answered. */
let saves: { id: string; body: Record<string, unknown>; keepalive: boolean; at: number; status?: number }[];
let deletes: string[];
let saved: DraftView[];
let sent: StartThreadInput[];
/** The stand-in Inbox's drafts by id. A save is the server's compare-and-set: its `base` must be the draft's `updated_at` (null: none). */
let drafts: Map<string, DraftView>;
/** Draft saves are answered only once this resolves (null: at once). */
let savesHeld: Promise<void> | null;
/** The next saves that land without their answer reaching the window. */
let loseAnswers = 0;
let stamp = 0;

beforeEach(() => {
  if (!hasDom) return;
  saves = [];
  deletes = [];
  saved = [];
  sent = [];
  drafts = new Map();
  savesHeld = null;
  loseAnswers = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const gone = /\/drafts\/([^/?]+)\/delete$/.exec(url);
    if (gone && init?.method === 'POST') {
      deletes.push(decodeURIComponent(gone[1]!));
      drafts.delete(decodeURIComponent(gone[1]!));
      return Response.json({ ok: true, deleted: true });
    }
    const draft = /\/drafts\/([^/?]+)$/.exec(url);
    if (draft && init?.method === 'POST') {
      const id = decodeURIComponent(draft[1]!);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const save: (typeof saves)[number] = { id, body, keepalive: init.keepalive === true, at: Date.now() };
      saves.push(save);
      if (savesHeld) await savesHeld;
      const existing = drafts.get(id) ?? null;
      if ((existing?.updated_at ?? null) !== (body.base ?? null)) {
        save.status = 409;
        const error = existing ? 'This draft changed in another window since you opened it.' : 'This draft was deleted in another window.';
        return Response.json({ error, code: 'draft_conflict', draft: existing }, { status: 409 });
      }
      stamp += 1;
      const now = new Date(Date.UTC(2026, 10, 24, 9, 0, 0, stamp)).toISOString();
      const view = { v: 1, id, created_at: existing?.created_at ?? now, updated_at: now, body: body.body, to: body.to ?? null, project: body.project ?? null, files: [], status: 'none' } as unknown as DraftView;
      drafts.set(id, view);
      save.status = 200;
      // Landed, but its answer never reaches the window (the link dropped, a phone froze the page).
      if (loseAnswers > 0 && loseAnswers--) throw new TypeError('Failed to fetch');
      return Response.json({ draft: view });
    }
    if (/\/drafts(\?|$)/.test(url)) return Response.json({ serverSession: 's', drafts: [...drafts.values()] });
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

const escape = () =>
  act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
const shownError = () => dialog()?.querySelector('[data-compose-error]')?.textContent ?? '';
function pageVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test.skipIf(!hasDom)('typed, emptied and typed again, each after a pause: the new words are saved as a draft, and Escape keeps them', async () => {
  await open();
  await type('First thoughts.');
  await until(() => drafts.size === 1, 'the draft saved', COMPOSE_AUTOSAVE_MS + 1500);
  await type('');
  await until(() => deletes.length === 1 && drafts.size === 0, 'the draft deleted', COMPOSE_AUTOSAVE_MS + 1500);
  await type('Second thoughts.');
  await until(() => [...drafts.values()].some((d) => d.body === 'Second thoughts.'), 'the new words saved', COMPOSE_AUTOSAVE_MS + 1500);
  expect(saves.every((s) => s.status !== 409)).toBe(true);
  await type('Second thoughts, then more.');
  await until(() => [...drafts.values()].some((d) => d.body === 'Second thoughts, then more.'), 'saved again', COMPOSE_AUTOSAVE_MS + 1500);
  await escape();
  await until(() => saved.length === 1, 'Escape kept the draft');
  expect(saved[0]!.body).toBe('Second thoughts, then more.');
  expect(shownError()).toBe('');
});

test.skipIf(!hasDom)('the page hidden while a save is still on its way: the newer words land after it, with no conflict', async () => {
  await open();
  let letGo!: () => void;
  savesHeld = new Promise<void>((done) => (letGo = done));
  await type('Slow link, first words.');
  await until(() => saves.length === 1, 'the first save on its way', COMPOSE_AUTOSAVE_MS + 1500);
  await type('Slow link, first words. And newer ones.');
  try {
    pageVisibility('hidden');
    await wait(50);
    savesHeld = null;
    letGo();
    await until(() => [...drafts.values()].some((d) => d.body === 'Slow link, first words. And newer ones.'), 'the newer words saved');
  } finally {
    pageVisibility('visible');
  }
  expect(saves.every((s) => s.status !== 409)).toBe(true);
  // Autosave goes on, and Escape keeps the draft without "changed in another window".
  await type('Slow link, first words. And newer ones. Last.');
  await until(() => [...drafts.values()].some((d) => d.body === 'Slow link, first words. And newer ones. Last.'), 'saved after', COMPOSE_AUTOSAVE_MS + 1500);
  await escape();
  await until(() => saved.length === 1, 'Escape kept the draft');
  expect(shownError()).toBe('');
});

test.skipIf(!hasDom)('Escape while a pause save is still on its way: kept on the draft it lands as, never "changed in another window"', async () => {
  await open();
  let letGo!: () => void;
  savesHeld = new Promise<void>((done) => (letGo = done));
  await type('Escape right after the pause.');
  await until(() => saves.length === 1, 'the save on its way', COMPOSE_AUTOSAVE_MS + 1500);
  await type('Escape right after the pause, edited.');
  await escape();
  savesHeld = null;
  letGo();
  await until(() => saved.length === 1, 'Escape kept the draft');
  expect(saved[0]!.body).toBe('Escape right after the pause, edited.');
  expect(shownError()).toBe('');
});

test.skipIf(!hasDom)("a save that landed without its answer is this dialog's own: typing on saves over it, no conflict", async () => {
  await open();
  loseAnswers = 1;
  await type('Landed, answer lost.');
  await until(() => saves.length === 1, 'the first save', COMPOSE_AUTOSAVE_MS + 1500);
  await type('Landed, answer lost. Typed on.');
  await until(() => [...drafts.values()].some((d) => d.body === 'Landed, answer lost. Typed on.'), 'saved over it', COMPOSE_AUTOSAVE_MS + 2500);
  await escape();
  await until(() => saved.length === 1, 'Escape kept the draft');
  expect(shownError()).toBe('');
});

test.skipIf(!hasDom)('words too large for a keepalive in bytes (not characters) go as an ordinary request as the page goes', async () => {
  await open();
  // 25,000 characters, 75,000 bytes: over the 64 KiB a browser takes in keepalive bodies.
  await type('€'.repeat(25_000));
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  await until(() => saves.length === 1, 'the save as the page went', 500);
  expect(saves[0]!.keepalive).toBe(false);
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

test.skipIf(!hasDom)('a Send after a pause save that landed without its answer still names that draft, so it does not stay behind', async () => {
  await open({ session: 'ses_1' });
  loseAnswers = 1;
  await type('Ship it.');
  await until(() => saves.length === 1, 'the draft saved', COMPOSE_AUTOSAVE_MS + 1500);
  expect(drafts.has(saves[0]!.id)).toBe(true);
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => sent.length === 1, 'the Send');
  expect(sent[0]!.draft_id).toBe(saves[0]!.id);
});
