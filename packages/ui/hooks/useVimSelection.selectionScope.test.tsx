import { afterEach, describe, expect, test } from 'bun:test';
import React, { useCallback, useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The page has ONE selection. The vim hook resets it when vim is off, on every
// mount and every `contentVersion` change; a host (Workspaces) lost selections
// made in another panel ~12 ms after making them whenever the document behind
// them loaded. These tests pin that the reset only touches a selection inside
// the viewer's own container.

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useVimSelection') : null;

interface HarnessProps {
  enabled: boolean;
  contentVersion: unknown;
  /** Runs in the commit phase, before the hook's passive effects. */
  onArticleAttach?: (article: HTMLElement) => void;
}

function Harness({ enabled, contentVersion, onArticleAttach }: HarnessProps) {
  if (!hookModule) throw new Error('DOM test environment is not registered');
  const articleRef = useRef<HTMLElement | null>(null);
  const attach = useCallback((el: HTMLElement | null) => {
    articleRef.current = el;
    if (el) onArticleAttach?.(el);
  }, [onArticleAttach]);
  hookModule.useVimSelection({
    containerRef: articleRef,
    enabled,
    hudEnabled: false,
    blocked: false,
    activeMode: 'selection',
    contentVersion,
    onHighlightRange: () => {},
    onCodeBlockAction: () => {},
    onMathAction: () => {},
  });
  return (
    <article ref={attach} tabIndex={enabled ? 0 : undefined}>
      <p data-block-id="intro">Inside the viewer</p>
    </article>
  );
}

function selectContents(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectedText(): string {
  return window.getSelection()?.toString() ?? '';
}

function mount(props: HarnessProps): { root: Root; render: (next: HarnessProps) => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (next: HarnessProps) => act(() => root.render(<Harness {...next} />));
  render(props);
  return { root, render };
}

afterEach(() => {
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

describe.if(hasDom)('useVimSelection selection reset scope', () => {
  test('a selection outside the viewer survives mount and content changes with vim off', () => {
    const outside = document.createElement('p');
    outside.textContent = 'Another panel';
    document.body.appendChild(outside);
    selectContents(outside);
    expect(selectedText()).toBe('Another panel');

    const { root, render } = mount({ enabled: false, contentVersion: 1 });
    expect(selectedText()).toBe('Another panel');

    render({ enabled: false, contentVersion: 2 });
    expect(selectedText()).toBe('Another panel');

    act(() => root.unmount());
  });

  test('a selection inside the viewer is still cleared on mount and on content changes', () => {
    const selectInside = (article: HTMLElement) => selectContents(article);
    const { root, render } = mount({
      enabled: false,
      contentVersion: 1,
      onArticleAttach: selectInside,
    });
    // Selected during commit, then reset by the mount effect.
    expect(selectedText()).toBe('');

    const article = document.querySelector('article');
    if (!article) throw new Error('harness did not render');
    selectContents(article);
    expect(selectedText()).toBe('Inside the viewer');

    render({ enabled: false, contentVersion: 2, onArticleAttach: selectInside });
    expect(selectedText()).toBe('');

    act(() => root.unmount());
  });
});
