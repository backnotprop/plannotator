/**
 * Commenting in a Markdown preview, the PR description's experience: select
 * any rendered text, the composer opens, and the comment becomes a file
 * comment that carries the quote (and, in the rendered diff, the kind of
 * section it was in). The same comment shows in the other view by its text,
 * and says so when its text is not there. Mermaid and Graphviz fences render
 * as code (the review bundle carries no diagram engine).
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
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
    // The file's view comes from review state (All files); the "not in this
    // view" action shows the other one on this file only.
    markdownPreview: {
      viewOf: () => (view === 'whole' ? 'read' : 'changes'),
      show: (_path: string, next: string) => setView(next === 'read' ? 'whole' : 'diff'),
    } as unknown as ReviewState['markdownPreview'],
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

    // Its action shows the view the comment is in.
    await act(async () => note!.querySelector<HTMLButtonElement>('[data-markdown-preview-show-view]')!.click());
    await settle(60);
    expect(el.querySelector('[data-markdown-preview-view="diff"]')).not.toBeNull();
    expect(marksText(el)).toBe('old installer');
  });

  /** An added Markdown file, previewed whole, under the given review state. */
  async function mountAdded(text: string, stateExtras: Record<string, unknown> = {}) {
    const patch = [
      'diff --git a/docs/guide.md b/docs/guide.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/docs/guide.md',
      `@@ -0,0 +1,${text.split('\n').length - 1} @@`,
      ...text.split('\n').slice(0, -1).map((line) => `+${line}`),
      '',
    ].join('\n');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ReviewStateProvider value={{ files: [], allAnnotations: [], selectedAnnotationId: null, snapshotId: 'snap-1', imagePreviewAvailable: true, ...stateExtras } as unknown as ReviewState}>
          <MarkdownFilePreview
            filePath="docs/guide.md"
            status="added"
            patch={patch}
            contents={{ fileContents: { forPath: 'docs/guide.md', old: null, new: text }, loading: false, stale: false }}
            variant="single"
          />
        </ReviewStateProvider>,
      );
      await new Promise((r) => setTimeout(r, 30));
    });
    return host;
  }

  const REMOTE_DOC = [
    '# Shots',
    '',
    '![pixel](https://tracker.example/p.png)',
    '',
    '<p><img alt="badge" src="//cdn.example/b.svg"></p>',
    '',
    '![local](img/a.png)',
    '',
  ].join('\n');
  // happy-dom fires `error` at once for an <img> whose relative src it cannot
  // parse against about:blank; give the page the http origin the review app has.
  type HappyWindow = { happyDOM?: { setURL?: (url: string) => void } };
  let originalUrl = '';
  beforeAll(() => {
    originalUrl = window.location.href;
    (window as unknown as HappyWindow).happyDOM?.setURL?.('http://localhost:19611/');
  });
  afterAll(() => {
    (window as unknown as HappyWindow).happyDOM?.setURL?.(originalUrl);
  });
  const imgSrcs = (el: HTMLElement) => Array.from(el.querySelectorAll('img')).map((img) => img.getAttribute('src'));

  test('in a PR review, remote images wait behind a placeholder until the reviewer loads them', async () => {
    const el = await mountAdded(REMOTE_DOC, { prMetadata: { url: 'https://github.com/o/r/pull/1' } });
    await settle(30);
    // Nothing remote is in the page; the repository image still loads through the review route.
    expect(imgSrcs(el)).toEqual(['/api/review-markdown-image?doc=docs%2Fguide.md&side=new&src=img%2Fa.png&snapshot=snap-1']);
    const notice = el.querySelector('[data-markdown-preview-remote-images]');
    expect(notice?.textContent).toContain('2 remote images are not loaded');

    // A click on a placeholder loads them.
    const placeholder = el.querySelector('[data-image-unavailable]') as HTMLElement;
    await act(async () => { placeholder.click(); await new Promise((r) => setTimeout(r, 30)); });
    await settle(30);
    expect(imgSrcs(el).sort()).toEqual([
      '//cdn.example/b.svg',
      '/api/review-markdown-image?doc=docs%2Fguide.md&side=new&src=img%2Fa.png&snapshot=snap-1',
      'https://tracker.example/p.png',
    ]);
    expect(el.querySelector('[data-markdown-preview-remote-images]')).toBeNull();
  });

  test('slash-less, single-slash and backslash remote sources are held and counted too', async () => {
    // A browser reads each of these as https://tracker.example/…; a check for
    // `//` alone let them load at once.
    const doc = [
      '<p><img alt="noslash" src="https:tracker.example/a.png"></p>',
      '',
      '<p><img alt="oneslash" src="https:/tracker.example/b.png"></p>',
      '',
      '<p><img alt="backslash" src="https:\\\\tracker.example\\c.png"></p>',
      '',
      '<p><img alt="unc" src="\\\\tracker.example\\d.png"></p>',
      '',
      '![local](img/a.png)',
      '',
    ].join('\n');
    const el = await mountAdded(doc, { prMetadata: { url: 'https://github.com/o/r/pull/1' } });
    await settle(30);
    expect(imgSrcs(el)).toEqual(['/api/review-markdown-image?doc=docs%2Fguide.md&side=new&src=img%2Fa.png&snapshot=snap-1']);
    expect(el.querySelector('[data-markdown-preview-remote-images]')?.textContent).toContain('4 remote images are not loaded');
  });

  test('the notice button loads held remote images too', async () => {
    const el = await mountAdded(REMOTE_DOC, { prMetadata: { url: 'https://github.com/o/r/pull/1' } });
    await settle(30);
    const button = el.querySelector('[data-markdown-preview-load-remote]') as HTMLButtonElement;
    await act(async () => { button.click(); await new Promise((r) => setTimeout(r, 30)); });
    await settle(30);
    expect(imgSrcs(el)).toContain('https://tracker.example/p.png');
  });

  test('outside a PR review remote images load as written', async () => {
    const el = await mountAdded(REMOTE_DOC);
    await settle(30);
    expect(imgSrcs(el)).toContain('https://tracker.example/p.png');
    expect(el.querySelector('[data-markdown-preview-remote-images]')).toBeNull();
  });

  test('an image source is sent to the route as written, never trimmed', async () => {
    const el = await mountAdded('<p><img alt="x" src=" img/a.png"></p>\n');
    await settle(30);
    expect(imgSrcs(el)).toEqual(['/api/review-markdown-image?doc=docs%2Fguide.md&side=new&src=+img%2Fa.png&snapshot=snap-1']);
  });

  test('Mermaid and Graphviz fences render as code, not diagrams', async () => {
    const withDiagram = `${NEW}\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n\n\`\`\`dot\ndigraph { a -> b }\n\`\`\`\n`;
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
    await settle(60);
    expect(host.querySelector('[data-diagram-block]')).toBeNull();
    const fences = Array.from(host.querySelectorAll('pre > code')).map((code) => code.textContent);
    expect(fences).toEqual(['flowchart LR\n  A --> B', 'digraph { a -> b }']);
  });
});
