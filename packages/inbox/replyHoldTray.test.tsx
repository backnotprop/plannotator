/**
 * On a phone, holding Reply opens the reaction tray (owner, 2026-11-07, approval "inbox-reaction-tray"), on the
 * real ThreadPane. Failures to catch: a hold that does not open the tray; a hold that opens the reply box as
 * well (the click that ends it not swallowed); a plain tap on Reply no longer opening the reply box, or opening
 * the tray; a finger that moves (a scroll starting on Reply) still counting as a hold; the browser's long-press
 * menu not blocked; a computer's Reply taking holds at all.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { HOLD_MS } = await import('./holdPress');
const { resetSavedReactionsForTests } = await import('./reactions');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing', created_at: '2026-11-07T09:00:00.000Z' };
const AGENT: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const M1 = 'msg_01M6REPLYHOLD00000000000001';

const THREAD: InboxThread = {
  thread_id: M1,
  project: PROJECT,
  subject: 'Retry',
  thread_name: null,
  resolved_at: null,
  messages: [
    {
      id: M1,
      project_id: PROJECT.id,
      thread_id: M1,
      reply_to: null,
      author: AGENT,
      subject: 'Retry',
      body: 'The retry now keeps the same key. Tests pass.',
      created_at: '2026-11-07T10:15:00.000Z',
      resolved_at: null,
      idempotency_key: null,
      seq: 1,
    },
  ],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let acks: unknown[][] = [];

beforeEach(() => {
  if (!hasDom) return;
  acks = [];
  resetSavedReactionsForTests([{ emoji: '🚀', label: 'Ship it' }]);
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  resetSavedReactionsForTests();
  document.body.innerHTML = '';
});

const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

async function render(phone: boolean) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={THREAD}
        sent={null}
        phone={phone}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        onAck={(id, on, _agent, reaction) => acks.push([id, on, reaction ?? null])}
      />,
    );
  });
  await wait(20);
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const reply = () => $('[data-reply-button]') as HTMLButtonElement;
const tray = () => $('[data-reaction-tray]');
const replyBox = () => $('.ib-rbox');

const touch = (type: string, x = 20, y = 20) => new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'touch', clientX: x, clientY: y });

/** A finger on Reply for `ms`, then lifted where it went down (the browser's click follows a lift that did not move). */
async function finger(el: HTMLElement, ms: number, moveTo?: { x: number; y: number }) {
  await act(async () => {
    el.dispatchEvent(touch('pointerdown'));
  });
  if (moveTo) {
    await act(async () => {
      el.dispatchEvent(touch('pointermove', moveTo.x, moveTo.y));
    });
  }
  await wait(ms);
  await act(async () => {
    el.dispatchEvent(touch('pointerup', moveTo?.x, moveTo?.y));
    if (!moveTo) el.click();
  });
  await wait(60);
}

test.skipIf(!hasDom)('a phone: holding Reply opens the reaction tray and not the reply box; the tray reacts', async () => {
  await render(true);
  const button = reply();
  expect(button).not.toBeNull();
  expect(replyBox()).toBeNull();
  // The hold is the tray's: no text selection or callout (inbox.css keys on this mark).
  expect(button.hasAttribute('data-reply-hold')).toBe(true);
  // The browser's own long-press menu is blocked.
  const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  act(() => void button.dispatchEvent(menu));
  expect(menu.defaultPrevented).toBe(true);

  // While the finger rests, the light cue; at the hold, the tray, and the click that ends it opens nothing.
  await act(async () => {
    button.dispatchEvent(touch('pointerdown'));
  });
  expect(reply().hasAttribute('data-holding')).toBe(true);
  await wait(HOLD_MS + 80);
  expect(tray()).not.toBeNull();
  expect(reply().hasAttribute('data-holding')).toBe(false);
  await act(async () => {
    button.dispatchEvent(touch('pointerup'));
    button.click();
  });
  await wait(80);
  expect(replyBox()).toBeNull();
  expect(tray()).not.toBeNull();

  // The tray it opened is the real one: the saved emoji reacts with its name.
  await act(async () => $('[data-reaction-tray] [data-reaction="saved-0"]')!.click());
  await wait(60);
  expect(acks).toEqual([[M1, true, { emoji: '🚀', label: 'Ship it' }]]);
});

test.skipIf(!hasDom)('a phone: a tap on Reply still opens the reply box, with no tray; a finger that moves is no hold', async () => {
  await render(true);
  await finger(reply(), 80);
  expect(tray()).toBeNull();
  expect(replyBox()).not.toBeNull();
  expect(acks).toEqual([]);

  // A scroll starting on Reply: the finger moves away, rests past the hold, and nothing opens.
  act(() => root?.unmount());
  host?.remove();
  await render(true);
  await finger(reply(), HOLD_MS + 80, { x: 20, y: 80 });
  expect(tray()).toBeNull();
  expect(replyBox()).toBeNull();

  // And a tap after a hold is a tap again (the hold's swallowed click does not stick).
  await finger(reply(), HOLD_MS + 80);
  expect(tray()).not.toBeNull();
  expect(replyBox()).toBeNull();
});

test.skipIf(!hasDom)('a computer: Reply takes no hold (a click opens the reply box as before)', async () => {
  await render(false);
  expect(reply().hasAttribute('data-reply-hold')).toBe(false);
  await finger(reply(), HOLD_MS + 80);
  expect(tray()).toBeNull();
  expect(replyBox()).not.toBeNull();
});
