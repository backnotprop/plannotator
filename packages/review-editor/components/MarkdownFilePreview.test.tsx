/**
 * Commenting in a Markdown preview, the PR description's experience: select
 * any rendered text, the composer opens, and the comment becomes a file
 * comment that carries the quote (and, in the rendered diff, the kind of
 * section it was in). The same comment shows in the other view by its text,
 * and says so when its text is not there. Mermaid fences render as diagrams.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useMemo, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation, MarkdownPreviewAnchor } from '@plannotator/ui/types';
import type { ReviewState } from '../dock/ReviewStateContext';
import type { MarkdownPreviewView } from '../hooks/useMarkdownPreview';

const hasDom = typeof document !== 'undefined';

// The highlighter reads `window` at import; load the preview lazily.
const { MarkdownFilePreview } = hasDom ? await import('./MarkdownFilePreview') : ({} as typeof import('./MarkdownFilePreview'));
const { ReviewStateProvider } = await import('../dock/ReviewStateContext');

const OLD = '# Guide\n\nRun the old installer.\n\n## Keep\n\nThis stays the same.\n';
const NEW = '# Guide\n\nRun the new installer from the website.\n\n## Keep\n\nThis stays the same.\n';
const PATCH = [
  'diff --git a/docs/guide.md b/docs/guide.md',
  '--- a/docs/guide.md',
  '+++ b/docs/guide.md',
  '@@ -1,7 +1,7 @@',
  ' # Guide',
  ' ',
  '-Run the old installer.',
  '+Run the new installer from the website.',
  ' ',
  ' ## Keep',
  ' ',
  ' This stays the same.',
  '',
].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;
let added: Array<{ filePath: string; text: string; anchor: MarkdownPreviewAnchor }> = [];
let setViewFromTest: ((view: MarkdownPreviewView) => void) | null = null;

function Harness({ initial = [], oldText = OLD, newText = NEW, patch = PATCH }: {
  initial?: CodeAnnotation[];
  oldText?: string;
  newText?: string;
  patch?: string;
}) {
  const [annotations, setAnnotations] = useState<CodeAnnotation[]>(initial);
  const [view, setView] = useState<MarkdownPreviewView>('diff');
  setViewFromTest = setView;
  const state = useMemo(() => ({
    files: [],
    allAnnotations: annotations,
    selectedAnnotationId: null,
    onSelectAnnotation: () => {},
    snapshotId: 'snap-1',
    imagePreviewAvailable: true,
    openDiffFile: () => {},
    markdownPreview: { view, setView } as unknown as ReviewState['markdownPreview'],
    onAddMarkdownPreviewComment: (filePath: string, comment: { id: string; text: string; anchor: MarkdownPreviewAnchor }) => {
      added.push({ filePath, text: comment.text, anchor: comment.anchor });
      setAnnotations((current) => [...current, {
        id: comment.id, type: 'comment', scope: 'file', filePath, lineStart: 1, lineEnd: 1, side: 'new',
        text: comment.text, markdownPreview: comment.anchor, createdAt: 1,
      }]);
    },
  }) as unknown as ReviewState, [annotations, view]);
  return (
    <ReviewStateProvider value={state}>
      <MarkdownFilePreview
        filePath="docs/guide.md"
        status="modified"
        patch={patch}
        contents={{ fileContents: { forPath: 'docs/guide.md', old: oldText, new: newText }, loading: false, stale: false }}
        variant="single"
      />
    </ReviewStateProvider>
  );
}

async function mount(props: React.ComponentProps<typeof Harness> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness {...props} />);
    await new Promise((r) => setTimeout(r, 30));
  });
  return host;
}

async function settle(ms = 30) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

/** Select `text` inside the first element whose own text contains it, then release the pointer. */
async function selectText(container: HTMLElement, text: string) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const index = node.data.indexOf(text);
    if (index === -1) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + text.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      node!.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 30));
    });
    return;
  }
  throw new Error(`"${text}" is not in the preview`);
}

async function typeAndSave(text: string) {
  const textarea = document.body.querySelector('textarea')!;
  expect(textarea).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
  });
}

const marksText = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-markdown-preview] mark')).map((m) => m.textContent).join('');

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  added = [];
  setViewFromTest = null;
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe.if(hasDom)('commenting in a Markdown preview', () => {
  test('selecting text in the rendered diff opens the composer; the comment quotes it', async () => {
    const el = await mount();
    expect(el.querySelector('[data-markdown-preview-view="diff"]')).not.toBeNull();
    await selectText(el, 'new installer');
    await typeAndSave('Link the installer page.');

    expect(added).toHaveLength(1);
    expect(added[0].filePath).toBe('docs/guide.md');
    expect(added[0].text).toBe('Link the installer page.');
    expect(added[0].anchor.originalText).toBe('new installer');
    expect(added[0].anchor.view).toBe('diff');
    expect(added[0].anchor.diffContext).toBe('modified');
    await settle();
    expect(marksText(el)).toBe('new installer');
  });

  test('a comment made in one view is found in the other by its text', async () => {
    const el = await mount();
    await selectText(el, 'stays the same');
    await typeAndSave('Fine.');
    expect(added[0].anchor.diffContext).toBe('unchanged');

    await act(async () => setViewFromTest!('whole'));
    await settle(60);
    expect(el.querySelector('[data-markdown-preview-view="whole"]')).not.toBeNull();
    expect(marksText(el)).toBe('stays the same');
    expect(el.querySelector('[data-markdown-preview-unanchored]')).toBeNull();
  });

  test('a comment on removed text says it is not in the whole new version', async () => {
    const el = await mount();
    await selectText(el, 'old installer');
    await typeAndSave('Why drop this?');
    // The old half of a changed section is removed text.
    expect(added[0].anchor.diffContext).toBe('removed');

    await act(async () => setViewFromTest!('whole'));
    await settle(60);
    expect(marksText(el)).toBe('');
    const note = el.querySelector('[data-markdown-preview-unanchored]');
    expect(note?.textContent).toContain('1 comment on this file is not in this view');
  });

  test('Mermaid fences render through the diagram engine', async () => {
    const withDiagram = `${NEW}\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`;
    const patch = [
      'diff --git a/docs/guide.md b/docs/guide.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/docs/guide.md',
      `@@ -0,0 +1,${withDiagram.split('\n').length - 1} @@`,
      ...withDiagram.split('\n').slice(0, -1).map((line) => `+${line}`),
      '',
    ].join('\n');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ReviewStateProvider value={{ files: [], allAnnotations: [], selectedAnnotationId: null } as unknown as ReviewState}>
          <MarkdownFilePreview
            filePath="docs/guide.md"
            status="added"
            patch={patch}
            contents={{ fileContents: { forPath: 'docs/guide.md', old: null, new: withDiagram }, loading: false, stale: false }}
            variant="single"
          />
        </ReviewStateProvider>,
      );
      await new Promise((r) => setTimeout(r, 30));
    });
    for (let i = 0; i < 100 && !host.querySelector('[data-diagram-block]'); i++) await settle(20);
    expect(host.querySelector('[data-diagram-block]')).not.toBeNull();
  });
});
