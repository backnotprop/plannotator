import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationToolbar } from './AnnotationToolbar';

/**
 * The commentOnly seam (DOM-gated): HTML and live-app surfaces present a
 * comment-only selection toolbar (no Delete, no quick labels), while the
 * markdown surface keeps the full toolbar. This guards the seam in BOTH
 * directions — dropping the prop would resurrect Delete on HTML surfaces,
 * and inverting it would strip Delete from markdown.
 */

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

async function mount(props: { commentOnly?: boolean; withQuickLabels?: boolean }) {
  anchor = document.createElement('p');
  anchor.textContent = 'annotated paragraph';
  document.body.appendChild(anchor);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AnnotationToolbar
        element={anchor!}
        positionMode="center-above"
        onAnnotate={() => {}}
        onClose={() => {}}
        onRequestComment={() => {}}
        onQuickLabel={props.withQuickLabels ? () => {} : undefined}
        commentOnly={props.commentOnly}
      />,
    );
  });
  const toolbar = document.querySelector<HTMLElement>('.annotation-toolbar');
  if (!toolbar) throw new Error('annotation toolbar did not render');
  return Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button')).map((b) => b.title);
}

describe.if(hasDom)('AnnotationToolbar commentOnly seam', () => {
  test('commentOnly without a label handler hides Delete and every label affordance', async () => {
    const titles = await mount({ commentOnly: true });
    expect(titles).toContain('Comment');
    expect(titles).not.toContain('Delete');
    expect(titles).not.toContain('Quick label');
    expect(titles).not.toContain('Looks good');
  });

  test('commentOnly with a label handler restores ONLY the thumbs-up (no Delete, no picker)', async () => {
    // The restricted restore: HTML/live surfaces get exactly one label
    // affordance back. A regression that also renders the Zap picker (or
    // Delete) re-opens the comment-only ruling this seam enforces.
    const titles = await mount({ commentOnly: true, withQuickLabels: true });
    expect(titles).toContain('Comment');
    expect(titles).toContain('Looks good');
    expect(titles).not.toContain('Delete');
    expect(titles).not.toContain('Quick label');
  });

  test('the default (markdown surface) toolbar keeps Delete and quick labels', async () => {
    const titles = await mount({ withQuickLabels: true });
    expect(titles).toContain('Delete');
    expect(titles).toContain('Comment');
    expect(titles).toContain('Quick label');
    expect(titles).toContain('Looks good');
  });
});
