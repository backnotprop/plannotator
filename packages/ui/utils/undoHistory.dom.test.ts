import '../test-setup/happy-dom';
import { afterEach, describe, expect, it } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  dispatchShortcutEvent,
  historyShortcuts,
  useHistoryShortcuts,
  useImageAnnotatorShortcuts,
} from '../shortcuts';
import { useUndoHistory, type UndoHistoryApi } from '../hooks/useUndoHistory';
import { hasActiveHistoryOverlay, isNativeHistoryOwner } from './undoHistory';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

function keyboardEvent(target: Element, options: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

function nativeOwner(target: Element): boolean {
  let ownsHistory = false;
  target.addEventListener('keydown', (event) => {
    if (event instanceof KeyboardEvent) ownsHistory = isNativeHistoryOwner(event);
  }, { once: true });
  keyboardEvent(target, { key: 'z', ctrlKey: true });
  return ownsHistory;
}

const ShortcutArbitrationHarness: React.FC<{
  imageOpen: boolean;
  calls: string[];
}> = ({ imageOpen, calls }) => {
  useHistoryShortcuts({
    handlers: {
      undo: {
        when: (event) => !event.defaultPrevented
          && !isNativeHistoryOwner(event)
          && !hasActiveHistoryOverlay(document),
        handle: () => calls.push('document'),
      },
    },
  });
  return imageOpen
    ? React.createElement(ImageShortcutOwner, { calls })
    : React.createElement('button', { type: 'button' }, 'Document target');
};

const ImageShortcutOwner: React.FC<{ calls: string[] }> = ({ calls }) => {
  useImageAnnotatorShortcuts({
    handlers: {
      undo: {
        when: (event) => !event.defaultPrevented,
        handle: () => calls.push('image'),
      },
    },
  });
  return React.createElement('button', { type: 'button', 'data-popover-layer': true }, 'Image target');
};

let renderCount = 0;
let historyApi: UndoHistoryApi<string> | null = null;
const appliedHistory: string[] = [];

const UndoHistoryHarness: React.FC<{ context: string }> = ({ context }) => {
  renderCount += 1;
  historyApi = useUndoHistory({
    context,
    apply: (action, direction) => appliedHistory.push(`${direction}:${action}`),
  });
  return null;
};

describe('undo shortcut ownership', () => {
  it.skipIf(!hasDom)('leaves native and shadow-DOM text history alone', () => {
    const input = document.createElement('input');
    document.body.append(input);
    expect(nativeOwner(input)).toBe(true);

    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.append(editable);
    expect(nativeOwner(editable)).toBe(true);

    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const codeMirror = document.createElement('div');
    codeMirror.className = 'cm-editor';
    const textarea = document.createElement('textarea');
    codeMirror.append(textarea);
    shadow.append(codeMirror);
    document.body.append(host);
    expect(nativeOwner(textarea)).toBe(true);
  });

  it.skipIf(!hasDom)('dispatches redo before undo and only prevents handled shortcuts', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const calls: string[] = [];
    const redoEvent = keyboardEvent(button, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(dispatchShortcutEvent(historyShortcuts, {
      undo: { when: () => false, handle: () => calls.push('undo') },
      redo: () => calls.push('redo'),
    }, redoEvent)).toBe(true);
    expect(calls).toEqual(['redo']);
    expect(redoEvent.defaultPrevented).toBe(true);

    const nativeEvent = keyboardEvent(button, { key: 'z', ctrlKey: true });
    expect(dispatchShortcutEvent(historyShortcuts, {
      undo: { when: () => false, handle: () => calls.push('undo') },
    }, nativeEvent)).toBe(false);
    expect(nativeEvent.defaultPrevented).toBe(false);
  });

  it.skipIf(!hasDom)('lets the mounted image scope win through the real overlay gate', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const calls: string[] = [];
    await act(async () => {
      root?.render(React.createElement(ShortcutArbitrationHarness, { imageOpen: true, calls }));
    });

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(calls).toEqual(['image']);
    expect(event.defaultPrevented).toBe(true);

    await act(async () => {
      root?.render(React.createElement(ShortcutArbitrationHarness, { imageOpen: false, calls }));
    });
    const documentEvent = new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(documentEvent);
    expect(calls).toEqual(['image', 'document']);
    expect(documentEvent.defaultPrevented).toBe(true);
  });

  it.skipIf(!hasDom)('detects dialogs, composers, and focused source editors', () => {
    const root = document.createElement('div');
    document.body.append(root);
    expect(hasActiveHistoryOverlay(root)).toBe(false);
    for (const markup of [
      '<div role="dialog"></div>',
      '<div data-comment-popover="true"></div>',
      '<div data-history-owner="edit-session"></div>',
      '<div class="cm-editor cm-focused"></div>',
    ]) {
      root.innerHTML = markup;
      expect(hasActiveHistoryOverlay(root)).toBe(true);
    }
  });

  it.skipIf(!hasDom)('updates history imperatively without rerendering its owner', async () => {
    renderCount = 0;
    historyApi = null;
    appliedHistory.length = 0;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(React.createElement(UndoHistoryHarness, { context: 'document:a' }));
    });
    const api = historyApi;
    if (!api) throw new Error('undo history did not mount');
    const rendersAfterMount = renderCount;

    api.record('add');
    expect(api.canUndo).toBe(true);
    expect(renderCount).toBe(rendersAfterMount);
    expect(api.undo()).toBe(true);
    expect(appliedHistory).toEqual(['undo:add']);
    expect(renderCount).toBe(rendersAfterMount);

    await act(async () => {
      root?.render(React.createElement(UndoHistoryHarness, { context: 'document:b' }));
    });
    const nextApi = historyApi;
    if (!nextApi) throw new Error('undo history did not update');
    expect(nextApi.canUndo).toBe(false);
    expect(nextApi.canRedo).toBe(false);

    nextApi.record('second-context');
    await act(async () => {
      root?.render(React.createElement(UndoHistoryHarness, { context: 'document:a' }));
    });
    expect(nextApi.canUndo).toBe(false);
    expect(nextApi.canRedo).toBe(false);
  });
});
