/**
 * Closing a file with a comment being written, or going to another file,
 * never asks (approval "inbox-file-close-keeps-comment-draft", 2026-11-07):
 * it happens on the first press, and the words, with what they were on, are
 * back in the comment box when that same file opens again. Proved through
 * the real viewers: a markdown selection's comment popover, an HTML pin's, a
 * diagram node's composer, an annotation being edited in the panel; and that
 * discarding on the comment itself, or typing nothing, leaves no draft. The
 * pane taken away without `leave` (another thread picked) keeps a markdown or
 * HTML comment being written too, and a kept comment's box opens only once
 * the pane stops moving, where a fresh one on the same words opens.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * The diagram fixture and its geometry are DiagramBlock.askAI.test.tsx's.
 * The image row and close are in attachmentStepping.test.tsx.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentSequence, type AttachmentStep } from './stepping';
import { clearFileDrafts, fileDraftKey, peekFileDrafts } from './fileCommentDrafts';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { CommentPictures } = (hasDom ? await import('./commentPictures') : {}) as typeof import('./commentPictures');
const diagramSvg = hasDom ? await import('@plannotator/ui/test-setup/diagramSvg') : null;
const mermaid = hasDom ? await import('@plannotator/ui/utils/mermaid') : null;
const bridge = hasDom ? await import('@plannotator/ui/components/html-viewer/bridge-script') : null;

const FIXTURES = join(import.meta.dir, '..', 'ui', 'test-setup', 'fixtures', 'diagrams');
const CAPTURE_ID = 'diagram-fixture';
const SVG = readFileSync(join(FIXTURES, '06-flowchart-review-decision.svg'), 'utf8');
const GEOMETRY = JSON.parse(readFileSync(join(FIXTURES, '06-flowchart-review-decision.geometry.json'), 'utf8')) as {
  elements: Record<string, { bbox: { x: number; y: number; width: number; height: number }; ctm: DOMMatrix }>;
};
const CAPTURED = Object.entries(GEOMETRY.elements).map(([id, entry]) => [id.slice(CAPTURE_ID.length), entry] as const);
const FLOW = ['flowchart LR', '  U([Reviewer]) --> D{Approve?}', '  D -->|Yes| M[(Merge)]', '  D -->|No| R[Revise]', ''].join('\n');
const MARKDOWN = ['# Scope', '', 'Payment retries stop after five attempts.', '', 'Partial refunds stay out of v1.', ''].join('\n');
const PAGE = '<html><body><p>Pinpoint target</p></body></html>';

const svgProto = (hasDom ? ((globalThis as { SVGGraphicsElement?: typeof SVGElement }).SVGGraphicsElement ?? SVGElement).prototype : {}) as unknown as Record<string, unknown>;
const elementProto = (hasDom ? Element.prototype : {}) as unknown as Record<string, unknown>;
const savedProto = { getBBox: svgProto['getBBox'], getScreenCTM: svgProto['getScreenCTM'] };
let restoreParser: (() => void) | null = null;
const noop = (): void => {};

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = diagramSvg!.installInertDiagramSvgParser();
  mermaid!.setMermaidRuntime(
    { initialize: noop, render: (id: string) => Promise.resolve({ svg: SVG.replaceAll(CAPTURE_ID, id) }) } as unknown as Parameters<typeof import('@plannotator/ui/utils/mermaid').setMermaidRuntime>[0],
    'host',
  );
  elementProto['setPointerCapture'] ??= noop;
  elementProto['releasePointerCapture'] ??= noop;
  elementProto['hasPointerCapture'] ??= () => false;
  svgProto['getBBox'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { x: 0, y: 0, width: 452, height: 182 };
    const found = CAPTURED.find(([suffix]) => this.id.endsWith(suffix));
    return found ? { ...found[1].bbox } : { x: 0, y: 0, width: 0, height: 0 };
  };
  svgProto['getScreenCTM'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return CAPTURED.find(([suffix]) => this.id.endsWith(suffix))?.[1].ctm ?? null;
  };
});

afterAll(() => {
  if (!hasDom) return;
  svgProto['getBBox'] = savedProto.getBBox;
  svgProto['getScreenCTM'] = savedProto.getScreenCTM;
  mermaid!.__setMermaidRuntimeLoaderForTests(undefined);
  restoreParser?.();
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
  clearFileDrafts();
  onSaveRequest = noop;
  for (const id of Object.keys(servedVersion)) delete servedVersion[id];
});

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string, kind: string): InboxAttachmentState {
  return {
    id,
    name,
    path: `/work/shop/${name}`,
    kind: kind as InboxAttachmentState['kind'],
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
}

const scope = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'SCOPE.md', 'markdown');
const page = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'checkout.html', 'html');
const flow = file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'retry.mmd', 'mermaid');
const policy = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'refund-policy.pdf', 'pdf');
const shot = { ...file('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'checkout.png', 'image'), media_type: 'image/png' } as InboxAttachmentState;
const message = { id: M1, created_at: '2026-10-10T10:42:00.000Z', author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' } } as unknown as InboxMessageWire;
const STEPS: AttachmentStep[] = attachmentSequence([message], [scope, page, flow, policy]);
/** A file's view at a version other than "current" (the sent one), as the server names it: its sha. */
const servedVersion: Record<string, string> = {};
const TEXT: Record<string, { text: string; html: string | null }> = {
  [scope.id]: { text: MARKDOWN, html: null },
  [page.id]: { text: PAGE, html: PAGE },
  [flow.id]: { text: FLOW, html: null },
};

/** Called as an annotation save reaches the server, before it answers (a host that closes the file on a save). */
let onSaveRequest: () => void = noop;

interface Server {
  /** The bodies of every annotation save. */
  saved: { attachment_id: string; annotation: { id: string; text?: string; htmlAnchor?: unknown; diagramAnchor?: unknown } }[];
}

function serve(): Server {
  const server: Server = { saved: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const view = /\/api\/inbox\/attachments\/(att_[0-9A-Z]+)\/view/.exec(url);
    if (view) {
      const attachment = [scope, page, flow, policy].find((a) => a.id === view[1])!;
      const body = TEXT[attachment.id]!;
      const version = servedVersion[attachment.id] ?? 'current';
      return new Response(JSON.stringify({ serverSession: 's', attachment, version, text: body.text, html: body.html }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/inbox/annotations')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      server.saved.push(body);
      onSaveRequest();
      const owner = [scope, page, flow, policy, shot].find((a) => a.id === body.attachment_id)!;
      const record: Partial<InboxAnnotationRecord> = { id: body.annotation.id, attachment_id: owner.id, path: owner.path, version: 'current', annotation: body.annotation, message_id: M1 };
      return new Response(JSON.stringify({ annotation: record }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return server;
}

/** The thread's side of a close: the pane goes (as Thread unmounts it), and comes back on the same file with `reopen`. */
let showPane: (shown: boolean) => void = noop;
function Shown({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState(true);
  showPane = setShown;
  return shown ? <>{children}</> : null;
}

function Pane({
  start,
  steps,
  records = [],
  onClose = noop,
  list = STEPS,
}: {
  start: InboxAttachmentState;
  steps: { id: string }[];
  records?: InboxAnnotationRecord[];
  onClose?: () => void;
  list?: AttachmentStep[];
}) {
  const [open, setOpen] = useState(start);
  const all = list.map((s) => s.attachment);
  return (
    <AttachmentPane
      attachment={open}
      attachments={all}
      records={records}
      agent="Claude"
      projectName="shop"
      projectRoot="/work/shop"
      version="current"
      onVersion={noop}
      // Beside the thread, where the stepper under the file steps (full screen steps from its toolbar and keys).
      full={false}
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={onClose}
      strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      steps={list}
      onStep={(id) => {
        steps.push({ id });
        setOpen(all.find((a) => a.id === id)!);
      }}
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

const pane = () => host!.querySelector<HTMLElement>('[data-attachment-pane]')!;
const guard = () => host!.querySelector<HTMLElement>('[data-step-guard]');
const popoverBox = () => document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
const openId = () => pane().getAttribute('data-attachment-pane');

async function pressNext() {
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-step-next]')!.click());
}

async function pressPrev() {
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-step-prev]')!.click());
}

/** Select `phrase` in the open markdown file and open its comment popover from the toolbar. */
async function commentOnPhrase(phrase: string) {
  await waitFor(() => expect(pane().querySelector('.ib-docscroll')?.textContent).toContain(phrase));
  const walker = document.createTreeWalker(pane().querySelector('.ib-docscroll')!, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  const at = node!.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node!, at);
  range.setEnd(node!, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const article = node!.parentElement!.closest('article') ?? pane();
  await act(async () => {
    article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
  // Named by a native title, or by its aria-label where ui draws component tooltips (the Inbox window).
  const comment = [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')].find((b) => (b.getAttribute('aria-label') ?? b.title) === 'Comment');
  if (comment) await act(async () => comment.click());
  await waitFor(() => expect(popoverBox()).not.toBeNull());
}

/** Pin the HTML page's paragraph the way the bridge reports a pinpoint click. */
async function pinParagraph() {
  await waitFor(() => expect(pane().querySelector('iframe')).not.toBeNull());
  const iframe = pane().querySelector('iframe')!;
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-selection',
          text: 'Pinpoint target',
          rect: { top: 10, left: 10, width: 120, height: 24 },
          anchor: { selector: 'p:nth-of-type(1)', tagName: 'p', text: 'Pinpoint target' },
          pinpoint: true,
        },
      }),
    );
  });
  await waitFor(() => expect(popoverBox()).not.toBeNull());
}

/** Click the diagram's node D, which opens its composer. */
async function clickNodeD() {
  await waitFor(() => expect(pane().querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
  const node = pane().querySelector('[id$="-flowchart-D-1"]')!;
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  const fire = (kind: string) =>
    node.dispatchEvent(new Ctor(kind, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, ...(Ctor !== MouseEvent ? { pointerId: 1 } : {}) } as MouseEventInit));
  await act(async () => {
    fire('pointerdown');
    fire('pointerup');
  });
  await waitFor(() => expect(pane().querySelector('[data-diagram-composer] textarea')).not.toBeNull());
}

// What would regress: a step that stops for a question (or saves the words as a comment), or a file that opens again
// without the words, or with them on other text.
test.skipIf(!hasDom)('markdown: a selection\'s comment never stops the step; back on the file, the popover is open on the same words holding them', async () => {
  const server = serve();
  const steps: { id: string }[] = [];
  await render(<Pane start={scope} steps={steps} />);
  await commentOnPhrase('Partial refunds stay out of v1.');
  await type(popoverBox()!, 'Partial refunds are in for v1.');
  await pressNext();
  expect(guard() === null).toBe(true);
  expect(steps.map((s) => s.id)).toEqual([page.id]);
  expect(server.saved).toEqual([]);
  await settle();
  expect(popoverBox() === null).toBe(true);
  await pressPrev();
  await waitFor(() => expect(popoverBox()?.value).toBe('Partial refunds are in for v1.'));
  // On what it was on: the popover quotes it, and the words it covers are marked pending in the document.
  expect(document.querySelector('[data-comment-popover]')!.textContent).toContain('Partial refunds stay out of v1.');
  expect(server.saved).toEqual([]);
});

test.skipIf(!hasDom)('close with typed words closes on the first press, and the words are back when the file opens again', async () => {
  serve();
  const steps: { id: string }[] = [];
  let closed = 0;
  await render(
    <Shown>
      <Pane
        start={scope}
        steps={steps}
        onClose={() => {
          closed++;
          showPane(false);
        }}
      />
    </Shown>,
  );
  await commentOnPhrase('Payment retries stop after five attempts.');
  await type(popoverBox()!, 'Make it per merchant.');
  await act(async () => host!.querySelector<HTMLButtonElement>('[aria-label="Close SCOPE.md"]')!.click());
  expect(closed).toBe(1);
  expect(guard() === null).toBe(true);
  expect(host!.querySelector('[data-attachment-pane]') === null).toBe(true);
  await settle();
  expect(popoverBox() === null).toBe(true);
  // The file opens again: its popover is open on the same words, holding them.
  await act(async () => showPane(true));
  await waitFor(() => expect(popoverBox()?.value).toBe('Make it per merchant.'));
  expect(document.querySelector('[data-comment-popover]')!.textContent).toContain('Payment retries stop after five attempts.');
});

test.skipIf(!hasDom)('the browser\'s Back closing the file through the route keeps the words too', async () => {
  serve();
  const steps: { id: string }[] = [];
  await render(
    <Shown>
      <Pane start={scope} steps={steps} />
    </Shown>,
  );
  await commentOnPhrase('Payment retries stop after five attempts.');
  await type(popoverBox()!, 'Per merchant, please.');
  // Back: the route's listener closes the file (the thread no longer draws the pane).
  const onRoute = () => showPane(false);
  window.addEventListener('popstate', onRoute);
  await act(async () => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  window.removeEventListener('popstate', onRoute);
  await settle();
  expect(popoverBox() === null).toBe(true);
  await act(async () => showPane(true));
  await waitFor(() => expect(popoverBox()?.value).toBe('Per merchant, please.'));
});

test.skipIf(!hasDom)('discarding on the comment itself, or typing nothing, leaves nothing to come back', async () => {
  const server = serve();
  const steps: { id: string }[] = [];
  await render(<Pane start={scope} steps={steps} />);
  // Words typed, then cleared in the comment: no draft.
  // Words no other test here comments on (ui's popover keeps its own words per selection for the file's run).
  await commentOnPhrase('stay out of');
  await type(popoverBox()!, 'Not this.');
  await type(popoverBox()!, '');
  await pressNext();
  await pressPrev();
  await waitFor(() => expect(pane().querySelector('.ib-docscroll')?.textContent).toContain('Partial refunds'));
  await settle(100);
  expect(popoverBox() === null).toBe(true);
  // A composer opened and left empty: no draft either.
  await commentOnPhrase('stop after five');
  await pressNext();
  await pressPrev();
  await waitFor(() => expect(pane().querySelector('.ib-docscroll')?.textContent).toContain('Payment retries'));
  await settle(100);
  expect(popoverBox() === null).toBe(true);
  expect(server.saved).toEqual([]);
});

test.skipIf(!hasDom)('HTML pin: the pinned comment waits for the page, and the page is asked to pin the same element again with the words', async () => {
  const server = serve();
  const steps: { id: string }[] = [];
  await render(<Pane start={page} steps={steps} />);
  await pinParagraph();
  await type(popoverBox()!, 'Say the amount on the button.');
  await pressNext();
  expect(guard() === null).toBe(true);
  expect(openId()).toBe(flow.id);
  await pressPrev();
  // The bridge is asked to pin the anchor again; its answer opens the composer holding the words.
  await waitFor(() => expect(pane().querySelector('iframe')).not.toBeNull());
  const iframe = pane().querySelector('iframe')!;
  const posted: Record<string, unknown>[] = [];
  (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage = (data: unknown) => {
    if (data && typeof data === 'object') posted.push(data as Record<string, unknown>);
  };
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'plannotator-bridge-ready', protocolVersion: bridge!.BRIDGE_PROTOCOL_VERSION } }));
  });
  const restore = () => posted.find((m) => m.type === 'plannotator-bridge-restore-draft');
  await waitFor(() => expect(restore()).toBeTruthy());
  expect(restore()).toMatchObject({ anchor: { selector: 'p:nth-of-type(1)' } });
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-selection',
          text: 'Pinpoint target',
          rect: { top: 10, left: 10, width: 120, height: 24 },
          anchor: { selector: 'p:nth-of-type(1)', tagName: 'p', text: 'Pinpoint target' },
          pinpoint: true,
          restoreId: restore()!.id,
        },
      }),
    );
  });
  await waitFor(() => expect(popoverBox()?.value).toBe('Say the amount on the button.'));
  expect(server.saved).toEqual([]);
});

test.skipIf(!hasDom)('diagram node: the node\'s comment waits, and is back in the node\'s composer when the file opens again', async () => {
  const server = serve();
  const steps: { id: string }[] = [];
  await render(<Pane start={flow} steps={steps} />);
  await clickNodeD();
  await type(pane().querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea')!, 'Who approves on a holiday?');
  await pressNext();
  expect(guard() === null).toBe(true);
  expect(openId()).toBe(policy.id);
  await pressPrev();
  await waitFor(() => expect(pane().querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea')?.value).toBe('Who approves on a holiday?'));
  expect(server.saved).toEqual([]);
});

test.skipIf(!hasDom)('an annotation edited in the panel and not saved: the step goes, and its card is back in its edit box with the changed words', async () => {
  const server = serve();
  const steps: { id: string }[] = [];
  const record = {
    id: 'ann-1',
    attachment_id: scope.id,
    path: scope.path,
    version: 'current',
    message_id: M1,
    annotation: { id: 'ann-1', blockId: 'block-2', startOffset: 0, endOffset: 8, type: 'COMMENT', text: 'Five is fine.', originalText: 'Payment', createdA: 1 },
  } as unknown as InboxAnnotationRecord;
  await render(<Pane start={scope} steps={steps} records={[record]} />);
  await waitFor(() => expect(pane().querySelector('[data-annotation-id="ann-1"]')).not.toBeNull());
  const editButton = () => pane().querySelector<HTMLButtonElement>('[data-annotation-id="ann-1"] button:is([title="Edit annotation"], [aria-label="Edit annotation"])')!;
  const editBox = () => pane().querySelector<HTMLTextAreaElement>('[data-annotation-id="ann-1"] textarea');
  // Opened and not changed: nothing to keep.
  await act(async () => editButton().click());
  expect(editBox()!.value).toBe('Five is fine.');
  await pressNext();
  await pressPrev();
  await waitFor(() => expect(pane().querySelector('[data-annotation-id="ann-1"]')).not.toBeNull());
  await settle(60);
  expect(editBox() === null).toBe(true);
  // Changed: the words wait, and the card opens its edit box with them.
  await act(async () => editButton().click());
  await type(editBox()!, 'Make it eight for big accounts.');
  await pressNext();
  expect(guard() === null).toBe(true);
  expect(steps.map((s) => s.id)).toEqual([page.id, scope.id, page.id]);
  await pressPrev();
  await waitFor(() => expect(editBox()?.value).toBe('Make it eight for big accounts.'));
  expect(server.saved).toEqual([]);
});

test.skipIf(!hasDom)('a page posting the bridge step every 50 ms without focus never moves the pane', async () => {
  serve();
  const steps: { id: string }[] = [];
  await render(<Pane start={page} steps={steps} />);
  await waitFor(() => expect(pane().querySelector('iframe')).not.toBeNull());
  const iframe = pane().querySelector('iframe')!;
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'plannotator-bridge-step', dir: 1 } }));
    });
    await settle(50);
  }
  expect(steps).toEqual([]);
});

// What would regress: the pane taken away without `leave` (another thread picked while the file is open: Thread
// unmounts it) dropping the words of a comment being written, because its composer answers no key while it goes.
test.skipIf(!hasDom)('markdown: another thread picked while a comment is being written keeps it; the file opened again has the words on the same words', async () => {
  const server = serve();
  await render(
    <Shown>
      <Pane start={scope} steps={[]} />
    </Shown>,
  );
  await commentOnPhrase('five attempts');
  await type(popoverBox()!, 'Seven, with a longer wait.');
  // Another thread: the pane goes with no close, no step and no Back.
  await act(async () => showPane(false));
  expect(popoverBox() === null).toBe(true);
  await settle();
  // Back on the thread, the same file opens.
  await act(async () => showPane(true));
  await waitFor(() => expect(popoverBox()?.value).toBe('Seven, with a longer wait.'));
  expect(document.querySelector('[data-comment-popover]')!.textContent).toContain('five attempts');
  expect(server.saved).toEqual([]);
});

test.skipIf(!hasDom)('HTML pin: another thread picked while its comment is being written keeps it; the page is asked to pin the same element again', async () => {
  const server = serve();
  await render(
    <Shown>
      <Pane start={page} steps={[]} />
    </Shown>,
  );
  await pinParagraph();
  await type(popoverBox()!, 'Bigger, and in the brand colour.');
  await act(async () => showPane(false));
  await settle();
  await act(async () => showPane(true));
  await waitFor(() => expect(pane().querySelector('iframe')).not.toBeNull());
  const iframe = pane().querySelector('iframe')!;
  const posted: Record<string, unknown>[] = [];
  (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage = (data: unknown) => {
    if (data && typeof data === 'object') posted.push(data as Record<string, unknown>);
  };
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'plannotator-bridge-ready', protocolVersion: bridge!.BRIDGE_PROTOCOL_VERSION } }));
  });
  const restore = () => posted.find((m) => m.type === 'plannotator-bridge-restore-draft');
  await waitFor(() => expect(restore()).toBeTruthy());
  expect(restore()).toMatchObject({ anchor: { selector: 'p:nth-of-type(1)' } });
  expect(server.saved).toEqual([]);
});

test.skipIf(!hasDom)('a comment discarded before another thread is picked is not kept', async () => {
  serve();
  await render(
    <Shown>
      <Pane start={scope} steps={[]} />
    </Shown>,
  );
  await commentOnPhrase('Payment retries');
  await type(popoverBox()!, 'Not this one.');
  // Discarded on the comment itself: its own Escape.
  await act(async () => {
    popoverBox()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  });
  await waitFor(() => expect(popoverBox() === null).toBe(true));
  await act(async () => showPane(false));
  await act(async () => showPane(true));
  await waitFor(() => expect(pane().querySelector('.ib-docscroll')?.textContent).toContain('Payment retries'));
  await settle(150);
  expect(popoverBox() === null).toBe(true);
});

// What would regress: a kept comment's box opening while the pane still slides in (the list and sidebar folding
// away), placed for where its words were mid-slide, away from them, instead of where a click on them opens it.
test.skipIf(!hasDom)('a kept comment opens its box where a fresh one on the same words opens, after the pane stops moving', async () => {
  serve();
  const proto = HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const real = proto.getBoundingClientRect;
  // Every element sits 100 px down a 20 px tall line, `shift` px right of where it lands.
  let shift = 0;
  proto.getBoundingClientRect = function () {
    const left = 300 + shift;
    return { x: left, y: 100, left, top: 100, right: left + 200, bottom: 120, width: 200, height: 20, toJSON() {} } as DOMRect;
  };
  try {
    await render(
      <Shown>
        <Pane start={scope} steps={[]} />
      </Shown>,
    );
    await commentOnPhrase('Partial refunds');
    const where = () => {
      const box = document.querySelector<HTMLElement>('[data-comment-popover]')!;
      return { left: parseFloat(box.style.left), top: parseFloat(box.style.top) };
    };
    const fresh = where();
    expect(Number.isFinite(fresh.left)).toBe(true);
    await type(popoverBox()!, 'Say which ones.');
    await act(async () => showPane(false));
    // The file opens again sliding in from 240 px right: 30 px nearer each frame.
    shift = 240;
    let sliding = true;
    const slide = () => {
      shift = Math.max(0, shift - 30);
      if (sliding && shift > 0) requestAnimationFrame(slide);
    };
    requestAnimationFrame(slide);
    try {
      await act(async () => showPane(true));
      await waitFor(() => expect(popoverBox()?.value).toBe('Say which ones.'));
    } finally {
      sliding = false;
    }
    const back = where();
    expect(Math.abs(back.left - fresh.left)).toBeLessThan(3);
    expect(Math.abs(back.top - fresh.top)).toBeLessThan(3);
  } finally {
    proto.getBoundingClientRect = real;
  }
});

// What would regress (F1): the first render after a step still holds the last file's view, so a draft key taken from it
// (that file's sha) makes the image's row start empty, and the row's real draft is then thrown away as "taken".
test.skipIf(!hasDom)('an image\'s typed comment waits for it across a file shown at its sent version', async () => {
  serve();
  servedVersion[scope.id] = 'b'.repeat(64);
  const list = attachmentSequence([message], [shot, scope]);
  const steps: { id: string }[] = [];
  await render(<Pane start={shot} steps={steps} list={list} />);
  const row = () => pane().querySelector<HTMLTextAreaElement>('[data-image-composer] textarea');
  await waitFor(() => expect(row()).not.toBeNull());
  await type(row()!, 'Too much padding.');
  await pressNext();
  expect(openId()).toBe(scope.id);
  // The markdown file's view (at its sha) is in before the step back.
  await waitFor(() => expect(pane().querySelector('.ib-docscroll')?.textContent).toContain('Payment retries'));
  await pressPrev();
  await waitFor(() => expect(row()?.value).toBe('Too much padding.'));
  await settle(60);
  expect(row()!.value).toBe('Too much padding.');
});

// What would regress (F3): an edit put back is held only in the card's request until its box draws; the pane going
// before then drops the words. StrictMode's unmount and mount right after the first commit is exactly that moment.
test.skipIf(!hasDom)('an edit put back and not drawn yet survives the pane going (StrictMode\'s remount); the box has the words', async () => {
  serve();
  const record = {
    id: 'ann-2',
    attachment_id: scope.id,
    path: scope.path,
    version: 'current',
    message_id: M1,
    annotation: { id: 'ann-2', blockId: 'block-2', startOffset: 0, endOffset: 8, type: 'COMMENT', text: 'Fine as is.', originalText: 'Partial', createdA: 1 },
  } as unknown as InboxAnnotationRecord;
  await render(
    <StrictMode>
      <Shown>
        <Pane start={scope} steps={[]} records={[record]} />
      </Shown>
    </StrictMode>,
  );
  const editButton = () => pane().querySelector<HTMLButtonElement>('[data-annotation-id="ann-2"] button:is([title="Edit annotation"], [aria-label="Edit annotation"])')!;
  const editBox = () => pane().querySelector<HTMLTextAreaElement>('[data-annotation-id="ann-2"] textarea');
  await waitFor(() => expect(pane().querySelector('[data-annotation-id="ann-2"]')).not.toBeNull());
  await act(async () => editButton().click());
  await type(editBox()!, 'Not in v1 either.');
  await act(async () => showPane(false));
  // Opened again: StrictMode takes the pane away and back right after it puts the edit back, before its box draws.
  await act(async () => showPane(true));
  await waitFor(() => expect(editBox()?.value).toBe('Not in v1 either.'));
});

// What would regress (F9): Escape typed in a changed edit box, or a diagram part's box, throwing the words away.
test.skipIf(!hasDom)('Escape in a changed edit box keeps the words as the file\'s draft; they are back when it opens again', async () => {
  serve();
  const record = {
    id: 'ann-3',
    attachment_id: scope.id,
    path: scope.path,
    version: 'current',
    message_id: M1,
    annotation: { id: 'ann-3', blockId: 'block-2', startOffset: 0, endOffset: 8, type: 'COMMENT', text: 'Leave it.', originalText: 'Payment', createdA: 1 },
  } as unknown as InboxAnnotationRecord;
  const server = serve();
  await render(
    <Shown>
      <Pane start={scope} steps={[]} records={[record]} />
    </Shown>,
  );
  const editButton = () => pane().querySelector<HTMLButtonElement>('[data-annotation-id="ann-3"] button:is([title="Edit annotation"], [aria-label="Edit annotation"])')!;
  const editBox = () => pane().querySelector<HTMLTextAreaElement>('[data-annotation-id="ann-3"] textarea');
  await waitFor(() => expect(pane().querySelector('[data-annotation-id="ann-3"]')).not.toBeNull());
  await act(async () => editButton().click());
  await type(editBox()!, 'Cap it at ten.');
  await act(async () => {
    editBox()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  });
  await waitFor(() => expect(editBox() === null).toBe(true));
  expect(server.saved).toEqual([]);
  await act(async () => showPane(false));
  await act(async () => showPane(true));
  await waitFor(() => expect(editBox()?.value).toBe('Cap it at ten.'));
});

test.skipIf(!hasDom)('Escape in a diagram part\'s box keeps the words; another thread picked while one is written keeps them too', async () => {
  serve();
  await render(
    <Shown>
      <Pane start={flow} steps={[]} />
    </Shown>,
  );
  const partBox = () => pane().querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea');
  await clickNodeD();
  await type(partBox()!, 'Who approves on weekends?');
  await act(async () => {
    partBox()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  });
  await waitFor(() => expect(partBox() === null).toBe(true));
  await act(async () => showPane(false));
  await act(async () => showPane(true));
  await waitFor(() => expect(partBox()?.value).toBe('Who approves on weekends?'));
  // Typed on, then another thread: the pane goes with no close.
  await type(partBox()!, 'Who approves on weekends and holidays?');
  await act(async () => showPane(false));
  await act(async () => showPane(true));
  await waitFor(() => expect(partBox()?.value).toBe('Who approves on weekends and holidays?'));
});

// What would regress (F8): a comment popover of another surface, open with words, "saved" by the pane's capture
// (its own owner would really save it) or kept as this file's comment.
test.skipIf(!hasDom)('a comment popover that is not the pane\'s is neither submitted nor kept when the file closes', async () => {
  serve();
  const { CommentPopover } = await import('@plannotator/ui/components/CommentPopover');
  const elsewhere: string[] = [];
  const anchor = document.createElement('span');
  document.body.appendChild(anchor);
  let closed = 0;
  await render(
    <>
      <Shown>
        <Pane
          start={scope}
          steps={[]}
          onClose={() => {
            closed++;
            showPane(false);
          }}
        />
      </Shown>
      <CommentPopover anchorEl={anchor} contextText="elsewhere" isGlobal={false} autoFocus={false} onSubmit={(text) => elsewhere.push(text)} onClose={noop} />
    </>,
  );
  const foreign = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
  await type(foreign, 'Not the file\'s words.');
  await waitFor(() => expect(pane().querySelector('.ib-docscroll')?.textContent).toContain('Payment'));
  await act(async () => host!.querySelector<HTMLButtonElement>('[aria-label="Close SCOPE.md"]')!.click());
  expect(closed).toBe(1);
  expect(elsewhere).toEqual([]);
  await act(async () => showPane(true));
  await waitFor(() => expect(pane().querySelector('.ib-docscroll')?.textContent).toContain('Payment'));
  await settle(150);
  expect([...document.querySelectorAll('[data-comment-popover] textarea')].length).toBe(1);
});

// What would regress (F4): a kept line comment reopened on whatever those lines hold now.
// DOM-gated: AttachmentPane loads the highlighter, which needs a window.
test.skipIf(!hasDom)('a kept line comment goes back where its lines are now, and nowhere when they changed', async () => {
  const { relocateCodeRange } = await import('./components/AttachmentPane');
  const { codeCommentAnnotation, codeRangeOf } = await import('./attachments');
  const range = codeRangeOf(codeCommentAnnotation({ id: 'k', lineStart: 2, lineEnd: 3, text: 'x', code: 'const b = 2;\nconst c = 3;' }))!;
  expect(relocateCodeRange(range, 'const a = 1;\nconst b = 2;\nconst c = 3;')).toEqual({ lineStart: 2, lineEnd: 3 });
  // Two lines added above: the comment follows its lines.
  expect(relocateCodeRange(range, '// one\n// two\nconst a = 1;\nconst b = 2;\nconst c = 3;')).toEqual({ lineStart: 4, lineEnd: 5 });
  // The lines changed: no place (the words wait, on nothing).
  expect(relocateCodeRange(range, 'const a = 1;\nconst b = 20;\nconst c = 3;')).toBeNull();
  // A file cut from 300 lines to 100, the lines moved from 250 up to 80: still found.
  const before = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
  before[249] = 'const kept = true;';
  before[250] = 'return kept;';
  const far = codeRangeOf(codeCommentAnnotation({ id: 'f', lineStart: 250, lineEnd: 251, text: 'x', code: 'const kept = true;\nreturn kept;' }))!;
  const after = Array.from({ length: 100 }, (_, i) => `other ${i + 1}`);
  after[79] = 'const kept = true;';
  after[80] = 'return kept;';
  expect(relocateCodeRange(far, after.join('\n'))).toEqual({ lineStart: 80, lineEnd: 81 });
});

// What would regress (N1): a page that never answers the request to pin a kept comment again, its 3 s wait running
// out after the person stepped to another file, and the words landing in that other file's drafts.
test.skipIf(!hasDom)('a kept HTML comment the page never answered stays the page\'s when the person steps on', async () => {
  serve();
  const steps: { id: string }[] = [];
  await render(<Pane start={page} steps={steps} />);
  await pinParagraph();
  await type(popoverBox()!, 'Only on the page.');
  await pressNext();
  expect(openId()).toBe(flow.id);
  await pressPrev();
  expect(openId()).toBe(page.id);
  // The page's bridge is ready and asked to pin it again, and never answers.
  await waitFor(() => expect(pane().querySelector('iframe')).not.toBeNull());
  const iframe = pane().querySelector('iframe')!;
  const posted: Record<string, unknown>[] = [];
  (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage = (data: unknown) => {
    if (data && typeof data === 'object') posted.push(data as Record<string, unknown>);
  };
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'plannotator-bridge-ready', protocolVersion: bridge!.BRIDGE_PROTOCOL_VERSION } }));
  });
  await waitFor(() => expect(posted.some((m) => m.type === 'plannotator-bridge-restore-draft')).toBe(true));
  // On to the diagram before the wait runs out, and past it.
  await pressNext();
  expect(openId()).toBe(flow.id);
  await settle(3300);
  await pressNext();
  expect(openId()).toBe(policy.id);
  expect(peekFileDrafts(fileDraftKey(flow.id, 'current'))).toEqual([]);
  const kept = peekFileDrafts(fileDraftKey(page.id, 'current'));
  expect(kept.map((d) => (d.kind === 'comment' ? d.annotation.text : d.kind))).toEqual(['Only on the page.']);
});

// What would regress (N3): while a put-back comment is awaited, another surface's popover with words taken for the
// pane's own, then "saved" by the pane's capture as the file closes (its owner would really save it).
test.skipIf(!hasDom)('a comment being put back never claims another surface\'s popover', async () => {
  serve();
  const { CommentPopover } = await import('@plannotator/ui/components/CommentPopover');
  const elsewhere: string[] = [];
  const anchor = document.createElement('span');
  document.body.appendChild(anchor);
  let closed = 0;
  await render(
    <>
      <CommentPopover anchorEl={anchor} contextText="elsewhere" isGlobal={false} autoFocus={false} onSubmit={(text) => elsewhere.push(text)} onClose={noop} />
      <Shown>
        <Pane
          start={scope}
          steps={[]}
          onClose={() => {
            closed++;
            showPane(false);
          }}
        />
      </Shown>
    </>,
  );
  const foreign = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
  await type(foreign, 'Words of another surface.');
  await commentOnPhrase('Partial refunds');
  const own = [...document.querySelectorAll<HTMLTextAreaElement>('[data-comment-popover] textarea')].find((a) => a !== foreign)!;
  await type(own, 'Which refunds?');
  await pressNext();
  await pressPrev();
  await waitFor(() => expect([...document.querySelectorAll<HTMLTextAreaElement>('[data-comment-popover] textarea')].some((a) => a !== foreign && a.value === 'Which refunds?')).toBe(true));
  await act(async () => host!.querySelector<HTMLButtonElement>('[aria-label="Close SCOPE.md"]')!.click());
  expect(closed).toBe(1);
  expect(elsewhere).toEqual([]);
  expect(foreign.value).toBe('Words of another surface.');
});

// What would regress: a host that closes the file in the same moment a comment is saved (the tour's file step does)
// kept the saved words as the file's draft too, so the file opened again with them in a box over the saved comment.
test.skipIf(!hasDom)('a comment saved as its file closes is a comment, never also a draft', async () => {
  const server = serve();
  const steps: { id: string }[] = [];
  await render(
    <Shown>
      <Pane start={scope} steps={steps} />
    </Shown>,
  );
  await commentOnPhrase('Partial refunds stay out of v1.');
  await type(popoverBox()!, 'Partial refunds are in for v1.');
  onSaveRequest = () => showPane(false);
  const save = [...document.querySelectorAll<HTMLButtonElement>('[data-comment-popover] button')].find((b) => b.textContent?.trim() === 'Save')!;
  await act(async () => save.click());
  await settle(50);
  expect(server.saved.map((s) => s.annotation.text)).toEqual(['Partial refunds are in for v1.']);
  expect(peekFileDrafts(fileDraftKey(scope.id, 'current'))).toEqual([]);
  onSaveRequest = noop;
  await act(async () => showPane(true));
  await waitFor(() => expect(pane().querySelector('.ib-docscroll')?.textContent).toContain('Partial refunds'));
  await settle(300);
  expect(popoverBox()).toBeNull();
});

// What would regress: the same for an image's own comment row, whose words clear only once the save answers.
test.skipIf(!hasDom)('an image comment saved as its file closes is a comment, never also a draft', async () => {
  const server = serve();
  const steps: { id: string }[] = [];
  const list = attachmentSequence([message], [shot, scope]);
  await render(
    <Shown>
      <Pane start={shot} steps={steps} list={list} />
    </Shown>,
  );
  const row = () => pane().querySelector<HTMLTextAreaElement>('[data-image-composer] textarea');
  await waitFor(() => expect(row()).not.toBeNull());
  await type(row()!, 'Too much padding.');
  onSaveRequest = () => showPane(false);
  const comment = [...pane().querySelectorAll<HTMLButtonElement>('[data-image-composer] button')].find((b) => b.textContent?.trim() === 'Comment')!;
  await act(async () => comment.click());
  await settle(50);
  expect(server.saved.map((s) => s.annotation.text)).toEqual(['Too much padding.']);
  expect(peekFileDrafts(fileDraftKey(shot.id, 'current'))).toEqual([]);
  onSaveRequest = noop;
  await act(async () => showPane(true));
  await waitFor(() => expect(row()).not.toBeNull());
  expect(row()!.value).toBe('');
});

const pictureButton = () => document.querySelector('[data-comment-popover] button[aria-label="Attachments"]');
test.skipIf(!hasDom)('a file\'s comment box offers no picture button where nothing can upload it (the tour)', async () => {
  serve();
  await render(<Pane start={scope} steps={[]} />);
  await commentOnPhrase('Partial refunds stay out of v1.');
  expect(pictureButton()).toBeNull();
});

test.skipIf(!hasDom)('a file\'s comment box in a thread offers the attachments button for pictures and files, with no typed path or URL', async () => {
  serve();
  await render(
    <CommentPictures thread="thr_01K7AAAAAAAAAAAAAAAAAAAAAA" records={[]}>
      <Pane start={scope} steps={[]} />
    </CommentPictures>,
  );
  await commentOnPhrase('Partial refunds stay out of v1.');
  expect(pictureButton()).not.toBeNull();
  await act(async () => (pictureButton() as HTMLButtonElement).click());
  expect(document.querySelector('input[placeholder="Paste path or URL..."]')).toBeNull();
  expect(document.body.textContent).toContain('Drop a file or click to browse');
});
