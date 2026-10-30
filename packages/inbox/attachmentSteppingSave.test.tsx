/**
 * "Save it and go on" never drops a typed comment (stepping design record,
 * v2): the question row waits for the save to answer before it moves, keeps
 * the words when nothing was saved, stays on the file when the save fails,
 * and covers every composer the pane draws through the real viewers: a
 * markdown selection's comment popover, an HTML pinpoint's, a diagram node's
 * composer, and an annotation being edited in the panel. Also: a page that
 * posts the bridge's `step` itself, without the person's focus, never moves
 * the pane, and no bridge step moves it while the question row is open.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * The diagram fixture and its geometry are DiagramBlock.askAI.test.tsx's.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentSequence, type AttachmentStep } from './stepping';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const diagramSvg = hasDom ? await import('@plannotator/ui/test-setup/diagramSvg') : null;
const mermaid = hasDom ? await import('@plannotator/ui/utils/mermaid') : null;
const htmlViewer = hasDom ? await import('@plannotator/ui/components/html-viewer/HtmlViewer') : null;

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
const message = { id: M1, created_at: '2026-10-10T10:42:00.000Z', author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' } } as unknown as InboxMessageWire;
const STEPS: AttachmentStep[] = attachmentSequence([message], [scope, page, flow, policy]);
const TEXT: Record<string, { text: string; html: string | null }> = {
  [scope.id]: { text: MARKDOWN, html: null },
  [page.id]: { text: PAGE, html: PAGE },
  [flow.id]: { text: FLOW, html: null },
};

interface Server {
  /** The bodies of every annotation save. */
  saved: { attachment_id: string; annotation: { id: string; text?: string; htmlAnchor?: unknown; diagramAnchor?: unknown } }[];
  /** The next saves fail with a 500 while true. */
  failing: boolean;
  /** A save answers only once released (the row must wait for it). */
  hold: boolean;
  release: () => void;
}

function serve(): Server {
  const server: Server = { saved: [], failing: false, hold: false, release: noop };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const view = /\/api\/inbox\/attachments\/(att_[0-9A-Z]+)\/view/.exec(url);
    if (view) {
      const attachment = [scope, page, flow, policy].find((a) => a.id === view[1])!;
      const body = TEXT[attachment.id]!;
      return new Response(JSON.stringify({ serverSession: 's', attachment, version: 'current', text: body.text, html: body.html }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/inbox/annotations')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      server.saved.push(body);
      if (server.hold) await new Promise<void>((resolve) => (server.release = resolve));
      if (server.failing) return new Response(JSON.stringify({ error: 'The Inbox is not answering.', code: 'unavailable' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      const owner = [scope, page, flow, policy].find((a) => a.id === body.attachment_id)!;
      const record: Partial<InboxAnnotationRecord> = { id: body.annotation.id, attachment_id: owner.id, path: owner.path, version: 'current', annotation: body.annotation, message_id: M1 };
      return new Response(JSON.stringify({ annotation: record }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return server;
}

function Pane({ start, steps, records = [] }: { start: InboxAttachmentState; steps: { id: string }[]; records?: InboxAnnotationRecord[] }) {
  const [open, setOpen] = useState(start);
  const all = STEPS.map((s) => s.attachment);
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
      onClose={noop}
      strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      steps={STEPS}
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

async function pressNext() {
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-step-next]')!.click());
}

async function saveAndGoOn() {
  await act(async () => guard()!.querySelector<HTMLButtonElement>('[data-guard-save]')!.click());
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

test.skipIf(!hasDom)('markdown: the popover comment is saved on its file before the step, and the row waits for the save', async () => {
  const server = serve();
  server.hold = true;
  const steps: { id: string }[] = [];
  await render(<Pane start={scope} steps={steps} />);
  await commentOnPhrase('Partial refunds stay out of v1.');
  await type(popoverBox()!, 'Partial refunds are in for v1.');
  await pressNext();
  expect(guard()).not.toBeNull();
  await saveAndGoOn();
  await settle();
  // The save has not answered: nothing moved, and the row says it is saving.
  expect(server.saved).toHaveLength(1);
  expect(steps).toEqual([]);
  expect(guard()!.querySelector('[data-guard-save]')!.getAttribute('aria-busy')).toBe('true');
  await act(async () => server.release());
  await waitFor(() => expect(steps.map((s) => s.id)).toEqual([page.id]));
  expect(server.saved[0]!.attachment_id).toBe(scope.id);
  expect(server.saved[0]!.annotation.text).toBe('Partial refunds are in for v1.');
});

test.skipIf(!hasDom)('markdown: a failed save stays on the file with the error, never steps', async () => {
  const server = serve();
  server.failing = true;
  const steps: { id: string }[] = [];
  await render(<Pane start={scope} steps={steps} />);
  await commentOnPhrase('Payment retries stop after five attempts.');
  await type(popoverBox()!, 'Make it per merchant.');
  await pressNext();
  await saveAndGoOn();
  await waitFor(() => expect(pane().querySelector('[role="alert"]')?.textContent).toContain('The Inbox is not answering.'));
  expect(steps).toEqual([]);
  expect(pane().getAttribute('data-attachment-pane')).toBe(scope.id);
  expect(guard()).toBeNull();
});

test.skipIf(!hasDom)('HTML pinpoint: the pinned comment is saved with its anchor before the step', async () => {
  const server = serve();
  const steps: { id: string }[] = [];
  await render(<Pane start={page} steps={steps} />);
  await pinParagraph();
  await type(popoverBox()!, 'Say the amount on the button.');
  await pressNext();
  expect(guard()!.querySelector('[data-guard-discard]')!.textContent).toBe('Discard and go to retry.mmd');
  await saveAndGoOn();
  await waitFor(() => expect(steps.map((s) => s.id)).toEqual([flow.id]));
  expect(server.saved).toHaveLength(1);
  expect(server.saved[0]!.attachment_id).toBe(page.id);
  expect(server.saved[0]!.annotation.text).toBe('Say the amount on the button.');
  expect(server.saved[0]!.annotation.htmlAnchor).toBeTruthy();
});

test.skipIf(!hasDom)('diagram node: the node comment is saved with its anchor before the step', async () => {
  const server = serve();
  const steps: { id: string }[] = [];
  await render(<Pane start={flow} steps={steps} />);
  await clickNodeD();
  await type(pane().querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea')!, 'Who approves on a holiday?');
  await pressNext();
  expect(guard()).not.toBeNull();
  await saveAndGoOn();
  await waitFor(() => expect(steps.map((s) => s.id)).toEqual([policy.id]));
  expect(server.saved).toHaveLength(1);
  expect(server.saved[0]!.attachment_id).toBe(flow.id);
  expect(server.saved[0]!.annotation.text).toBe('Who approves on a holiday?');
  expect(server.saved[0]!.annotation.diagramAnchor).toBeTruthy();
});

test.skipIf(!hasDom)('a composer that saves nothing keeps the row open and the words focused', async () => {
  serve();
  const steps: { id: string }[] = [];
  await render(<Pane start={policy} steps={steps} />);
  // A comment popover whose Cmd/Ctrl+Enter does nothing (it refused the words).
  const layer = document.createElement('div');
  layer.setAttribute('data-comment-popover', 'true');
  const box = document.createElement('textarea');
  box.value = 'Typed and not saved.';
  layer.appendChild(box);
  document.body.appendChild(layer);
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-step-prev]')!.click());
  expect(guard()).not.toBeNull();
  await saveAndGoOn();
  await settle();
  expect(steps).toEqual([]);
  expect(guard()).not.toBeNull();
  expect(document.activeElement).toBe(box);
  expect(box.selectionStart).toBe(box.value.length);
});

test.skipIf(!hasDom)('an annotation edited in the panel and not saved asks too, and Save it and go on saves the edit', async () => {
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
  // Opening the editor without changing a word does not ask.
  await act(async () => pane().querySelector<HTMLButtonElement>('[data-annotation-id="ann-1"] button:is([title="Edit annotation"], [aria-label="Edit annotation"])')!.click());
  const box = pane().querySelector<HTMLTextAreaElement>('[data-annotation-id="ann-1"] textarea')!;
  expect(box.value).toBe('Five is fine.');
  await pressNext();
  expect(guard()).toBeNull();
  expect(steps.map((s) => s.id)).toEqual([page.id]);
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-step-prev]')!.click());
  await waitFor(() => expect(pane().querySelector('[data-annotation-id="ann-1"]')).not.toBeNull());
  await act(async () => pane().querySelector<HTMLButtonElement>('[data-annotation-id="ann-1"] button:is([title="Edit annotation"], [aria-label="Edit annotation"])')!.click());
  await type(pane().querySelector<HTMLTextAreaElement>('[data-annotation-id="ann-1"] textarea')!, 'Make it eight for big accounts.');
  await pressNext();
  expect(guard()).not.toBeNull();
  await saveAndGoOn();
  await waitFor(() => expect(steps.map((s) => s.id)).toEqual([page.id, scope.id, page.id]));
  expect(server.saved.map((s) => s.annotation.text)).toEqual(['Make it eight for big accounts.']);
  expect(server.saved[0]!.annotation.id).toBe('ann-1');
});

test.skipIf(!hasDom)('a page posting the bridge step every 50 ms without focus never moves the pane; with the row open no bridge step does', async () => {
  serve();
  const steps: { id: string }[] = [];
  await render(<Pane start={page} steps={steps} />);
  await waitFor(() => expect(pane().querySelector('iframe')).not.toBeNull());
  const iframe = pane().querySelector('iframe')!;
  const post = async () => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'plannotator-bridge-step', dir: 1 } }));
    });
  };
  for (let i = 0; i < 6; i++) {
    await post();
    await settle(50);
  }
  expect(steps).toEqual([]);

  // A typed comment raises the row; the page's own steps, even with focus, are ignored under it.
  await pinParagraph();
  await type(popoverBox()!, 'Not saved yet.');
  await pressNext();
  expect(guard()).not.toBeNull();
  await act(async () => iframe.focus());
  await settle(htmlViewer!.STEP_MESSAGE_MIN_INTERVAL_MS + 20);
  await post();
  expect(steps).toEqual([]);
  expect(pane().getAttribute('data-attachment-pane')).toBe(page.id);
});
