/**
 * A key typed in the reply never re-renders the thread pane: not in the thread's own reply box, and not in full
 * screen's composer card. The card used to take the words from the thread pane, which followed them key by key while
 * the card showed: every message of the thread rendered again on every key (7 to 10 ms a key in a 120-message thread,
 * whatever the length of the words). Now the card reads the reply box's words itself (replyText.ts), as the box's
 * field does.
 *
 * Counted as React's devtools count a render (a commit in which the ThreadPane did work), over the real ThreadPane: a
 * thread of 24 messages, its reply box, and an image open full screen, over a stubbed fetch.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-attachments';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';

// React DOM reports each commit to a devtools hook it finds when it loads: set before it loads (the imports below).
type Fiber = { type: unknown; flags: number; child: Fiber | null; sibling: Fiber | null };
let onCommit: (current: Fiber) => void = () => {};
if (hasDom) {
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => onCommit(root.current),
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
  };
}
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { resetComposerState } = (hasDom ? await import('./fullScreenComposer') : {}) as typeof import('./fullScreenComposer');

/** React's PerformedWork flag: the component rendered in that commit (a bail-out leaves it unset). */
const PERFORMED_WORK = 1;
let rendered = 0;
// Read at the commit itself: the next one reuses the fibers.
onCommit = (current) => {
  const stack: Fiber[] = [current];
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    if (fiber.type === ThreadPane) {
      if ((fiber.flags & PERFORMED_WORK) !== 0) rendered++;
      return;
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
};
/** How many commits rendered the thread pane since the last call. */
function paneRenders(): number {
  const count = rendered;
  rendered = 0;
  return count;
}

const noop = () => {};
const STAMP = '2026-10-16T17:00:00.000Z';
const THREAD = 'msg_01M4XXVG0ZCPSD10B1KPG7DP00';
const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: STAMP };
const IMAGE: InboxAttachmentState = {
  id: 'att_01M4XXVG0ZCPSD10B1KPG7DPIM',
  message_id: THREAD,
  path: '/work/ledger/shot.png',
  named_path: null,
  name: 'shot.png',
  kind: 'image',
  sent_sha256: 'a'.repeat(64),
  size: 68,
  sent_at: STAMP,
  sent_mtime: STAMP,
  media_type: 'image/png',
  width: 1,
  height: 1,
  current: { sha256: 'a'.repeat(64), size: 68, mtime: STAMP },
  changed_since_sent: false,
  unavailable: null,
};

function thread(): InboxThread {
  const messages: InboxMessageWire[] = Array.from({ length: 24 }, (_, i) => ({
    id: i === 0 ? THREAD : `msg_01M4XXVG0ZCPSD10B1KPG7D${String(i).padStart(3, '0')}`,
    project_id: PROJECT.id,
    thread_id: THREAD,
    reply_to: null,
    author: i % 2 === 0 ? { kind: 'agent', host: 'claude-code', name: 'Claude Code', session: 'ses_a' } : { kind: 'person', name: 'me' },
    subject: 'The checkout screen',
    subject_question: null,
    body: `Message ${i} about the checkout screen.`,
    created_at: STAMP,
    resolved_at: null,
    idempotency_key: null,
    ...(i === 0 ? { attachments: [IMAGE] } : {}),
  })) as InboxMessageWire[];
  return { thread_id: THREAD, project: PROJECT, subject: 'The checkout screen', thread_name: null, resolved_at: null, messages };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input instanceof Request ? input.url : input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      if (path.endsWith('/draft')) return Response.json({ draft: { v: 1, thread_id: THREAD, body: String(body.body ?? ''), created_at: STAMP, updated_at: new Date().toISOString() } });
      return Response.json({});
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [IMAGE], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    if (path.includes('/artifact-pins')) return Response.json({ pins: [] });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetComposerState?.();
  globalThis.fetch = savedFetch;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** One key typed at the end of the card's field, as the browser gives it. */
function key(el: HTMLTextAreaElement, ch: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, el.value + ch);
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
  });
}

function mount(file: { id: string; version: 'current'; focus: null; view: 'full' } | null) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<ThreadPane thread={thread()} sent={null} onQuestions={noop} onChanged={async () => {}} onClose={noop} file={file} onOpenFile={noop} onOpenGuide={noop} />);
  });
}

/** Types `words` into `field`: the first key alone (it opens the reply box, which the pane draws once), then the rest, counted. */
async function typeCounted(field: HTMLTextAreaElement, words: string): Promise<number> {
  key(field, words[0]!);
  await settle();
  expect(paneRenders()).toBeGreaterThan(0);
  for (const ch of words.slice(1)) key(field, ch);
  return paneRenders();
}

describe.skipIf(!hasDom)('a key typed in the reply', () => {
  test("in full screen's card re-renders none of the thread behind it", async () => {
    mount({ id: IMAGE.id, version: 'current', focus: null, view: 'full' });
    await settle();
    const card = host!.querySelector<HTMLElement>('[data-fcomp]');
    expect(card).not.toBeNull();
    const replyTab = card!.querySelector<HTMLButtonElement>('[role="radio"][data-fcomp-mode="reply"]');
    if (replyTab && replyTab.getAttribute('aria-checked') !== 'true') await act(async () => replyTab.click());
    const field = host!.querySelector<HTMLTextAreaElement>('[data-fcomp] [data-fcomp-field] textarea')!;
    expect(await typeCounted(field, 'Looks good, ship it')).toBe(0);
    expect(field.value).toBe('Looks good, ship it');
  });

  test("in the thread's reply box re-renders none of the thread", async () => {
    mount(null);
    await settle();
    const reply = [...host!.querySelectorAll<HTMLButtonElement>('.ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply')!;
    await act(async () => reply.click());
    await settle();
    const field = host!.querySelector<HTMLTextAreaElement>('.ib-pfoot textarea')!;
    expect(await typeCounted(field, 'Looks good, ship it')).toBe(0);
    expect(field.value).toBe('Looks good, ship it');
  });
});
