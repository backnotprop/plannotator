/**
 * A launched thread's ⋯ on a tailnet guest's page: no Stop and no Delete, as
 * the server answers both `owner_only` (inbox-tailnet-owner.test.ts). The
 * owner's ⋯ keeps both.
 *
 * The failure this catches: a guest pressing Stop or Delete only to get an
 * error, or the owner losing either.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'app-abcdef', name: 'app', root: '/work/app', created_at: '2026-10-20T09:00:00.000Z' };
const PERSON = { kind: 'person' } as InboxAuthor;
const ROOT = 'msg_L1';

const LAUNCHED: InboxThread = {
  thread_id: ROOT,
  project: PROJECT,
  subject: 'Fix the build',
  thread_name: null,
  resolved_at: null,
  messages: [
    {
      id: ROOT,
      project_id: PROJECT.id,
      thread_id: ROOT,
      reply_to: null,
      author: PERSON,
      to: { host: 'claude-code', session: 'sess-a' },
      subject: 'Fix the build',
      subject_question: null,
      body: 'Fix the build.',
      created_at: '2026-10-20T18:10:00.000Z',
      resolved_at: null,
      idempotency_key: 'k-a',
      launch: { id: 'lch_a', agent: 'claude-code', session_ref: 'sa', folder: '/work/app', scratch: false, started_at: '2026-10-20T18:10:00.000Z' },
    } as InboxMessageWire,
  ],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const restore: (() => void)[] = [];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const undo of restore.splice(0).reverse()) undo();
});

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function press(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
  });
}

/** The launch items of the open thread's ⋯ (`data-launch-item`), top to bottom. */
async function launchItems(guest: boolean): Promise<string[]> {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json({})) as typeof fetch;
  restore.push(() => {
    globalThis.fetch = savedFetch;
  });
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <ThreadPane
        thread={LAUNCHED}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        // Resting: the owner's ⋯ offers Stop then too.
        run={null}
        remote={true}
        guest={guest}
      />,
    );
  });
  await until(() => !!host!.querySelector('[data-thread-more]'), 'the ⋯ button');
  await press(host!.querySelector('[data-thread-more]')!);
  await until(() => !!document.querySelector('[data-thread-menu]'), 'the ⋯ menu');
  const items = [...document.querySelectorAll('[data-thread-menu] [data-launch-item]')].map((el) => el.getAttribute('data-launch-item')!);
  act(() => root!.unmount());
  host!.remove();
  root = null;
  host = null;
  return items;
}

test.skipIf(!hasDom)("a tailnet guest's ⋯ has no Stop or Delete for a launched agent; the owner's over the tailnet keeps both", async () => {
  expect(await launchItems(false)).toEqual(['stop', 'delete']);
  expect(await launchItems(true)).toEqual([]);
});
