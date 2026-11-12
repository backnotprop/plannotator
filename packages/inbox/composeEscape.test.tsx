import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DraftView } from './api';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const catalog = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');

const ROOT = '/Users/me/work/ledger';

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let saves: { id: string; body: Record<string, unknown> }[];
let saveFails: number | null;
let saved: DraftView[];
let closed: number;

beforeEach(() => {
  if (!hasDom) return;
  saves = [];
  saveFails = null;
  saved = [];
  closed = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const draft = /\/drafts\/([^/?]+)$/.exec(url);
    if (draft && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      saves.push({ id: decodeURIComponent(draft[1]!), body });
      if (saveFails) return new Response(JSON.stringify({ error: { code: 'internal', message: 'The draft was not saved.' } }), { status: saveFails, headers: { 'Content-Type': 'application/json' } });
      const now = new Date().toISOString();
      const view = { v: 1, id: decodeURIComponent(draft[1]!), created_at: now, updated_at: now, body: body.body, to: body.to ?? null, project: body.project ?? null, files: [], ...(body.thread_name ? { thread_name: body.thread_name } : {}), status: 'none' };
      return new Response(JSON.stringify({ draft: view }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  catalog.resetSkillCatalogCache();
  catalog.setSkillCatalogTransport(async () => [{ name: 'readback', root: 'claude', humanOnly: false }]);
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
const inDialog = <T extends Element = HTMLElement>(selector: string) => dialog()!.querySelector<T>(selector);
const field = () => inDialog<HTMLTextAreaElement>('[data-compose-text] textarea')!;
const skillMenu = () => document.querySelector('[data-skill-menu]');

async function until(check: () => boolean, what: string, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

async function open({ phone = false, draft = null as DraftView | null } = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={draft ? { draft } : {}}
        phone={phone}
        current={{ id: 'p1', root: ROOT, name: 'ledger' }}
        lastSent={null}
        home="/Users/me"
        onSent={() => {}}
        onSaved={(view) => saved.push(view)}
        onDeleted={() => {}}
        onClose={() => closed++}
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
          startThread: async () => ({ thread_id: 't1' }),
          drafts: true,
          uploads: false,
        }}
      />,
    );
  });
  await until(() => inDialog('button[data-compose-to]:not([data-loading])') !== null, 'To');
}

async function type(value: string) {
  const el = field();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    el.focus();
    setter.call(el, value);
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
}

async function escape(target: Element, ime: 'composing' | '229' | null = null) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  if (ime === 'composing') Object.defineProperty(event, 'isComposing', { value: true });
  if (ime) Object.defineProperty(event, 'keyCode', { value: 229 });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await settle();
  return event;
}

test.skipIf(!hasDom)('with words, one Escape saves them as a draft and leaves: no question, nothing to answer', async () => {
  await open();
  await type('Add a progress line to the CLI.');
  await escape(field());
  await until(() => saved.length === 1, 'the draft saved');
  expect(saves).toHaveLength(1);
  expect(saves[0]!.body.body).toBe('Add a progress line to the CLI.');
  expect(saved[0]!.body).toBe('Add a progress line to the CLI.');
  expect(dialog()!.querySelector('[role="alertdialog"]')).toBeNull();
  expect(closed).toBe(0);
});

test.skipIf(!hasDom)('an empty compose closes on Escape and keeps nothing', async () => {
  await open();
  await escape(inDialog('button[data-compose-to]')!);
  expect(closed).toBe(1);
  expect(saves).toHaveLength(0);
});

test.skipIf(!hasDom)('the skill picker takes the first Escape alone; the next one keeps the draft', async () => {
  await open();
  await type('Plan the retry budget. /');
  await until(() => skillMenu() !== null, 'the skill picker on a bare /');
  await escape(field());
  expect(skillMenu()).toBeNull();
  expect(dialog()).not.toBeNull();
  expect(saves).toHaveLength(0);
  expect(closed).toBe(0);
  expect(field().value).toBe('Plan the retry budget. /');
  await escape(field());
  await until(() => saved.length === 1, 'the draft saved');
  expect(saved[0]!.body).toBe('Plan the retry budget. /');
});

test.skipIf(!hasDom)('the To picker takes the first Escape alone; the next one keeps the draft', async () => {
  await open();
  await type('Pick the agent after.');
  await act(async () => inDialog<HTMLButtonElement>('button[data-compose-to]')!.click());
  await until(() => inDialog('[data-compose-picker]') !== null, 'the To picker');
  await escape(inDialog('[data-compose-picker] input')!);
  expect(inDialog('[data-compose-picker]')).toBeNull();
  expect(saves).toHaveLength(0);
  expect(closed).toBe(0);
  await escape(field());
  await until(() => saved.length === 1, 'the draft saved');
});

test.skipIf(!hasDom)('an Escape inside an IME composition never closes compose, nor the cancel that follows it', async () => {
  await open();
  await type('にほんご');
  await escape(field(), 'composing');
  await escape(field(), '229');
  await act(async () => {
    dialog()!.dispatchEvent(new Event('cancel', { cancelable: true }));
  });
  await settle();
  expect(dialog()).not.toBeNull();
  expect(saves).toHaveLength(0);
  expect(closed).toBe(0);
  expect(field().value).toBe('にほんご');
  await escape(field());
  await until(() => saved.length === 1, 'the draft saved');
});

test.skipIf(!hasDom)("a phone's Cancel keeps the words as a draft too, without asking", async () => {
  await open({ phone: true });
  await type('Written on the train.');
  await act(async () => inDialog<HTMLButtonElement>('[data-compose-cancel]')!.click());
  await settle();
  await until(() => saved.length === 1, 'the draft saved');
  expect(saved[0]!.body).toBe('Written on the train.');
  expect(closed).toBe(0);
});

test.skipIf(!hasDom)('a save that fails keeps compose open with the words and says why', async () => {
  saveFails = 500;
  await open();
  await type('Do not lose this.');
  await escape(field());
  await until(() => inDialog('[data-compose-error]') !== null, 'the error line');
  expect(saves).toHaveLength(1);
  expect(saved).toHaveLength(0);
  expect(closed).toBe(0);
  expect(field().value).toBe('Do not lose this.');
});

test.skipIf(!hasDom)('the saved draft reopens as it was, and an unchanged reopened draft closes on Escape saving nothing', async () => {
  await open();
  await type('Add a progress line to the CLI.');
  await escape(field());
  await until(() => saved.length === 1, 'the draft saved');
  const draft = saved[0]!;
  act(() => root?.unmount());
  host?.remove();
  await open({ draft });
  expect(field().value).toBe('Add a progress line to the CLI.');
  await escape(field());
  expect(closed).toBe(1);
  expect(saves).toHaveLength(1);
});
