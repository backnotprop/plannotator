/**
 * Consumer-surface contract for Viewer's host props:
 *   - readOnly suppresses the composer entry points (global-comment button,
 *     attachments) while the document still renders
 *   - allowImages threads to CommentPopover, which hides its attach affordance
 * Defaults preserve today's behavior (composer on, images on).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { AnnotationType, type Block } from '../types';

// CI uses this consumer contract as the entry point for the scoped DOM suite.
// Keep the adjacent public theme/menu contracts in that same DOM run without
// requiring workflow-only test-path maintenance.
import './ActionMenu.test';
import './DocBadges.test';
import './ThemeProvider.test';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in @plannotator/web-highlighter, whose UMD bundle reads
// `window` at module-eval time and throws under the default DOM-less
// `bun test`. Import lazily so this file loads cleanly when DOM tests are
// skipped; DOM_TESTS=1 supplies a real DOM and the real modules.
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];
const popoverMod = hasDom ? await import('./CommentPopover') : null;
const CommentPopover =
  popoverMod?.CommentPopover as typeof import('./CommentPopover')['CommentPopover'];

const blocks: Block[] = [
  { id: 'b1', type: 'paragraph', content: 'hello world', order: 0, startLine: 1 },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(ui);
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

const viewerProps = {
  blocks,
  markdown: 'hello world',
  annotations: [],
  onAddAnnotation: () => {},
  onSelectAnnotation: () => {},
  selectedAnnotationId: null,
  mode: 'comment' as const,
  taterMode: false,
  // Host posture: no /api/doc/exists endpoint.
  disableCodePathValidation: true,
};

function globalCommentButton(): Element | null {
  return document.querySelector('button[title="Add global comment"]');
}

describe('Viewer consumer props', () => {
  test.skipIf(!hasDom)('default renders the global-comment composer entry (today’s behavior)', async () => {
    await mount(
      <Viewer
        {...viewerProps}
        onAddGlobalAttachment={() => {}}
        onRemoveGlobalAttachment={() => {}}
      />,
    );
    expect(globalCommentButton()).not.toBeNull();
    expect(document.querySelector('button[title="Attachments"]')).not.toBeNull();
    expect(document.body.textContent).toContain('hello world');
  });

  test.skipIf(!hasDom)('readOnly hides composer entry points but still renders the document', async () => {
    await mount(
      <Viewer
        {...viewerProps}
        readOnly
        onAddGlobalAttachment={() => {}}
        onRemoveGlobalAttachment={() => {}}
      />,
    );
    expect(globalCommentButton()).toBeNull();
    expect(document.querySelector('button[title="Attachments"]')).toBeNull();
    expect(document.body.textContent).toContain('hello world');
  });
});

describe('CommentPopover allowImages', () => {
  function makeAnchor(): HTMLElement {
    const el = document.createElement('span');
    el.textContent = 'anchor';
    document.body.appendChild(el);
    return el;
  }
  const popoverProps = {
    contextText: 'ctx',
    isGlobal: true,
    onSubmit: () => {},
    onClose: () => {},
  };

  test.skipIf(!hasDom)('default shows the attach affordance', async () => {
    await mount(<CommentPopover {...popoverProps} anchorEl={makeAnchor()} />);
    expect(document.querySelector('button[title="Attachments"]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('allowImages={false} hides the attach affordance', async () => {
    await mount(<CommentPopover {...popoverProps} anchorEl={makeAnchor()} allowImages={false} />);
    expect(document.querySelector('button[title="Attachments"]')).toBeNull();
  });

  test.skipIf(!hasDom)('submit with allowImages={false} never reports images', async () => {
    const submitted: Array<unknown> = [];
    await mount(
      <CommentPopover
        {...popoverProps}
        anchorEl={makeAnchor()}
        allowImages={false}
        onSubmit={(text, images) => submitted.push({ text, images })}
      />,
    );
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const proto = Object.getPrototypeOf(textarea);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(textarea, 'a comment');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
      );
    });
    expect(submitted).toEqual([{ text: 'a comment', images: undefined }]);
  });
});

// Keep the import shape honest: AnnotationType is part of the tested surface.
void AnnotationType;
