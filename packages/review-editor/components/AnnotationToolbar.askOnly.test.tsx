/**
 * The ask-only toolbar (the VS Code Guide tab: selected lines can be asked
 * about, never commented on). It opens on the Ask box with no way to a
 * comment, and closes once the question is sent, since the answer opens
 * somewhere else.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const toolbarModule = hasDom ? await import('./AnnotationToolbar') : null;
const AnnotationToolbar = toolbarModule?.AnnotationToolbar as typeof import('./AnnotationToolbar')['AnnotationToolbar'];

let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mount(askOnly: boolean, calls: { asked: string[]; cancelled: number }): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const toolbarRef = React.createRef<HTMLDivElement>();
  await act(async () => {
    root?.render(
      <AnnotationToolbar
        toolbarState={{ position: { top: 100, left: 300 }, range: { start: 25, end: 31, side: 'additions' } }}
        toolbarRef={toolbarRef}
        commentText=""
        setCommentText={() => {}}
        suggestedCode=""
        setSuggestedCode={() => {}}
        showSuggestedCode={false}
        setShowSuggestedCode={() => {}}
        askAIMode={false}
        setAskAIMode={() => {}}
        setShowCodeModal={() => {}}
        setShowCommentModal={() => {}}
        onSubmit={() => {}}
        onDismiss={() => {}}
        onCancel={() => calls.cancelled++}
        conventionalCommentsEnabled={false}
        conventionalLabel={null}
        onConventionalLabelChange={() => {}}
        decorations={[]}
        onDecorationsChange={() => {}}
        aiAvailable
        onAskAI={(q) => calls.asked.push(q)}
        askOnly={askOnly}
      />,
    );
  });
}

function setTextarea(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe.skipIf(!hasDom)('AnnotationToolbar askOnly', () => {
  test('opens on the Ask box, offers no comment, and closes after asking', async () => {
    const calls = { asked: [] as string[], cancelled: 0 };
    await mount(true, calls);
    const box = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask about this code..."]');
    expect(box).not.toBeNull();
    const buttons = () => Array.from(document.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttons()).not.toContain('Comment');
    await act(async () => setTextarea(box!, 'Why return a value here?'));
    const ask = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Ask')!;
    await act(async () => ask.click());
    expect(calls.asked).toEqual(['Why return a value here?']);
    expect(calls.cancelled).toBe(1);
  });

  test('without askOnly the toolbar opens on the comment composer', async () => {
    const calls = { asked: [] as string[], cancelled: 0 };
    await mount(false, calls);
    expect(document.querySelector('textarea[placeholder="Ask about this code..."]')).toBeNull();
  });
});

const hookModule = hasDom ? await import('../hooks/useAnnotationToolbar') : null;

describe.skipIf(!hasDom)('useAnnotationToolbar askOnly', () => {
  test('a touch screen (or a narrow window) never gets the expanded composer, so outside-click and Escape still close the Ask box', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query === '(pointer: coarse)', media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true })) as typeof window.matchMedia;
    const seen: Array<{ askOnly: boolean; expanded: boolean }> = [];
    function Probe({ askOnly }: { askOnly: boolean }) {
      const t = hookModule!.useAnnotationToolbar({ patch: '', filePath: 'a.ts', isFocused: true, onLineSelection: () => {}, onAddAnnotation: () => {}, onEditAnnotation: () => {}, askOnly });
      seen.push({ askOnly, expanded: t.expandedComposerRequired });
      return null;
    }
    try {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => root?.render(<><Probe askOnly /><Probe askOnly={false} /></>));
      expect(seen.find((s) => s.askOnly)?.expanded).toBe(false);
      expect(seen.find((s) => !s.askOnly)?.expanded).toBe(true);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
