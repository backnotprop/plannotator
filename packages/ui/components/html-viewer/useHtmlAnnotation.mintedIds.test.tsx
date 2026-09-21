/**
 * Locally minted annotation ids are per viewer instance (DOM-gated).
 *
 * A module-wide set leaked every id ever minted into unrelated later
 * HtmlViewer instances of a long-lived host page (the Workspaces SPA), so a
 * fresh instance started with a populated `createdAnnotationIds`. Mount A,
 * mint, unmount, mount B: B must start empty.
 */
import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../../types';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useHtmlAnnotation') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

type HookResult = ReturnType<NonNullable<typeof hookModule>['useHtmlAnnotation']>;

function Harness({ onResult, onAdd }: { onResult: (r: HookResult, iframe: HTMLIFrameElement) => void; onAdd: (a: Annotation) => void }) {
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const result = hookModule!.useHtmlAnnotation({
    iframeRef,
    enabled: true,
    annotations: [],
    onAddAnnotation: onAdd,
    onSelectAnnotation: () => {},
    selectedAnnotationId: null,
    mode: 'comment',
  });
  React.useEffect(() => {
    if (iframeRef.current) onResult(result, iframeRef.current);
  });
  return <iframe ref={iframeRef} title="t" />;
}

function mount(onAdd: (a: Annotation) => void): Promise<{ result: HookResult; iframe: HTMLIFrameElement }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  return new Promise((resolve) => {
    act(() => {
      root!.render(<Harness onAdd={onAdd} onResult={(result, iframe) => resolve({ result, iframe })} />);
    });
  });
}

function fireSelection(iframe: HTMLIFrameElement, text: string) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'plannotator-bridge-selection', text, rect: { top: 0, left: 0, width: 10, height: 10 } },
      source: iframe.contentWindow,
    }));
  });
}

describe.if(hasDom)('useHtmlAnnotation minted ids', () => {
  test('ids minted by one instance do not leak into a later, unrelated instance', async () => {
    const added: Annotation[] = [];
    const first = await mount((a) => added.push(a));
    fireSelection(first.iframe, 'first selection');
    act(() => {
      first.result.handleCommentLooksGood();
    });
    expect(added.length).toBe(1);
    expect(first.result.createdAnnotationIds.has(added[0].id)).toBe(true);

    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;

    const second = await mount(() => {});
    expect(second.result.createdAnnotationIds.size).toBe(0);
  });
});
