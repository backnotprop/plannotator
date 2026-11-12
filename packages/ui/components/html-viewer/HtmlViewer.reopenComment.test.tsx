import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Annotation } from '../../types';
import { AnnotationType } from '../../types';
import type { ViewerHandle } from '../Viewer';
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCRIPT } from './bridge-script';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

const mountedRoots: Array<{ unmount: () => void }> = [];
afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

const anchor = { selector: 'p:nth-of-type(1)', tagName: 'p', text: 'Pinpoint target' };
const kept: Annotation = {
  id: 'html-ann-kept',
  blockId: '',
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  text: 'Words not saved yet',
  originalText: 'Pinpoint target',
  createdA: 1,
  htmlAnchor: anchor,
};

describe.if(hasDom)('HtmlViewer reopenComment', () => {
  async function mount(options: { ready?: boolean; readOnly?: boolean; onHostDraft?: (draft: unknown) => void } = {}) {
    const HtmlViewer = htmlViewerModule!.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    const handle = React.createRef<ViewerHandle>();
    const added: Annotation[] = [];
    await act(async () => {
      root.render(
        <HtmlViewer
          ref={handle}
          rawHtml="<html><body><p>Pinpoint target</p></body></html>"
          annotations={[]}
          onAddAnnotation={(ann) => added.push(ann)}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          readOnly={options.readOnly}
          {...(options.onHostDraft ? { onHostDraft: options.onHostDraft as never } : {})}
        />,
      );
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    const posted: Array<Record<string, unknown>> = [];
    (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage = (data: unknown) => {
      if (data && typeof data === 'object') posted.push(data as Record<string, unknown>);
    };
    const fromBridge = (data: Record<string, unknown>) =>
      act(async () => {
        window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data }));
      });
    const ready = () => fromBridge({ type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION });
    if (options.ready !== false) await ready();
    const restores = () => posted.filter((m) => m.type === 'plannotator-bridge-restore-draft');
    return { handle, added, posted, restores, fromBridge, ready };
  }

  const selectionFor = (restoreId: unknown) => ({
    type: 'plannotator-bridge-selection',
    text: 'Pinpoint target',
    rect: { top: 10, left: 10, width: 120, height: 24 },
    anchor,
    pinpoint: true,
    targetKey: 'ht-1',
    restoreId,
  });
  const composerText = () => document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')?.value;

  test('a pin comes back: the bridge is asked by anchor, and its answer opens the composer holding the words', async () => {
    const { handle, restores, fromBridge } = await mount();
    let missing = 0;
    expect(handle.current!.reopenComment!(kept, () => (missing += 1))).toBe(true);
    expect(restores()).toHaveLength(1);
    expect(restores()[0]).toMatchObject({ anchor, text: 'Pinpoint target' });
    await fromBridge(selectionFor(restores()[0]!.id));
    expect(composerText()).toBe('Words not saved yet');
    expect(missing).toBe(0);
  });

  test('a text selection comes back by its words, straight to the composer', async () => {
    const { handle, restores, fromBridge } = await mount();
    const selection: Annotation = { ...kept, htmlAnchor: undefined, originalText: 'Pinpoint' };
    expect(handle.current!.reopenComment!(selection)).toBe(true);
    expect('anchor' in restores()[0]!).toBe(false);
    expect(restores()[0]!.text).toBe('Pinpoint');
    await fromBridge({ type: 'plannotator-bridge-selection', text: 'Pinpoint', rect: { top: 1, left: 1, width: 40, height: 12 }, restoreId: restores()[0]!.id });
    expect(composerText()).toBe('Words not saved yet');
    expect(document.querySelector('.annotation-toolbar')).toBeNull();
  });

  test('only the answer to the request carries the words: another selection opens as it always has', async () => {
    const { handle, restores, fromBridge } = await mount();
    handle.current!.reopenComment!(kept);
    await fromBridge(selectionFor(undefined));
    expect(composerText()).toBe('');
    expect(restores()).toHaveLength(1);
  });

  test('no answer: after a few seconds onMissing runs, and a late answer is let go', async () => {
    const { handle, restores, posted, fromBridge } = await mount();
    let missing = 0;
    handle.current!.reopenComment!(kept, () => (missing += 1));
    const id = restores()[0]!.id;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3200));
    });
    expect(missing).toBe(1);
    await fromBridge(selectionFor(id));
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
    expect(posted.some((m) => m.type === 'plannotator-bridge-cancel-selection')).toBe(true);
  });

  test('nothing found: onMissing runs once, and nothing opens', async () => {
    const { handle, restores, fromBridge } = await mount();
    let missing = 0;
    handle.current!.reopenComment!(kept, () => (missing += 1));
    const id = restores()[0]!.id;
    await fromBridge({ type: 'plannotator-bridge-restore-draft-missing', id });
    await fromBridge({ type: 'plannotator-bridge-restore-draft-missing', id });
    expect(missing).toBe(1);
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
  });

  test('asked before the bridge is ready, it is posted once it is', async () => {
    const { handle, restores, ready } = await mount({ ready: false });
    expect(handle.current!.reopenComment!(kept)).toBe(true);
    expect(restores()).toHaveLength(0);
    await ready();
    expect(restores()).toHaveLength(1);
  });

  test('read-only, or a comment with nothing to pin, opens nothing', async () => {
    const readOnly = await mount({ readOnly: true });
    expect(readOnly.handle.current!.reopenComment!(kept)).toBe(false);
    expect(readOnly.restores()).toHaveLength(0);
    const viewer = await mount();
    expect(viewer.handle.current!.reopenComment!({ ...kept, type: AnnotationType.GLOBAL_COMMENT })).toBe(false);
    expect(viewer.handle.current!.reopenComment!({ ...kept, htmlAnchor: undefined, originalText: '' })).toBe(false);
    expect(viewer.restores()).toHaveLength(0);
  });

  test('a host that composes is handed the draft to compose', async () => {
    const drafts: Array<{ intent: string; annotation: Annotation }> = [];
    const { handle, restores, fromBridge } = await mount({ onHostDraft: (draft) => draft && drafts.push(draft as never) });
    handle.current!.reopenComment!({ ...kept, htmlAnchor: undefined });
    await fromBridge({ type: 'plannotator-bridge-selection', text: 'Pinpoint target', rect: { top: 1, left: 1, width: 40, height: 12 }, restoreId: restores()[0]!.id });
    expect(drafts.map((d) => d.intent)).toEqual(['compose']);
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
  });
});

function extractFunction(name: string): string {
  const start = BRIDGE_SCRIPT.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`bridge no longer defines ${name}`);
  let depth = 0;
  for (let i = BRIDGE_SCRIPT.indexOf('{', start); i < BRIDGE_SCRIPT.length; i += 1) {
    if (BRIDGE_SCRIPT[i] === '{') depth += 1;
    else if (BRIDGE_SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return BRIDGE_SCRIPT.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces around ${name}`);
}

function bridgeRestore(world: { element: unknown; range: unknown; annotate: boolean; select: boolean }) {
  const calls: Array<{ fn: string; args: unknown[]; restoreId: unknown }> = [];
  const posted: Array<Record<string, unknown>> = [];
  const make = new Function(
    'world',
    'calls',
    'posted',
    `var PREFIX = 'plannotator-bridge-';
     var restoreDraftId = null;
     var window = { getSelection: function () { return { removeAllRanges: function () {}, addRange: function (r) { calls.push({ fn: 'addRange', args: [r], restoreId: restoreDraftId }); } }; } };
     function resolveAnchorElement(a) { calls.push({ fn: 'resolve', args: [a], restoreId: restoreDraftId }); return world.element; }
     function annotateElement(el, mode, via, point) { calls.push({ fn: 'annotate', args: [el, via, point], restoreId: restoreDraftId }); return world.annotate; }
     function findTextRange(text) { calls.push({ fn: 'find', args: [text], restoreId: restoreDraftId }); return world.range; }
     function handleSelection() { calls.push({ fn: 'select', args: [], restoreId: restoreDraftId }); return world.select; }
     function postToParent(m) { posted.push(m); }
     ${extractFunction('restoreDraft')}
     return { restoreDraft: restoreDraft, id: function () { return restoreDraftId; } };`,
  );
  return { api: make(world, calls, posted) as { restoreDraft: (data: unknown) => void; id: () => unknown }, calls, posted };
}

describe('the bridge answering restore-draft', () => {
  const element = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 20 }) };

  test('an anchor that resolves is pinned again at its point, under the request id', () => {
    const { api, calls, posted } = bridgeRestore({ element, range: null, annotate: true, select: false });
    api.restoreDraft({ id: 'r1', anchor: { ...anchor, point: { x: 0.25, y: 0.5 } }, text: 'Pinpoint target' });
    const pinned = calls.find((c) => c.fn === 'annotate')!;
    expect(pinned.args).toEqual([element, true, { x: 150, y: 60 }]);
    expect(pinned.restoreId).toBe('r1');
    expect(api.id()).toBeNull();
    expect(posted).toEqual([]);
  });

  test('an anchor that no longer resolves falls back to selecting the words', () => {
    const range = { fake: true };
    const { api, calls, posted } = bridgeRestore({ element: null, range, annotate: false, select: true });
    api.restoreDraft({ id: 'r2', anchor, text: 'Pinpoint target' });
    expect(calls.map((c) => c.fn)).toEqual(['resolve', 'find', 'addRange', 'select']);
    expect(calls.find((c) => c.fn === 'select')!.restoreId).toBe('r2');
    expect(posted).toEqual([]);
  });

  test('nothing found says so', () => {
    const { api, posted } = bridgeRestore({ element: null, range: null, annotate: false, select: false });
    api.restoreDraft({ id: 'r3', anchor, text: 'Gone' });
    expect(posted).toEqual([{ type: 'plannotator-bridge-restore-draft-missing', id: 'r3' }]);
    api.restoreDraft({ text: 'no id' });
    expect(posted).toHaveLength(1);
  });
});
