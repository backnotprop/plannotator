/**
 * A thread pane that throws while it draws fails alone, and its Try again loses no reply being typed
 * (thread/ThreadSlot.tsx puts the pane in ui's RegionBoundary).
 *
 * The pane unmounts when the boundary takes its place. The reply box's words wait for a pause in typing before they
 * are saved (replyDraft.ts, REPLY_DRAFT_SAVE_MS); the unmount must send them at once, and Try again must open the box
 * holding them again, read back from the server draft. What regresses if this fails: a render error, or the Try again
 * after it, throws away the words typed in the last half second.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { RegionBoundary, catchRenderErrorsInTests } = (hasDom ? await import('@plannotator/ui/components/RegionBoundary') : {}) as typeof import('@plannotator/ui/components/RegionBoundary');

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-02T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const THREAD = 'msg_01M6RB0000000000000000001';
const KEPT = 'Mostly yes. ';

const message: InboxMessageWire = {
  id: THREAD,
  project_id: PROJECT.id,
  thread_id: THREAD,
  reply_to: null,
  author: A,
  subject: 'Retry worker',
  body: 'The worker drains in order.',
  created_at: '2026-11-02T10:01:00.000Z',
  resolved_at: null,
  idempotency_key: null,
};
const thread = (): InboxThread => ({ thread_id: THREAD, project: PROJECT, subject: 'Retry worker', thread_name: null, resolved_at: null, messages: [message] });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let saves: string[] = [];
let stored = KEPT;
const restores: Array<() => void> = [];

beforeEach(() => {
  if (!hasDom) return;
  saves = [];
  stored = KEPT;
  savedFetch = globalThis.fetch;
  const draft = (body: string): InboxReplyDraft => ({ v: 1, thread_id: THREAD, body, created_at: '2026-11-02T10:10:00.000Z', updated_at: new Date().toISOString() });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('/draft')) {
      if (init?.method === 'POST') {
        stored = JSON.parse(String(init.body)).body as string;
        saves.push(stored);
      }
      return Response.json({ serverSession: 's', draft: draft(stored) });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
  restores.push(catchRenderErrorsInTests());
  const error = console.error;
  console.error = () => {};
  restores.push(() => {
    console.error = error;
  });
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  while (restores.length > 0) restores.pop()!();
});

async function settle(turns = 4, ms = 20) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

/** Something in the pane that throws on demand (the "+" that blanked the window). */
const broken = { on: false };
function Part() {
  if (broken.on) throw new TypeError('range is undefined');
  return null;
}

/** The window: a list beside the pane, and a way to draw the pane again with `broken.on` set. */
function Window() {
  const [, redraw] = useState(0);
  return (
    <div className="pn-inbox">
      <button type="button" data-testid="list" onClick={() => redraw((n) => n + 1)}>
        list
      </button>
      <RegionBoundary name="Thread pane" className="ib-pane ib-pempty" resetKey={THREAD}>
        <Part />
        <ThreadPane thread={thread()} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </RegionBoundary>
    </div>
  );
}

function typeInto(field: HTMLTextAreaElement, text: string) {
  const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  for (const char of text) {
    act(() => {
      setText.call(field, field.value + char);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

const click = (el: Element | null) =>
  act(() => {
    (el as HTMLElement).click();
  });

test.skipIf(!hasDom)('a thread pane that throws keeps the list, sends the words being typed, and Try again opens the box holding them', async () => {
  broken.on = false;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Window />);
  });
  await settle();
  const field = host.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')!;
  expect(field.value).toBe(KEPT);
  field.focus();
  typeInto(field, 'cap it at 30 s');
  // Typed just now: still waiting for the pause before its save.
  expect(saves).toEqual([]);

  broken.on = true;
  click(host.querySelector('[data-testid="list"]'));
  await settle();
  const notice = host.querySelector('[data-region-failed="Thread pane"]');
  expect(notice?.textContent).toContain("This part didn't load");
  expect(host.querySelector('[data-testid="list"]')).not.toBeNull();
  // The pane went, and its words went to the server as it did.
  expect(host.querySelector('.ib-rbox')).toBeNull();
  expect(saves).toEqual([`${KEPT}cap it at 30 s`]);

  broken.on = false;
  click(host.querySelector('[data-region-try-again]'));
  await settle();
  expect(host.querySelector('[data-region-failed]')).toBeNull();
  expect(host.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')?.value).toBe(`${KEPT}cap it at 30 s`);
});
