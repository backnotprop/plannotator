/**
 * An attached HTML file opens in Interact (a click does what the page says), on a computer as on a phone, and the
 * person's Annotate or Interact carries to every HTML file they open next in the same thread: a step either way, a
 * file opened again after closing one. Another thread starts in Interact. A read-only file runs in Interact whatever
 * the thread chose. In Interact a `]` or `[` from inside the page still steps (the bridge offers one the page did not
 * use; bridgeStepKey.test.ts has the bridge's side).
 *
 * What would regress: a file opening in Annotate again, the pane resetting the choice on each file, the choice
 * leaking into another thread, or stepping from inside a page in Interact doing nothing.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentSequence, type AttachmentStep } from './stepping';
import { useThreadArmed } from './threadArmed';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

const MA = 'msg_01K7MAMMMMMMMMMMMMMMMMMMMM';
const MB = 'msg_01K7MBMMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string, messageId: string): InboxAttachmentState {
  return {
    id,
    name,
    path: `/work/shop/${name}`,
    kind: 'html',
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-10T10:42:00.000Z',
    sent_mtime: '2026-10-10T10:42:00.000Z',
    message_id: messageId,
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
  };
}

const one = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'one.html', MA);
const two = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'two.html', MA);
const three = file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'three.html', MA);
const other = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'other.html', MB);

function message(id: string): InboxMessageWire {
  return { id, created_at: '2026-10-10T10:42:00.000Z', author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' } } as unknown as InboxMessageWire;
}

const THREADS: Record<string, AttachmentStep[]> = {
  A: attachmentSequence([message(MA)], [one, two, three]),
  B: attachmentSequence([message(MB)], [other]),
};

function stubViews() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const att = [one, two, three, other].find((a) => url.includes(a.id));
    if (att && url.includes('/view')) {
      const html = `<h1>${att.name}</h1><button>Go</button>`;
      return new Response(JSON.stringify({ attachment: att, version: 'current', text: html, html }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

interface Driver {
  /** Open a file of a thread, as a tile or a link in the window does (another thread: the thread changes first). */
  open: (threadId: string, file: InboxAttachmentState | null) => void;
}

/** The window as ThreadPane drives the pane: the thread's choice from `useThreadArmed`, a step opening the next file in place. */
function Window({ driver, phone = false, full = true, readOnly = [] }: { driver: Driver; phone?: boolean; full?: boolean; readOnly?: string[] }) {
  const [threadId, setThreadId] = useState('A');
  const [open, setOpen] = useState<InboxAttachmentState | null>(one);
  driver.open = (id, next) => {
    setThreadId(id);
    setOpen(next);
  };
  const armed = useThreadArmed(threadId);
  const steps = THREADS[threadId]!;
  const all = steps.map((s) => s.attachment);
  const noop = () => {};
  if (!open) return null;
  return (
    <AttachmentPane
      attachment={open}
      attachments={all}
      records={[]}
      agent="Claude"
      projectName="shop"
      projectRoot="/work/shop"
      version="current"
      onVersion={noop}
      full={full || phone}
      fullLocked={phone}
      onToggleFull={noop}
      focusId={null}
      readOnly={readOnly.includes(open.id)}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={() => setOpen(null)}
      strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      steps={steps}
      phone={phone}
      armedStart={armed.armedStart}
      onArmed={armed.onArmed}
      onStep={(id) => setOpen(all.find((a) => a.id === id)!)}
    />
  );
}

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  await settle();
}

async function settle(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const pane = () => host!.querySelector<HTMLElement>('[data-attachment-pane]');
const openName = () => pane()?.getAttribute('aria-label')?.split(',')[0] ?? null;
const pen = () => host!.querySelector<HTMLButtonElement>('[data-full-view-pen], [data-html-annotate-toggle]');
const penOn = () => pen()?.getAttribute('aria-pressed');
const click = async (el: HTMLElement | null) => {
  await act(async () => el!.click());
  await settle();
};
async function key(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await settle();
  return event;
}
/** A `]` or `[` the page's bridge offered, with the page holding focus (a key pressed inside it). */
async function stepFromPage(dir: 1 | -1) {
  const iframe = pane()!.querySelector('iframe')!;
  await act(async () => iframe.focus());
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'plannotator-bridge-step', dir } }));
  });
  await settle(200);
}
const driverOf = (): Driver => ({ open: () => {} });

test.skipIf(!hasDom)('an HTML file opens in Interact on a computer, full screen and beside the thread', async () => {
  stubViews();
  await render(<Window driver={driverOf()} />);
  expect(openName()).toBe('one.html');
  expect(penOn()).toBe('false');
  act(() => root?.unmount());
  host?.remove();
  await render(<Window driver={driverOf()} full={false} />);
  expect(penOn()).toBe('false');
});

test.skipIf(!hasDom)('Annotate carries to the next file and back; Interact carries too; in Interact ] [ from inside the page still step', async () => {
  stubViews();
  await render(<Window driver={driverOf()} />);
  // Interact on one.html: a ] the page did not use steps to two.html, still in Interact.
  await stepFromPage(1);
  expect(openName()).toBe('two.html');
  expect(penOn()).toBe('false');
  // Annotate on, then ] from the pane: three.html opens in Annotate.
  await click(pen());
  expect(penOn()).toBe('true');
  await key(pane()!, { key: ']' });
  expect(openName()).toBe('three.html');
  expect(penOn()).toBe('true');
  // Back with [: still Annotate.
  await key(pane()!, { key: '[' });
  expect(openName()).toBe('two.html');
  expect(penOn()).toBe('true');
  // Off again, and [ from inside the page: one.html in Interact.
  await click(pen());
  await stepFromPage(-1);
  expect(openName()).toBe('one.html');
  expect(penOn()).toBe('false');
});

test.skipIf(!hasDom)('the choice lasts while the thread is open: a file closed and another opened keeps it; another thread starts in Interact, and so does this one opened again', async () => {
  stubViews();
  const driver = driverOf();
  await render(<Window driver={driver} />);
  await click(pen());
  expect(penOn()).toBe('true');
  // Closed, then another file of the thread opened from its tile: Annotate.
  await act(async () => driver.open('A', null));
  await settle();
  expect(pane()).toBeNull();
  await act(async () => driver.open('A', three));
  await settle();
  expect(openName()).toBe('three.html');
  expect(penOn()).toBe('true');
  // Another thread's file, with this pane still open: Interact.
  await act(async () => driver.open('B', other));
  await settle();
  expect(openName()).toBe('other.html');
  expect(penOn()).toBe('false');
  // Back to the first thread: it starts over in Interact.
  await act(async () => driver.open('A', two));
  await settle();
  expect(openName()).toBe('two.html');
  expect(penOn()).toBe('false');
});

test.skipIf(!hasDom)('a phone opens every HTML file in Interact, as before', async () => {
  stubViews();
  await render(<Window driver={driverOf()} phone />);
  expect(penOn()).toBe('false');
  await stepFromPage(1);
  expect(openName()).toBe('two.html');
  expect(penOn()).toBe('false');
});

test.skipIf(!hasDom)('a read-only file runs in Interact whatever the thread chose (no pen, no Annotate rung), and the choice is back on the next file', async () => {
  stubViews();
  await render(<Window driver={driverOf()} readOnly={[two.id]} />);
  await click(pen());
  expect(penOn()).toBe('true');
  await key(pane()!, { key: ']' });
  expect(openName()).toBe('two.html');
  expect(pen()).toBeNull();
  // Escape's first press in full screen is not an Annotate rung here: nothing is said about Interact.
  const live = () => host!.querySelector('[data-step-live]')!.textContent;
  await key(pane()!, { key: 'Escape' });
  expect(live()).not.toBe('Interact: clicks reach the page.');
  await key(pane()!, { key: ']' });
  expect(openName()).toBe('three.html');
  expect(penOn()).toBe('true');
});
