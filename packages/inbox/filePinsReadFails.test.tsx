/**
 * A file opens whatever the artifact pins read answers (approval "inbox-artifact-stars"; artifactPins.ts). The
 * window asks for every machine's pins (`/artifact-pins?machines=1`) when a file's pin draws; an older linked
 * Inbox, a proxy's error body, a 404 from an older server or a network failure can answer that read. Each is "no
 * pins known" (or the pins already shown): no throw, no unhandled rejection, and the file draws beside the thread
 * and full screen.
 *
 * Failures to catch: an answer of another shape (`{}`) reaching the store as pins (it threw, the read rejected
 * unhandled, and the file view never drew); a failed read taking away pins already shown.
 *
 * The real ThreadPane, file view and pin store, with fetch answering for the Inbox; no Inbox server.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { InboxArtifactPin } from '@plannotator/core/inbox-artifact-pins';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { resetArtifactPinsForTest, readArtifactPins, useArtifactPins } = (hasDom ? await import('./artifactPins') : {}) as typeof import('./artifactPins');

const PROJECT: InboxProject = { id: 'prj_1', key: 'retry-abcdef', name: 'retry', root: '/work/retry', created_at: '2026-11-08T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const ROOT = 'msg_01K7PINSREADPINSREADPINS01';

const MESSAGE = {
  id: ROOT,
  project_id: PROJECT.id,
  thread_id: ROOT,
  reply_to: null,
  author: AGENT,
  subject: 'Retry budget',
  subject_question: null,
  body: 'The notes are attached.',
  created_at: '2026-11-08T10:00:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  attachments: [],
  questions: [],
} as unknown as InboxMessageWire;

const THREAD = { thread_id: ROOT, project: PROJECT, subject: 'Retry budget', thread_name: null, resolved_at: null, messages: [MESSAGE] } as unknown as InboxThread;

const NOTES = {
  id: 'att_01K7PINSREADPINSREADPINS01',
  name: 'notes.md',
  path: '/work/retry/notes.md',
  kind: 'markdown',
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  size: 100,
  sent_at: '2026-11-08T10:00:00.000Z',
  sent_mtime: '2026-11-08T10:00:00.000Z',
  message_id: ROOT,
  changed_since_sent: false,
  unavailable: null,
  current: { sha256: 'a'.repeat(64), size: 100, mtime: '2026-11-08T10:00:00.000Z' },
} as InboxAttachmentState;

const SHOWN: InboxArtifactPin = { key: NOTES.id, thread_id: ROOT, pinned_at: '2026-11-08T11:00:00.000Z' };

/** How the pins route answers. */
const ANSWERS: { name: string; answer: () => Promise<Response> }[] = [
  { name: 'an answer of another shape ({})', answer: async () => Response.json({}) },
  { name: 'a 404 (an older server)', answer: async () => new Response('Not found', { status: 404 }) },
  { name: 'a 500 with a proxy body', answer: async () => new Response('<html>Bad gateway</html>', { status: 500, headers: { 'Content-Type': 'text/html' } }) },
  { name: 'a failed fetch (the network went)', answer: () => Promise.reject(new TypeError('Failed to fetch')) },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
let pinReads = 0;
const unhandled: unknown[] = [];
const onUnhandled = (cause: unknown) => unhandled.push(cause);

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  process.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  unhandled.length = 0;
  if (hasDom) {
    resetArtifactPinsForTest();
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
    window.sessionStorage.clear();
  }
});

function serve(pins: () => Promise<Response>) {
  pinReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/artifact-pins')) {
      pinReads += 1;
      return pins();
    }
    if (url.includes(NOTES.id) && url.includes('/view')) {
      return Response.json({ attachment: NOTES, version: 'current', text: '# Notes\n\nThe budget is five attempts with a one second start.\n', html: null });
    }
    if (url.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [NOTES], annotations: [] });
    return Response.json({});
  }) as typeof fetch;
}

/** The pins the store shows, as a count on the page. */
function PinsShown() {
  const { pins } = useArtifactPins();
  return <output data-pins-shown={pins === null ? 'unknown' : String(pins.length)} />;
}

function Opened({ view }: { view: 'full' | 'side' }) {
  return (
    <div className="pn-inbox">
      <ThreadPane
        thread={THREAD}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={{ id: NOTES.id, version: 'current', focus: null, view }}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
      />
      <PinsShown />
    </div>
  );
}

async function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

const shown = () => document.querySelector('[data-pins-shown]')?.getAttribute('data-pins-shown');
const fileDrawn = () => document.body.textContent!.includes('five attempts');

for (const { name, answer } of ANSWERS) {
  test.skipIf(!hasDom)(`the pins read answers ${name}: the file opens full screen, with no pins known`, async () => {
    serve(answer);
    await mount(<Opened view="full" />);
    await until(() => document.querySelector('[data-full-view-bar]') !== null, 'the full-screen bar');
    await until(fileDrawn, 'the file');
    await until(() => shown() === '0', 'no pins known');
    expect(pinReads).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);
  });

  test.skipIf(!hasDom)(`the pins read answers ${name}: the file opens beside the thread, with no pins known`, async () => {
    serve(answer);
    await mount(<Opened view="side" />);
    await until(() => document.querySelector('.ib-phead') !== null && fileDrawn(), 'the thread and the file');
    await until(() => shown() === '0', 'no pins known');
    expect(pinReads).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);
  });

  test.skipIf(!hasDom)(`the pins read answers ${name} after pins were shown: they stay`, async () => {
    serve(answer);
    resetArtifactPinsForTest([SHOWN]);
    await mount(<Opened view="side" />);
    await until(() => document.querySelector('.ib-phead') !== null && fileDrawn(), 'the thread and the file');
    // Another window's change asks again (`event: artifact-pins`): the read fails, the pin shown stays.
    await act(async () => readArtifactPins());
    expect(pinReads).toBeGreaterThan(0);
    expect(shown()).toBe('1');
    expect(unhandled).toEqual([]);
  });
}
