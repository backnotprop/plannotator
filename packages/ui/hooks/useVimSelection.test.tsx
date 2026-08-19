import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorMode } from '../types';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useVimSelection') : null;

interface VimHarnessProps {
  enabled: boolean;
  hudEnabled?: boolean;
  blocked?: boolean;
  scrollViewport?: HTMLElement | null;
  onRange: (text: string, mode?: EditorMode) => void;
}

function VimHarness({
  enabled,
  hudEnabled = false,
  blocked = false,
  scrollViewport,
  onRange,
}: VimHarnessProps) {
  if (!hookModule) throw new Error('DOM test environment is not registered');
  const articleRef = useRef<HTMLElement | null>(null);
  const vim = hookModule.useVimSelection({
    containerRef: articleRef,
    scrollViewport,
    enabled,
    hudEnabled,
    blocked,
    activeMode: 'selection',
    onHighlightRange: (range, mode) => onRange(range.toString(), mode),
    onCodeBlockAction: (_blockId, element, mode) =>
      onRange(element.textContent?.trim() ?? '', mode),
    onMathAction: (element, mode) => onRange(element.textContent?.trim() ?? '', mode),
  });

  return (
    <article
      ref={articleRef}
      tabIndex={enabled ? 0 : undefined}
      data-phase={vim.state.phase}
      data-target-key={vim.activeTarget?.key ?? ''}
      data-hud-key={vim.hudCommand?.key ?? ''}
      data-hud-command={vim.hudCommand?.description ?? ''}
      onFocus={vim.onFocus}
      onBlur={vim.onBlur}
      onMouseDown={vim.onMouseDown}
    >
      <p data-block-id="intro">Alpha <strong>bravo</strong> charlie</p>
      <div data-block-id="matrix">
        <table>
          <tbody>
            <tr><td>A1</td><td>A2</td></tr>
            <tr><td>B1</td><td>B2</td></tr>
          </tbody>
        </table>
      </div>
      <div data-block-id="code"><pre><code className="pn-code">const x = 1;</code></pre></div>
      <a data-testid="native-link" href="#destination">Native link</a>
      <input data-testid="native-input" defaultValue="typing stays native" />
    </article>
  );
}

function keydown(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey: /^[A-Z]$/.test(key) || ['?', '{', '}', '$'].includes(key),
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function mountHarness(props: VimHarnessProps): { article: HTMLElement; root: Root; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<VimHarness {...props} />);
  });
  const article = host.querySelector<HTMLElement>('article');
  if (!article) throw new Error('Vim harness did not render');
  return { article, root, host };
}

afterEach(() => {
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

describe.if(hasDom)('useVimSelection', () => {
  test('is completely inert when the opt-in setting is disabled', () => {
    const actions: string[] = [];
    const { article, root } = mountHarness({
      enabled: false,
      onRange: (text) => actions.push(text),
    });

    article.focus();
    const visual = keydown(article, 'v');
    const deleteAction = keydown(article, 'd');

    expect(visual.defaultPrevented).toBe(false);
    expect(deleteAction.defaultPrevented).toBe(false);
    expect(article.dataset.phase).toBe('inactive');
    expect(actions).toEqual([]);
    act(() => root.unmount());
  });

  test('does not retain handled commands when the optional HUD is disabled', () => {
    const { article, root } = mountHarness({
      enabled: true,
      hudEnabled: false,
      onRange: () => {},
    });

    act(() => article.focus());
    act(() => { keydown(article, 'j'); });
    expect(article.dataset.phase).toBe('block');
    expect(article.dataset.hudKey).toBe('');
    act(() => root.unmount());
  });

  test('creates a Visual range and routes an action through the shared range callback', () => {
    const actions: Array<{ text: string; mode?: EditorMode }> = [];
    const { article, root } = mountHarness({
      enabled: true,
      onRange: (text, mode) => actions.push({ text, mode }),
    });

    act(() => article.focus());
    act(() => { keydown(article, 'v'); });
    act(() => { keydown(article, 'w'); });
    expect(article.dataset.phase).toBe('visual');
    expect(window.getSelection()?.toString()).toBe('Alpha ');

    let actionEvent: KeyboardEvent | null = null;
    act(() => { actionEvent = keydown(article, 'd'); });
    expect(actionEvent?.defaultPrevented).toBe(true);
    expect(actions).toEqual([{ text: 'Alpha ', mode: 'redline' }]);
    expect(article.dataset.phase).toBe('text');
    act(() => root.unmount());
  });

  test('enters Action state for the existing annotation toolbar without stealing its keys', () => {
    const actions: Array<{ text: string; mode?: EditorMode }> = [];
    const props: VimHarnessProps = {
      enabled: true,
      onRange: (text, mode) => actions.push({ text, mode }),
    };
    const { article, root } = mountHarness(props);

    act(() => article.focus());
    act(() => { keydown(article, 'v'); });
    act(() => { keydown(article, 'w'); });
    act(() => { keydown(article, ' '); });
    expect(actions).toEqual([{ text: 'Alpha ', mode: 'selection' }]);
    expect(article.dataset.phase).toBe('action');

    const toolbarKey = keydown(article, 'x');
    expect(toolbarKey.defaultPrevented).toBe(false);
    let escape: KeyboardEvent | null = null;
    act(() => { escape = keydown(article, 'Escape'); });
    expect(escape.defaultPrevented).toBe(false);
    expect(article.dataset.phase).toBe('action');

    act(() => root.render(<VimHarness {...props} blocked />));
    act(() => root.render(<VimHarness {...props} />));
    expect(article.dataset.phase).toBe('visual');
    expect(window.getSelection()?.toString()).toBe('Alpha ');
    act(() => root.unmount());
  });

  test('opens the annotation toolbar with both m and Space overrides', () => {
    const actions: Array<{ text: string; mode?: EditorMode }> = [];
    const first = mountHarness({
      enabled: true,
      onRange: (text, mode) => actions.push({ text, mode }),
    });

    act(() => first.article.focus());
    let markupEvent: KeyboardEvent | null = null;
    act(() => { markupEvent = keydown(first.article, 'm'); });
    expect(markupEvent?.defaultPrevented).toBe(true);
    expect(actions).toEqual([{ text: 'Alpha bravo charlie', mode: 'selection' }]);
    expect(first.article.dataset.phase).toBe('action');
    act(() => first.root.unmount());
    first.host.remove();

    const second = mountHarness({
      enabled: true,
      onRange: (text, mode) => actions.push({ text, mode }),
    });
    act(() => second.article.focus());
    let menuEvent: KeyboardEvent | null = null;
    act(() => { menuEvent = keydown(second.article, ' '); });
    expect(menuEvent?.defaultPrevented).toBe(true);
    expect(actions).toEqual([
      { text: 'Alpha bravo charlie', mode: 'selection' },
      { text: 'Alpha bravo charlie', mode: 'selection' },
    ]);
    expect(second.article.dataset.phase).toBe('action');
    act(() => second.root.unmount());
  });

  test('copies a Visual selection, collapses it, and keeps document focus', async () => {
    const copied: string[] = [];
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    const { article, root } = mountHarness({
      enabled: true,
      onRange: () => {},
    });

    try {
      act(() => article.focus());
      act(() => { keydown(article, 'v'); });
      act(() => { keydown(article, 'w'); });
      expect(window.getSelection()?.toString()).toBe('Alpha ');

      let copyEvent: KeyboardEvent | null = null;
      await act(async () => {
        copyEvent = keydown(article, 'y');
        await Promise.resolve();
      });

      expect(copyEvent?.defaultPrevented).toBe(true);
      expect(copied).toEqual(['Alpha ']);
      expect(article.dataset.phase).toBe('text');
      expect(document.activeElement).toBe(article);
      expect(window.getSelection()?.isCollapsed).toBe(true);
    } finally {
      act(() => root.unmount());
      if (clipboardDescriptor) {
        Object.defineProperty(
          navigator,
          'clipboard',
          clipboardDescriptor,
        );
      } else {
        delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      }
    }
  });

  test('does not restore stale document focus after the action UI closes elsewhere', () => {
    const props: VimHarnessProps = {
      enabled: true,
      onRange: () => {},
    };
    const { article, root } = mountHarness(props);
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    act(() => article.focus());
    act(() => { keydown(article, 'v'); });
    act(() => { keydown(article, 'w'); });
    act(() => { keydown(article, 'c'); });
    expect(article.dataset.phase).toBe('action');

    act(() => root.render(<VimHarness {...props} blocked />));
    act(() => outside.focus());
    act(() => root.render(<VimHarness {...props} />));
    expect(document.activeElement).toBe(outside);

    // A later, unrelated blocked transition must not consume the old action's
    // focus-restoration request after focus has intentionally moved elsewhere.
    act(() => outside.blur());
    act(() => root.render(<VimHarness {...props} blocked />));
    act(() => root.render(<VimHarness {...props} />));
    expect(document.activeElement).not.toBe(article);

    act(() => root.unmount());
    outside.remove();
  });

  test('preserves the native viewport position when document focus returns', () => {
    const viewport = document.createElement('main');
    document.body.appendChild(viewport);
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    viewport.scrollTop = 320;
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 400);

    const { article, root, host } = mountHarness({
      enabled: true,
      scrollViewport: viewport,
      onRange: () => {},
    });
    article.getBoundingClientRect = () => new DOMRect(0, -320, 800, 2000);

    const intro = host.querySelector<HTMLElement>('[data-block-id="intro"]');
    const matrix = host.querySelector<HTMLElement>('[data-block-id="matrix"] table');
    const code = host.querySelector<HTMLElement>('[data-block-id="code"]');
    if (!intro || !matrix || !code) throw new Error('Missing semantic target fixture');
    intro.getBoundingClientRect = () => new DOMRect(0, -300, 400, 40);
    matrix.getBoundingClientRect = () => new DOMRect(0, 180, 400, 40);
    code.getBoundingClientRect = () => new DOMRect(0, 800, 400, 40);

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    act(() => outside.focus());
    act(() => article.focus());

    expect(article.dataset.targetKey).toBe('matrix:table');
    expect(viewport.scrollTop).toBe(320);

    act(() => root.unmount());
    outside.remove();
    viewport.remove();
  });

  test('starts with block focus, refines through inline to text, and preserves controls', () => {
    const actions: Array<{ text: string; mode?: EditorMode }> = [];
    const { article, root, host } = mountHarness({
      enabled: true,
      onRange: (text, mode) => actions.push({ text, mode }),
    });

    act(() => article.focus());
    expect(article.dataset.phase).toBe('block');
    expect(article.dataset.targetKey).toBe('intro:block');
    const tab = keydown(article, 'Tab');
    expect(tab.defaultPrevented).toBe(false);
    expect(article.dataset.targetKey).toBe('intro:block');
    act(() => { keydown(article, 'l'); });
    expect(article.dataset.phase).toBe('inline');
    expect(article.dataset.targetKey).toBe('intro:inline:0');
    act(() => { keydown(article, 'l'); });
    expect(article.dataset.phase).toBe('text');
    act(() => { keydown(article, 'Escape'); });
    expect(article.dataset.phase).toBe('inline');
    act(() => { keydown(article, 'c'); });
    expect(actions).toEqual([{ text: 'bravo', mode: 'comment' }]);
    expect(article.dataset.phase).toBe('action');

    const input = host.querySelector<HTMLInputElement>('[data-testid="native-input"]');
    if (!input) throw new Error('Missing native input');
    input.focus();
    const inputEvent = keydown(input, 'd');
    expect(inputEvent.defaultPrevented).toBe(false);
    expect(actions).toHaveLength(1);

    const link = host.querySelector<HTMLAnchorElement>('[data-testid="native-link"]');
    if (!link) throw new Error('Missing native link');
    link.focus();
    const linkEvent = keydown(link, 'Enter');
    expect(linkEvent.defaultPrevented).toBe(false);
    expect(actions).toHaveLength(1);
    act(() => root.unmount());
  });

  test('walks blocks with j/k and extends a whole-block Visual selection', () => {
    const actions: Array<{ text: string; mode?: EditorMode }> = [];
    const { article, root } = mountHarness({
      enabled: true,
      hudEnabled: true,
      onRange: (text, mode) => actions.push({ text, mode }),
    });

    act(() => article.focus());
    expect(article.dataset.targetKey).toBe('intro:block');
    act(() => { keydown(article, 'j'); });
    expect(article.dataset.targetKey).toBe('matrix:table');
    expect(article.dataset.hudKey).toBe('j');
    expect(article.dataset.hudCommand).toBe('Next block');
    act(() => { keydown(article, 'k'); });
    expect(article.dataset.targetKey).toBe('intro:block');
    expect(article.dataset.hudCommand).toBe('Previous block');
    act(() => { keydown(article, 'G'); });
    expect(article.dataset.targetKey).toBe('code:code');
    expect(article.dataset.hudCommand).toBe('End of document');
    act(() => {
      keydown(article, 'g');
      keydown(article, 'g');
    });
    expect(article.dataset.targetKey).toBe('intro:block');
    expect(article.dataset.hudKey).toBe('gg');
    expect(article.dataset.hudCommand).toBe('Start of document');

    act(() => { keydown(article, 'V'); });
    expect(article.dataset.phase).toBe('visual-block');
    expect(window.getSelection()?.toString()).toContain('Alpha');
    act(() => { keydown(article, 'j'); });
    expect(window.getSelection()?.toString()).toContain('B2');
    expect(article.dataset.hudCommand).toBe('Extend to next block');
    act(() => { keydown(article, 'd'); });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.mode).toBe('redline');
    expect(actions[0]?.text).toContain('Alpha');
    expect(actions[0]?.text).toContain('B2');
    act(() => root.unmount());
  });

  test('moves through semantic siblings before refining or returning to block order', () => {
    const { article, root } = mountHarness({
      enabled: true,
      onRange: () => {},
    });

    act(() => article.focus());
    act(() => { keydown(article, 'j'); });
    expect(article.dataset.targetKey).toBe('matrix:table');
    act(() => { keydown(article, 'l'); });
    expect(article.dataset.targetKey).toBe('matrix:row:0');
    act(() => { keydown(article, 'j'); });
    expect(article.dataset.targetKey).toBe('matrix:row:1');
    act(() => { keydown(article, 'l'); });
    expect(article.dataset.targetKey).toBe('matrix:cell:1:0');
    act(() => { keydown(article, 'j'); });
    expect(article.dataset.targetKey).toBe('matrix:cell:1:1');
    act(() => { keydown(article, 'v'); });
    act(() => { keydown(article, 'w'); });
    expect(window.getSelection()?.toString()).toBe('B2');
    act(() => { keydown(article, 'Escape'); });
    act(() => { keydown(article, 'Escape'); });
    act(() => { keydown(article, 'h'); });
    expect(article.dataset.targetKey).toBe('matrix:row:1');
    act(() => root.unmount());
  });

  test('does not action a collapsed text cursor and does not consume Escape when inactive', () => {
    const actions: string[] = [];
    const { article, root } = mountHarness({
      enabled: true,
      onRange: (text) => actions.push(text),
    });

    act(() => article.focus());
    act(() => { keydown(article, 'l'); });
    act(() => { keydown(article, 'l'); });
    expect(article.dataset.phase).toBe('text');
    const collapsedAction = keydown(article, 'c');
    expect(collapsedAction.defaultPrevented).toBe(false);
    const collapsedCopy = keydown(article, 'y');
    expect(collapsedCopy.defaultPrevented).toBe(false);
    expect(actions).toEqual([]);

    act(() => { keydown(article, 'Escape'); });
    act(() => { keydown(article, 'Escape'); });
    act(() => { keydown(article, 'Escape'); });
    expect(article.dataset.phase).toBe('inactive');
    const inactiveEscape = keydown(article, 'Escape');
    expect(inactiveEscape.defaultPrevented).toBe(false);
    act(() => root.unmount());
  });
});
