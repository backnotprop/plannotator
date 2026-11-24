/**
 * A thread pane that throws while it draws fails alone (thread/ThreadSlot.tsx puts the pane in ui's RegionBoundary),
 * its Try again loses no reply being typed, and its Back closes the pane.
 *
 * The pane unmounts when the boundary takes its place. The reply box's words wait for a pause in typing before they
 * are saved (replyDraft.ts, REPLY_DRAFT_SAVE_MS); the unmount must send them at once, and Try again must open the box
 * holding them again, read back from the server draft. The notice takes the header's own Back, and the page's address
 * names the thread (Reload opens it again), so the notice has a Back in the header's words that closes the pane.
 *
 * What regresses if this fails: ThreadSlot no longer keeps a failure in the pane (the window goes); a render error, or
 * the Try again after it, throws away the words typed in the last half second; a phone is left on a failed thread with
 * no way back to the list.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';
import type { Route } from './app/route';
import { machinesModel } from './machines';
import { createPanesOnScreen } from './panes/onScreen';
import { NO_OPEN, type PaneReads } from './panes/paneReads';
import { createKeyedSignal } from './signal';
import { createStepsBus } from './steps/useThreadSteps';
import type { ThreadSlotHost } from './thread/slotHost';

const hasDom = typeof document !== 'undefined';
const { ThreadSlot } = (hasDom ? await import('./thread/ThreadSlot') : {}) as typeof import('./thread/ThreadSlot');
const { catchRenderErrorsInTests } = (hasDom ? await import('@plannotator/ui/components/RegionBoundary') : {}) as typeof import('@plannotator/ui/components/RegionBoundary');

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

const noop = () => {};
const none = async () => null;
/** Where the pane's close sent the window. */
let closedTo: Route[] = [];

/**
 * The window's side of the slot, as panes/twoSlots.test.tsx builds it. The part that throws is drawn inside the
 * thread pane, in the stale-page notice's place (shown on a phone and in a stacked window).
 */
function hostFor(phone: boolean): ThreadSlotHost {
  const route: Route = { page: 'inbox', project: null, thread: THREAD };
  const paneReads = { view: () => ({ ...NO_OPEN }), retry: noop, park: noop } as unknown as PaneReads;
  return {
    route, routeRef: { current: route }, rowsPending: false, paneReads,
    outbox: new Map(), dismissOutbox: noop, phone, stack: { thread: !phone, file: false }, full: false, fromCard: null,
    fileOpen: false, staleNotice: <Part />, notifyAgainIn: null, notifications: {} as ThreadSlotHost['notifications'], soundOn: false, settings: null,
    saveTour: noop, go: noop, leave: noop, close: (next) => void closedTo.push(next), openCompose: noop, pullReviewOf: null, reviewView: null, pullsShown: false,
    stepsBus: createStepsBus(), boardEnabled: null, cards: null, backToCard: noop, openThreadRow: null, snoozeBack: null,
    refreshThread: none, refreshList: none, shown: null, markRead: none, markUnread: none, acknowledge: none,
    markAction: none, archive: none, pinnedIds: new Set(), pinsOn: false, machines: machinesModel([]), setPin: none, setPriority: noop,
    snoozeOn: false, snooze: noop, unsnooze: noop, setMachineUpdateOpen: noop, threadAgentContext: null, replyFor: null, setReplyFor: noop,
    draftSignals: createKeyedSignal(), filesSignals: createKeyedSignal(),
    ask: { side: undefined, sideWords: undefined }, askReply: null, setAskReply: noop,
    patchQuestions: noop, onPickSaves: noop, afterWrite: async () => {}, rowPatches: new Map(), decideInThread: () => null,
    searchLanding: { current: null }, decideLanding: { current: null }, landed: noop,
    seenOnSight: noop, covered: false, panesOnScreen: createPanesOnScreen(), setOpenThreadCovered: noop, listTitle: 'Inbox', fullSidebar: true,
    setThreadFull: noop, leaveFull: noop, showToast: noop, inboxLink: () => null,
    holdSidebarIfTight: noop, backFromFile: { current: null },
  };
}

const queries = new QueryClient();

/** The window: a list beside the slot, and a way to draw the slot again with `broken.on` set. */
function Window({ phone = false }: { phone?: boolean }) {
  const [, redraw] = useState(0);
  return (
    <QueryClientProvider client={queries}>
      <div className="pn-inbox">
        <button type="button" data-testid="list" onClick={() => redraw((n) => n + 1)}>
          list
        </button>
        <ThreadSlot paneId="main" threadId={THREAD} active held={{ serverSession: 's', cursor: 0, thread: thread() }} host={hostFor(phone)} />
      </div>
    </QueryClientProvider>
  );
}

function draw(phone = false): HTMLElement {
  const box = document.createElement('div');
  host = box;
  document.body.appendChild(box);
  act(() => {
    root = createRoot(box);
    root.render(<Window phone={phone} />);
  });
  return box;
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
  const page = draw();
  await settle();
  const field = page.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')!;
  expect(field.value).toBe(KEPT);
  field.focus();
  typeInto(field, 'cap it at 30 s');
  // Typed just now: still waiting for the pause before its save.
  expect(saves).toEqual([]);

  broken.on = true;
  click(page.querySelector('[data-testid="list"]'));
  await settle();
  const notice = page.querySelector('[data-region-failed="Thread pane"]');
  expect(notice?.textContent).toContain("This part didn't load");
  expect(page.querySelector('[data-testid="list"]')).not.toBeNull();
  // The pane went, and its words went to the server as it did.
  expect(page.querySelector('.ib-rbox')).toBeNull();
  expect(saves).toEqual([`${KEPT}cap it at 30 s`]);

  broken.on = false;
  click(page.querySelector('[data-region-try-again]'));
  await settle();
  expect(page.querySelector('[data-region-failed]')).toBeNull();
  expect(page.querySelector<HTMLTextAreaElement>('.ib-rbox textarea')?.value).toBe(`${KEPT}cap it at 30 s`);
});

for (const phone of [true, false]) {
  test.skipIf(!hasDom)(`${phone ? 'on a phone' : 'beside the list'}, the failed pane's Back to Inbox, in the header's words, closes the pane`, async () => {
    closedTo = [];
    broken.on = false;
    const page = draw(phone);
    await settle();
    // The header's own Back says where it goes ("Back to Inbox"); the notice's says the same.
    const back = page.querySelector(phone ? '[data-phone-back]' : '[data-stack-back]');
    expect(back?.getAttribute('aria-label')).toBe('Back to Inbox');

    broken.on = true;
    click(page.querySelector('[data-testid="list"]'));
    await settle();
    const notice = page.querySelector('[data-region-failed="Thread pane"]');
    expect(notice).not.toBeNull();
    // The header went with the pane: the notice's buttons are the way out.
    expect(page.querySelector('[data-phone-back], [data-stack-back]')).toBeNull();
    expect([...notice!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Try again', 'Reload', 'Copy error', 'Back to Inbox']);
    click(notice!.querySelector('[data-region-close]'));
    expect(closedTo).toEqual([{ page: 'inbox', project: null, thread: null, file: null }]);
  });
}
