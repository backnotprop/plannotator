import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useCallback, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  requestVimDocumentFocus,
  useVimDocumentFocus,
} from './useVimDocumentFocus';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

interface HarnessProps {
  readonly enabled?: boolean;
  readonly blocked?: boolean;
}

function Harness({ enabled = true, blocked = false }: HarnessProps) {
  const documentRef = useRef<HTMLButtonElement>(null);
  const focusDocument = useCallback((): boolean => {
    const documentButton = documentRef.current;
    if (!documentButton) return false;
    if (window.document.activeElement === documentButton) return false;
    documentButton.focus();
    return window.document.activeElement === documentButton;
  }, []);

  useVimDocumentFocus({ enabled, blocked, focusDocument });

  return <button ref={documentRef}>Document surface</button>;
}

async function mountHarness(props: HarnessProps = {}): Promise<HTMLButtonElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness {...props} />));
  const documentButton = host.querySelector<HTMLButtonElement>('button');
  if (!documentButton) throw new Error('Document focus surface did not render');
  return documentButton;
}

function escape(target: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('useVimDocumentFocus', () => {
  afterEach(async () => {
    const mountedRoot = root;
    if (mountedRoot) await act(async () => mountedRoot.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('takes initial focus only when the page is neutral', async () => {
    const documentButton = await mountHarness();
    expect(document.activeElement).toBe(documentButton);

    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;

    const existingInput = document.createElement('input');
    document.body.appendChild(existingInput);
    existingInput.focus();
    await mountHarness();
    expect(document.activeElement).toBe(existingInput);
  });

  test.skipIf(!hasDom)('returns from app chrome on Escape without taking editable or modal focus', async () => {
    const documentButton = await mountHarness();
    const chromeButton = document.createElement('button');
    chromeButton.textContent = 'App control';
    document.body.appendChild(chromeButton);
    chromeButton.focus();

    const chromeEscape = escape(chromeButton);
    expect(document.activeElement).toBe(documentButton);
    expect(chromeEscape.defaultPrevented).toBe(true);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(escape(input).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0';
    const dialogButton = document.createElement('button');
    overlay.appendChild(dialogButton);
    document.body.appendChild(overlay);
    dialogButton.focus();
    expect(escape(dialogButton).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(dialogButton);
  });

  test.skipIf(!hasDom)('stays inert while the document controller is blocked', async () => {
    await mountHarness({ blocked: true });
    const chromeButton = document.createElement('button');
    document.body.appendChild(chromeButton);
    chromeButton.focus();

    expect(escape(chromeButton).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(chromeButton);
  });

  test.skipIf(!hasDom)('accepts an explicit handoff after an owned UI closes', async () => {
    const documentButton = await mountHarness();
    const chromeButton = document.createElement('button');
    document.body.appendChild(chromeButton);
    chromeButton.focus();

    requestVimDocumentFocus();

    expect(document.activeElement).toBe(documentButton);
  });
});
