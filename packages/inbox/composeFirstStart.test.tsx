/**
 * A fresh Inbox (no projects yet, launch on): New message can still start an agent, in a new scratch folder. Before,
 * an Inbox with no projects said "No agent is running" and offered no start at all, so the first agent could never be
 * started from it. The real ComposeDialog over its `transport` seam, which plays the server.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');

const AGENT = 'claude-code';
const SEND = '[data-compose-send]';

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** The scratch folder the server offers; null: none (scratch starts turned off). */
let scratch: { root: string } | null;
let sends: Record<string, unknown>[];

const model = () => ({
  serverSession: 's',
  home: '/Users/me',
  projects: [],
  launch: {
    agents: [{ agent: AGENT as 'claude-code', name: 'Claude Code', scratch_trusted: true, untrusted: {} }],
    projects: [],
    ...(scratch ? { scratch } : {}),
  },
});

beforeEach(() => {
  if (!hasDom) return;
  scratch = { root: '/Users/me/scratch' };
  sends = [];
  savedFetch = globalThis.fetch;
  // The login shell read ahead (`launchSettingsRead`): its answer is unused.
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

const dialog = () => document.querySelector('dialog[data-compose]') as HTMLDialogElement;
const inDialog = <T extends Element = HTMLElement>(selector: string) => dialog().querySelector<T>(selector);

async function until(check: () => boolean, what: string, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function open(request: { launch?: { agent: string } } = {}, ready = 'button[data-compose-to]:not([data-loading])') {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={request as never}
        phone={false}
        current={null}
        lastSent={null}
        home="/Users/me"
        onSent={() => {}}
        onSaved={() => {}}
        onDeleted={() => {}}
        onClose={() => {}}
        transport={{
          sessions: async () => model(),
          startThread: async (input) => {
            sends.push((input.to as { launch: Record<string, unknown> }).launch);
            return { thread_id: 't1' };
          },
          drafts: false,
          uploads: false,
        }}
      />,
    );
  });
  await until(() => inDialog(ready) !== null, ready);
}

function type(words: string) {
  const text = inDialog<HTMLTextAreaElement>('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)('no projects yet: To offers a new session in a scratch folder, and Send starts it there', async () => {
  await open();
  expect(inDialog('[data-compose-note="none"]')).toBeNull();
  act(() => inDialog('button[data-compose-to]')!.click());
  await until(() => inDialog(`[data-compose-start="${AGENT}"]`) !== null, 'the start row');
  act(() => inDialog(`[data-compose-start="${AGENT}"]`)!.click());
  await until(() => inDialog('[data-compose-to="start"]') !== null, 'To names the start');
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder')).toBe('scratch');
  type('Set up a small site.');
  act(() => inDialog(SEND)!.click());
  await until(() => sends.length === 1, 'the Send');
  expect(sends[0]).toMatchObject({ agent: AGENT, scratch: true });
});

test.skipIf(!hasDom)('Add agent on a fresh Inbox picks the scratch folder for it', async () => {
  await open({ launch: { agent: AGENT } });
  await until(() => inDialog('[data-compose-to="start"]') !== null, 'To names the start');
  expect(inDialog('[data-compose-folder]')!.getAttribute('data-compose-folder')).toBe('scratch');
});

test.skipIf(!hasDom)('no projects and no scratch folder: still nothing to start, and the note says so', async () => {
  scratch = null;
  await open({}, '[data-compose-note="none"]');
  expect(inDialog('[data-compose-to="start"]')).toBeNull();
});
