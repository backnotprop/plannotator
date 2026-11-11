import { afterEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import type { FullScreenComposerValue } from './components/FullScreenComposer';
import { attachmentSequence } from './stepping';
import { clearFileDrafts } from './fileCommentDrafts';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { resetComposerState } = (hasDom ? await import('./fullScreenComposer') : {}) as typeof import('./fullScreenComposer');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const noop = (): void => {};

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom) {
    document.body.replaceChildren();
    resetComposerState();
  }
  clearFileDrafts();
});

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';
const THREAD = 'thr_01K7TTTTTTTTTTTTTTTTTTTTTT';
const PAGE = '<html><body><h1>Checkout</h1><p>Pay now</p></body></html>';

const page: InboxAttachmentState = {
  id: 'att_01K7BBBBBBBBBBBBBBBBBBBBBB',
  name: 'checkout.html',
  path: '/work/shop/checkout.html',
  kind: 'html',
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  size: 1000,
  sent_at: '2026-10-10T10:42:00.000Z',
  sent_mtime: '2026-10-10T10:42:00.000Z',
  message_id: M1,
  changed_since_sent: false,
  unavailable: null,
  current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
};
const message = { id: M1, created_at: '2026-10-10T10:42:00.000Z', author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' } } as unknown as InboxMessageWire;
const STEPS = attachmentSequence([message], [page]);

function serve(): { saved: { attachment_id: string; annotation: Record<string, unknown> }[] } {
  const server = { saved: [] as { attachment_id: string; annotation: Record<string, unknown> }[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (/\/api\/inbox\/attachments\/att_[0-9A-Z]+\/view/.test(url)) {
      return new Response(JSON.stringify({ serverSession: 's', attachment: page, version: 'current', text: PAGE, html: PAGE }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/inbox/annotations')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      server.saved.push(body);
      const record: Partial<InboxAnnotationRecord> = { id: body.annotation.id, attachment_id: page.id, path: page.path, version: 'current', annotation: body.annotation, message_id: M1 };
      return new Response(JSON.stringify({ annotation: record }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return server;
}

function composerFor(words: string, onChange: (text: string) => void): FullScreenComposerValue {
  return {
    threadId: THREAD,
    phone: false,
    reply: {
      to: 'Claude',
      value: words,
      onChange,
      onLateVoice: noop,
      onSend: noop,
      sending: false,
      canSend: words.trim() !== '',
      picks: 0,
      annotations: 0,
      comments: { records: [], attachments: [page], projectRoot: '/work/shop', onOpen: noop, list: null, onList: noop } as unknown as FullScreenComposerValue['reply']['comments'],
      actions: 0,
      files: [],
      onFiles: noop,
      onDropFiles: noop,
      onPaste: noop,
      onRemoveFile: noop,
      onPutBack: noop,
      openQuestions: 0,
      openActions: 0,
      conflict: false,
      error: null,
      sentAt: null,
      onOpenThread: noop,
    },
  };
}

let setFull: (on: boolean) => void = noop;
let replyWords = '';

function Pane({ onSaved }: { onSaved: (record: InboxAnnotationRecord) => void }) {
  const [full, setFullState] = useState(true);
  const [words, setWords] = useState('');
  setFull = setFullState;
  replyWords = words;
  return (
    <AttachmentPane
      attachment={page}
      attachments={[page]}
      records={[]}
      agent="Claude"
      projectName="shop"
      projectRoot="/work/shop"
      version="current"
      onVersion={noop}
      full={full}
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={onSaved}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={noop}
      strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      steps={STEPS}
      onStep={noop}
      composer={composerFor(words, setWords)}
    />
  );
}

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function settle(ms = 25) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => void, tries = 60): Promise<void> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      check();
      return;
    } catch (error) {
      last = error;
      await settle();
    }
  }
  throw last;
}

async function type(area: HTMLTextAreaElement, words: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, words);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const card = () => document.querySelector<HTMLElement>('[data-fcomp]');
const radio = (mode: 'comment' | 'reply') => card()!.querySelector<HTMLButtonElement>(`[role="radio"][data-fcomp-mode="${mode}"]`);
const pageField = () => card()!.querySelector<HTMLTextAreaElement>('[data-html-page-comment] textarea');
const replyField = () => card()!.querySelector<HTMLTextAreaElement>('[data-fcomp-field] textarea');

test.skipIf(!hasDom)('an HTML page in full screen: the card offers Comment and Reply, Comment first; a comment is saved on the attachment, on the whole page', async () => {
  const server = serve();
  const saved: InboxAnnotationRecord[] = [];
  await render(<Pane onSaved={(record) => saved.push(record)} />);
  await waitFor(() => expect(card()).not.toBeNull());

  expect(radio('comment')).not.toBeNull();
  expect(radio('reply')).not.toBeNull();
  expect(radio('comment')!.getAttribute('aria-checked')).toBe('true');
  expect(radio('reply')!.getAttribute('aria-checked')).toBe('false');
  expect(radio('comment')!.textContent).toBe('Comment on this page');
  expect(card()!.querySelector('.ib-fcomp-solo')).toBeNull();
  expect(pageField()).not.toBeNull();
  expect(replyField()).toBeNull();

  const save = card()!.querySelector<HTMLButtonElement>('[data-html-page-comment-save]')!;
  expect(save.disabled).toBe(true);
  await type(pageField()!, 'The total should sit above the fold.');
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  await waitFor(() => expect(server.saved).toHaveLength(1));
  expect(server.saved[0]!.attachment_id).toBe(page.id);
  expect(server.saved[0]!.annotation).toMatchObject({ type: 'GLOBAL_COMMENT', text: 'The total should sit above the fold.', originalText: '' });
  await waitFor(() => expect(saved).toHaveLength(1));
  await waitFor(() => expect(pageField()!.value).toBe(''));

  await act(async () => radio('reply')!.click());
  expect(radio('reply')!.getAttribute('aria-checked')).toBe('true');
  expect(replyField()).not.toBeNull();
  await type(replyField()!, 'Ship it once the total moves.');
  expect(replyWords).toBe('Ship it once the total moves.');
  expect(server.saved).toHaveLength(1);
});

test.skipIf(!hasDom)('words typed in the page\'s Comment tab wait while the file is beside the thread, and are back in full screen', async () => {
  serve();
  await render(<Pane onSaved={noop} />);
  await waitFor(() => expect(pageField()).not.toBeNull());
  await type(pageField()!, 'Half a thought');
  await act(async () => setFull(false));
  await waitFor(() => expect(card()).toBeNull());
  await act(async () => setFull(true));
  await waitFor(() => expect(pageField()).not.toBeNull());
  expect(pageField()!.value).toBe('Half a thought');
});
