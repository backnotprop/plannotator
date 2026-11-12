import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationToolbar } from './AnnotationToolbar';
import { useAnnotationModeShortcuts } from '../shortcuts/plan-review/annotationMode.shortcuts';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
let anchor: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  anchor?.remove();
  anchor = null;
  if (hasDom) document.body.replaceChildren();
});

function ModeShortcutHost({ onMode }: { onMode: (mode: string) => void }) {
  useAnnotationModeShortcuts({
    handlers: {
      selectMarkupMode: () => onMode('selection'),
      selectCommentMode: () => onMode('comment'),
      selectRedlineMode: () => onMode('redline'),
      selectQuickLabelMode: () => onMode('quickLabel'),
    },
  });
  return null;
}

function pressShiftDigit(digit: number, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    code: `Digit${digit}`,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(ui);
  });
}

describe.if(hasDom)('annotation-mode shortcuts vs type-to-comment', () => {
  test('with no toolbar open, Shift+3 switches to redline', async () => {
    const modes: string[] = [];
    await mount(<ModeShortcutHost onMode={(m) => modes.push(m)} />);
    await act(async () => {
      pressShiftDigit(3, '#');
    });
    expect(modes).toEqual(['redline']);
  });

  test('with the toolbar open, typing "!" starts a comment and does NOT switch mode', async () => {
    const modes: string[] = [];
    const commentChars: Array<string | undefined> = [];
    anchor = document.createElement('p');
    anchor.textContent = 'annotated paragraph';
    document.body.appendChild(anchor);
    await mount(
      <>
        <ModeShortcutHost onMode={(m) => modes.push(m)} />
        <AnnotationToolbar
          element={anchor}
          positionMode="center-above"
          onAnnotate={() => {}}
          onClose={() => {}}
          onRequestComment={(initialChar) => commentChars.push(initialChar)}
        />
      </>,
    );
    expect(document.querySelector('.annotation-toolbar')).not.toBeNull();
    await act(async () => {
      pressShiftDigit(1, '!');
    });
    expect(commentChars).toEqual(['!']);
    expect(modes).toEqual([]);
  });

  test('closing the toolbar releases the capture: the shortcut works again', async () => {
    const modes: string[] = [];
    anchor = document.createElement('p');
    anchor.textContent = 'annotated paragraph';
    document.body.appendChild(anchor);
    const withToolbar = (
      <>
        <ModeShortcutHost onMode={(m) => modes.push(m)} />
        <AnnotationToolbar
          element={anchor}
          positionMode="center-above"
          onAnnotate={() => {}}
          onClose={() => {}}
          onRequestComment={() => {}}
        />
      </>
    );
    await mount(withToolbar);
    await act(async () => {
      pressShiftDigit(2, '@');
    });
    expect(modes).toEqual([]);
    await act(async () => {
      root?.render(<ModeShortcutHost onMode={(m) => modes.push(m)} />);
    });
    await act(async () => {
      pressShiftDigit(2, '@');
    });
    expect(modes).toEqual(['comment']);
  });
});
