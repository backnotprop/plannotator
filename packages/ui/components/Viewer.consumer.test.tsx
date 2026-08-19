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
const htmlViewerMod = hasDom ? await import('./html-viewer/HtmlViewer') : null;
const HtmlViewer =
  htmlViewerMod?.HtmlViewer as typeof import('./html-viewer/HtmlViewer')['HtmlViewer'];

const blocks: Block[] = [
  { id: 'b1', type: 'paragraph', content: 'hello world', order: 0, startLine: 1 },
];

const fencedCodeBlocks: Block[] = [
  {
    id: 'code-1',
    type: 'code',
    content: 'const archived = true;',
    language: 'typescript',
    order: 0,
    startLine: 1,
  },
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

  test.skipIf(!hasDom)('readOnly fenced code never opens composers or mutates the rendered code', async () => {
    const additions: unknown[] = [];
    await mount(
      <Viewer
        {...viewerProps}
        blocks={fencedCodeBlocks}
        markdown={'```typescript\nconst archived = true;\n```'}
        readOnly
        onAddAnnotation={(annotation) => additions.push(annotation)}
      />,
    );

    const codeBlock = document.querySelector<HTMLElement>('[data-block-id="code-1"]');
    const code = codeBlock?.querySelector('code');
    if (!codeBlock || !code) throw new Error('Fenced code block did not render');
    const renderedCode = code.innerHTML;

    await act(async () => {
      codeBlock.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      codeBlock.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('.annotation-toolbar')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[data-quick-label-picker]')).toBeNull();
    expect(code.querySelector('mark')).toBeNull();
    expect(code.innerHTML).toBe(renderedCode);
    expect(additions).toEqual([]);

    for (const mode of ['comment', 'redline', 'quickLabel'] as const) {
      await act(async () => {
        root?.render(
          <Viewer
            {...viewerProps}
            blocks={fencedCodeBlocks}
            markdown={'```typescript\nconst archived = true;\n```'}
            inputMethod="pinpoint"
            mode={mode}
            readOnly
            onAddAnnotation={(annotation) => additions.push(annotation)}
          />,
        );
      });
      await act(async () => {
        codeBlock.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(document.querySelector('textarea')).toBeNull();
      expect(document.querySelector('[data-quick-label-picker]')).toBeNull();
      expect(code.querySelector('mark')).toBeNull();
      expect(code.innerHTML).toBe(renderedCode);
      expect(additions).toEqual([]);
    }
  });
});

describe('HtmlViewer consumer props', () => {
  const htmlViewerProps = {
    rawHtml: '<html><body><p>raw document</p></body></html>',
    annotations: [],
    onAddAnnotation: () => {},
    onSelectAnnotation: () => {},
    selectedAnnotationId: null,
    mode: 'comment' as const,
    inputMethod: 'drag' as const,
    onAddGlobalAttachment: () => {},
    onRemoveGlobalAttachment: () => {},
  };

  function dispatchSelection(modeOverride?: 'redline'): void {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      data: {
        type: 'plannotator-bridge-selection',
        text: 'raw document',
        rect: { top: 10, left: 10, width: 100, height: 20 },
        modeOverride,
      },
    }));
  }

  test.skipIf(!hasDom)('default remains writable for raw-HTML annotate surfaces', async () => {
    await mount(<HtmlViewer {...htmlViewerProps} />);
    expect(globalCommentButton()).not.toBeNull();
    expect(document.querySelector('button[title="Attachments"]')).not.toBeNull();

    await act(async () => dispatchSelection());
    expect(document.querySelector('textarea')).not.toBeNull();
  });

  test.skipIf(!hasDom)('readOnly hides raw-HTML mutation controls and ignores selection composers', async () => {
    const additions: unknown[] = [];
    await mount(
      <HtmlViewer
        {...htmlViewerProps}
        readOnly
        onAddAnnotation={(annotation) => additions.push(annotation)}
      />,
    );
    expect(globalCommentButton()).toBeNull();
    expect(document.querySelector('button[title="Attachments"]')).toBeNull();

    await act(async () => dispatchSelection());
    expect(document.querySelector('textarea')).toBeNull();
    await act(async () => dispatchSelection('redline'));
    expect(additions).toEqual([]);
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
