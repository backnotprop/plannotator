/**
 * The single-file Markdown preview in code review: links never navigate the
 * review tab, the header Comment button works in the preview, navigation that
 * targets diff lines switches back to the diff, a deletion previews the old
 * document, images resolve against the file's own folder (or show a
 * placeholder when the server reads no images for the review), and the
 * Source / Changes / Read menu appears only where a rendered view can work.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run diff-renderer DOM tests" step (real @pierre/diffs).
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation, SelectedLineRange } from '@plannotator/ui/types';
import { setExtraMarkdownExtensions } from '@plannotator/ui/utils/markdownExtensions';
import { markdownPreviewImageUrl } from '../utils/markdownPreview';

const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  buildLineBgOverrides: () => '',
  resolveSyntaxTheme: realResolveSyntaxTheme,
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost() {
    return null;
  }),
}));

const { DiffViewer } = await import('./DiffViewer');

const hasDom = typeof document !== 'undefined';

const TOGGLE = '[data-markdown-view-menu]';
const PREVIEW = '[data-markdown-preview]';

function contentLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function addedPatch(path: string, content: string): string {
  const lines = contentLines(content);
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function deletedPatch(path: string, content: string): string {
  const lines = contentLines(content);
  return [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    'index 1111111..0000000',
    `--- a/${path}`,
    '+++ /dev/null',
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((line) => `-${line}`),
    '',
  ].join('\n');
}

type Contents = { oldContent: string | null; newContent: string | null };
type ViewProps = Partial<React.ComponentProps<typeof DiffViewer>>;

describe.if(hasDom)('Markdown preview (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;

  // happy-dom fires `error` at once for an <img> whose relative src it cannot
  // parse against about:blank; give the page an http origin, as the review
  // app has, so only the error events a test dispatches count. (Image loading
  // itself stays off in happy-dom.)
  type HappyWindow = { happyDOM?: { setURL?: (url: string) => void } };
  let originalUrl = '';
  beforeAll(() => {
    originalUrl = window.location.href;
    (window as unknown as HappyWindow).happyDOM?.setURL?.('http://localhost:19611/');
  });
  afterAll(() => {
    (window as unknown as HappyWindow).happyDOM?.setURL?.(originalUrl);
  });

  function view(props: ViewProps) {
    return (
      <DiffViewer
        patch=""
        filePath="README.md"
        diffStyle="unified"
        annotations={[]}
        selectedAnnotationId={null}
        scrollTargetAnnotation={null}
        pendingSelection={null}
        onLineSelection={() => {}}
        onAddAnnotation={() => {}}
        onAddFileComment={() => {}}
        onEditAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
        {...props}
      />
    );
  }

  async function render(props: ViewProps, contents: Contents | 'fail' | 'stale-snapshot') {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/file-content') && contents === 'stale-snapshot') {
        return new Response(JSON.stringify({ error: 'Diff snapshot is stale' }), { status: 409 });
      }
      if (url.startsWith('/api/file-content') && contents !== 'fail') {
        return new Response(JSON.stringify(contents), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(view(props));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    return host;
  }

  async function rerender(props: ViewProps) {
    await act(async () => {
      root!.render(view(props));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  function isPreviewOn(el: HTMLElement): boolean {
    const view = el.querySelector(TOGGLE)?.getAttribute('data-markdown-view');
    return view != null && view !== 'source';
  }

  // Source <-> rendered (Changes, or Read where a file has no Changes).
  // Turning a rendered view on waits for its (lazily loaded) view to mount.
  async function togglePreview(el: HTMLElement) {
    const on = isPreviewOn(el);
    await act(async () => {
      el.querySelector<HTMLButtonElement>(TOGGLE)!.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const target = on
      ? 'source'
      : document.querySelector('[data-markdown-view-option="changes"]') ? 'changes' : 'read';
    await act(async () => {
      document.querySelector<HTMLElement>(`[data-markdown-view-option="${target}"]`)!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (on) return;
    const start = Date.now();
    while (el.querySelector('[data-markdown-preview-view="pending"]') || !el.querySelector(PREVIEW)) {
      if (Date.now() - start > 3000) throw new Error('the preview did not mount');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }

  const imageUrl = (doc: string, src: string, side: 'old' | 'new' = 'new') =>
    markdownPreviewImageUrl({ doc, side, src, snapshot: 'snap-1' });

  function click(target: Element): MouseEvent {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function linkByText(el: HTMLElement, text: string): HTMLAnchorElement | undefined {
    return Array.from(el.querySelectorAll<HTMLAnchorElement>('a')).find((a) => a.textContent?.trim() === text);
  }

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    document.body.innerHTML = '';
    globalThis.fetch = originalFetch;
    setExtraMarkdownExtensions([]);
  });

  const LINKS_DOC = [
    '# Guide',
    '',
    'See [the setup](setup.md), [outside](../outside.md), [web](https://example.com) and [section](#install).',
    '',
    '<p><a href="setup.md">raw setup</a> <a href="nope.md">raw nope</a></p>',
    '',
  ].join('\n');

  test('links never navigate the tab: review files open in the review, other local links are inert', async () => {
    const opened: string[] = [];
    const el = await render({
      patch: addedPatch('docs/README.md', LINKS_DOC),
      filePath: 'docs/README.md',
      status: 'added',
      reviewFilePaths: new Set(['docs/README.md', 'docs/setup.md']),
      onOpenReviewFile: (path) => opened.push(path),
    }, { oldContent: null, newContent: LINKS_DOC });
    await togglePreview(el);
    expect(el.querySelector(PREVIEW)).not.toBeNull();

    // A file in this review opens in the review; the click never navigates.
    const setup = linkByText(el, 'the setup')!;
    expect(click(setup).defaultPrevented).toBe(true);
    expect(opened).toEqual(['docs/setup.md']);

    // Any other local path renders inert: no href, nothing to follow.
    const outside = Array.from(el.querySelectorAll('[data-local-link="unavailable"]'))
      .find((node) => node.textContent === 'outside');
    expect(outside).toBeDefined();
    expect(outside!.getAttribute('title')).toBe('Not in this review');
    expect(linkByText(el, 'outside')).toBeUndefined();

    // External links open a new tab, never this one.
    const web = linkByText(el, 'web')!;
    expect(web.getAttribute('target')).toBe('_blank');
    expect(web.getAttribute('rel')).toContain('noopener');

    // An in-page anchor does not change the review tab's location.
    expect(click(linkByText(el, 'section')!).defaultPrevented).toBe(true);

    // Raw HTML links follow the same rule.
    expect(click(linkByText(el, 'raw setup')!).defaultPrevented).toBe(true);
    expect(opened).toEqual(['docs/setup.md', 'docs/setup.md']);
    const rawNope = Array.from(el.querySelectorAll('a')).find((a) => a.textContent === 'raw nope')!;
    expect(rawNope.hasAttribute('href')).toBe(false);
  });

  test('the header Comment button opens the file composer while the preview shows', async () => {
    const doc = '# Notes\n';
    const comments: string[] = [];
    const el = await render({
      patch: addedPatch('notes.md', doc),
      filePath: 'notes.md',
      status: 'added',
      onAddFileComment: (text) => comments.push(text),
    }, { oldContent: null, newContent: doc });
    await togglePreview(el);
    expect(isPreviewOn(el)).toBe(true);

    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[title="Add file-scoped comment"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.body.querySelector('textarea')).not.toBeNull();
    expect(isPreviewOn(el)).toBe(true);
  });

  test('navigation that targets diff lines switches the file back to the diff', async () => {
    const doc = '# Title\n\nBody\n';
    const lineComment: CodeAnnotation = {
      id: 'line-1', type: 'comment', scope: 'line', filePath: 'doc.md',
      lineStart: 1, lineEnd: 1, side: 'new', text: 'on a line', createdAt: 1,
    } as CodeAnnotation;
    const fileComment: CodeAnnotation = {
      id: 'file-1', type: 'comment', scope: 'file', filePath: 'doc.md',
      lineStart: 0, lineEnd: 0, side: 'new', text: 'on the file', createdAt: 1,
    } as CodeAnnotation;
    const base: ViewProps = {
      patch: addedPatch('doc.md', doc),
      filePath: 'doc.md',
      status: 'added',
      isFocused: true,
      annotations: [lineComment, fileComment],
    };
    const el = await render(base, { oldContent: null, newContent: doc });

    // A sidebar jump to a FILE comment stays in the preview (its banner shows there).
    await togglePreview(el);
    await rerender({ ...base, scrollTargetAnnotation: { id: 'file-1', token: 1 } });
    expect(isPreviewOn(el)).toBe(true);

    // A sidebar jump to a LINE comment switches back.
    await rerender({ ...base, scrollTargetAnnotation: { id: 'line-1', token: 2 } });
    expect(isPreviewOn(el)).toBe(false);

    // A search hit in this file switches back.
    await togglePreview(el);
    expect(isPreviewOn(el)).toBe(true);
    await rerender({
      ...base,
      scrollTargetAnnotation: { id: 'line-1', token: 2 },
      activeSearchMatch: { id: 'm1', filePath: 'doc.md', side: 'new', lineNumber: 3, text: 'Body', matchStart: 0, matchEnd: 4 } as never,
    });
    expect(isPreviewOn(el)).toBe(false);

    // A semantic-diff / AI scroll-to-lines (a new selection) switches back.
    await togglePreview(el);
    expect(isPreviewOn(el)).toBe(true);
    const range: SelectedLineRange = { start: 1, end: 1, side: 'additions' };
    await rerender({
      ...base,
      scrollTargetAnnotation: { id: 'line-1', token: 2 },
      activeSearchMatch: { id: 'm1', filePath: 'doc.md', side: 'new', lineNumber: 3, text: 'Body', matchStart: 0, matchEnd: 4 } as never,
      pendingSelection: range,
    });
    expect(isPreviewOn(el)).toBe(false);
  });

  test('turning the preview on drops a live line selection instead of bouncing back', async () => {
    const doc = '# Title\n';
    const selections: Array<SelectedLineRange | null> = [];
    const el = await render({
      patch: addedPatch('doc.md', doc),
      filePath: 'doc.md',
      status: 'added',
      isFocused: true,
      pendingSelection: { start: 1, end: 1, side: 'additions' },
      onLineSelection: (range) => selections.push(range),
    }, { oldContent: null, newContent: doc });
    await togglePreview(el);
    expect(selections).toContain(null);
    expect(isPreviewOn(el)).toBe(true);
  });

  test('a deleted file previews the old document, its images read from the old side', async () => {
    const doc = '# Retired guide\n\n![diagram](img/flow.png)\n';
    const el = await render({
      patch: deletedPatch('docs/old.md', doc),
      filePath: 'docs/old.md',
      status: 'deleted',
      imagePreviewAvailable: true,
      imageSnapshotId: 'snap-1',
    }, { oldContent: doc, newContent: null });
    await togglePreview(el);
    expect(el.querySelector(`${PREVIEW} h1`)?.textContent).toBe('Retired guide');
    expect(el.querySelector(`${PREVIEW} img[alt="diagram"]`)?.getAttribute('src'))
      .toBe(imageUrl('docs/old.md', 'img/flow.png', 'old'));
  });

  test('stale or missing full contents say so instead of rendering', async () => {
    const doc = '# Fresh\n';
    // Edited on disk since the diff was captured, to the same length: the
    // line-count guard used for hunk expansion cannot see it; the preview must.
    const stale = await render({
      patch: addedPatch('doc.md', doc), filePath: 'doc.md', status: 'added',
    }, { oldContent: null, newContent: '# Edited since the diff\n' });
    await togglePreview(stale);
    expect(stale.querySelector(`${PREVIEW} h1`)).toBeNull();
    expect(stale.querySelector('[data-markdown-preview-state]')?.getAttribute('data-markdown-preview-state')).toBe('stale');
    await act(async () => root!.unmount());
    root = null;
    host?.remove();

    const failed = await render({
      patch: addedPatch('doc.md', doc), filePath: 'doc.md', status: 'added',
    }, 'fail');
    await togglePreview(failed);
    expect(failed.querySelector(`${PREVIEW} h1`)).toBeNull();
    expect(failed.querySelector('[data-markdown-preview-state]')?.getAttribute('data-markdown-preview-state')).toBe('unavailable');
    await act(async () => root!.unmount());
    root = null;
    host?.remove();

    // The whole diff is stale (the server refuses the snapshot with 409).
    const staleDiff = await render({
      patch: addedPatch('doc.md', doc), filePath: 'doc.md', status: 'added', reviewSnapshotId: 'old',
    }, 'stale-snapshot');
    await togglePreview(staleDiff);
    expect(staleDiff.querySelector('[data-markdown-preview-state]')?.getAttribute('data-markdown-preview-state')).toBe('stale');
  });

  test('in-page #anchors scroll to the slugged heading in the preview', async () => {
    const doc = '# Top\n\nGo to [part two](#section-two).\n\n## Section two\n\nHere.\n';
    const el = await render({
      patch: addedPatch('doc.md', doc), filePath: 'doc.md', status: 'added',
    }, { oldContent: null, newContent: doc });
    await togglePreview(el);
    const heading = el.querySelector(`${PREVIEW} h2`)!;
    expect(heading.id).toBe('section-two');
    let scrolled: Element | null = null;
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled = this; };
    try {
      expect(click(linkByText(el, 'part two')!).defaultPrevented).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(scrolled).toBe(heading);
  });

  test('responsive images, <picture> sources and videos never load from the page', async () => {
    const doc = [
      '# Media',
      '',
      '<p><img src="img/a.png" srcset="img/a@2x.png 2x" alt="hi-dpi"></p>',
      '',
      '<picture><source srcset="img/dark.png" media="(prefers-color-scheme: dark)"><img src="img/light.png" alt="themed"></picture>',
      '',
      '<video src="clip.mp4" poster="poster.png" controls></video>',
      '',
      '![absent](/tmp/x.png)',
      '',
    ].join('\n');
    const el = await render({
      patch: addedPatch('docs/README.md', doc), filePath: 'docs/README.md', status: 'added',
      imagePreviewAvailable: true, imageSnapshotId: 'snap-1',
    }, { oldContent: null, newContent: doc });
    await togglePreview(el);
    const preview = el.querySelector(PREVIEW)!;
    expect(preview.querySelector('[srcset]')).toBeNull();
    expect(preview.querySelector('source')).toBeNull();
    expect(preview.querySelector('video')).toBeNull();
    expect(preview.querySelector('img[alt="themed"]')?.getAttribute('src')).toBe(imageUrl('docs/README.md', 'img/light.png'));
    // Every remaining image goes through the per-revision route or is a placeholder.
    for (const img of Array.from(preview.querySelectorAll('img'))) {
      expect(img.getAttribute('src')!.startsWith('/api/review-markdown-image?')).toBe(true);
    }
    const labels = Array.from(preview.querySelectorAll('[data-image-unavailable]')).map((n) => n.textContent);
    expect(labels).toContain('Video');

    // An image the server refuses (an absolute path, say) shows the
    // placeholder instead of a broken image once it fails to load.
    const absent = preview.querySelector<HTMLImageElement>('img[alt="absent"]')!;
    await act(async () => {
      absent.dispatchEvent(new Event('error'));
    });
    expect(preview.querySelector('img[alt="absent"]')).toBeNull();
    expect(Array.from(preview.querySelectorAll('[data-image-unavailable]')).map((n) => n.textContent)).toContain('absent');
    const raw = preview.querySelector<HTMLImageElement>('img[alt="hi-dpi"]')!;
    raw.dispatchEvent(new Event('error'));
    expect(preview.querySelector('img[alt="hi-dpi"]')).toBeNull();
  });

  test('images load from the reviewed revision, named as the document wrote them', async () => {
    const doc = [
      '# Shots',
      '',
      '![near](img/a.png) ![up](../top.png) ![root](/assets/r.png) ![remote](https://example.com/r.png)',
      '',
      '<p><img src="img/b.png" alt="raw"></p>',
      '',
    ].join('\n');
    const el = await render({
      patch: addedPatch('docs/guide/README.md', doc),
      filePath: 'docs/guide/README.md',
      status: 'added',
      imagePreviewAvailable: true,
      imageSnapshotId: 'snap-1',
    }, { oldContent: null, newContent: doc });
    await togglePreview(el);

    const src = (alt: string) => el.querySelector<HTMLImageElement>(`${PREVIEW} img[alt="${alt}"]`)?.getAttribute('src');
    // The server resolves each against the document's folder at that side
    // and serves only what the document references.
    expect(src('near')).toBe(imageUrl('docs/guide/README.md', 'img/a.png'));
    expect(src('up')).toBe(imageUrl('docs/guide/README.md', '../top.png'));
    expect(src('root')).toBe(imageUrl('docs/guide/README.md', '/assets/r.png'));
    expect(src('raw')).toBe(imageUrl('docs/guide/README.md', 'img/b.png'));
    expect(src('remote')).toBe('https://example.com/r.png');
  });

  test('without server image support, repository images show placeholders', async () => {
    const doc = '# Shots\n\n![near](img/a.png)\n\n<p><img src="img/b.png" alt="raw"></p>\n';
    const el = await render({
      patch: addedPatch('docs/README.md', doc),
      filePath: 'docs/README.md',
      status: 'added',
      imagePreviewAvailable: false,
    }, { oldContent: null, newContent: doc });
    await togglePreview(el);
    expect(el.querySelector(`${PREVIEW} img`)).toBeNull();
    const placeholders = Array.from(el.querySelectorAll(`${PREVIEW} [data-image-unavailable]`)).map((n) => n.textContent);
    expect(placeholders.sort()).toEqual(['near', 'raw']);
  });

  test('the toggle appears only where a preview can work', async () => {
    const doc = '# A\n';
    // Static patch: no full file behind the diff.
    let el = await render({
      patch: addedPatch('a.md', doc), filePath: 'a.md', status: 'added', contextExpansionAvailable: false,
    }, { oldContent: null, newContent: doc });
    expect(el.querySelector(TOGGLE)).toBeNull();

    // A rename away from Markdown previews nothing.
    await rerender({
      patch: addedPatch('a.txt', doc), filePath: 'a.txt', oldPath: 'a.md', status: 'renamed',
    });
    expect(el.querySelector(TOGGLE)).toBeNull();

    // `.markdown` is Markdown.
    await rerender({ patch: addedPatch('a.markdown', doc), filePath: 'a.markdown', status: 'added' });
    expect(el.querySelector(TOGGLE)).not.toBeNull();

    // So is an extension listed in `markdownExtensions`.
    await rerender({ patch: addedPatch('book.livemd', doc), filePath: 'book.livemd', status: 'added' });
    expect(el.querySelector(TOGGLE)).toBeNull();
    setExtraMarkdownExtensions(['.livemd']);
    await rerender({ patch: addedPatch('book.livemd', doc), filePath: 'book.livemd', status: 'added', isFocused: true });
    expect(el.querySelector(TOGGLE)).not.toBeNull();

    // An added file has no Changes view: rendered means Read.
    await togglePreview(el);
    el = host!;
    expect(el.querySelector(TOGGLE)?.getAttribute('data-markdown-view')).toBe('read');
    expect(el.querySelector('[data-markdown-preview-view]')?.getAttribute('data-markdown-preview-view')).toBe('whole');

    // A server that does not advertise the preview shows no switch.
    await rerender({ patch: addedPatch('a.md', doc), filePath: 'a.md', status: 'added', markdownPreviewSupported: false });
    expect(el.querySelector(TOGGLE)).toBeNull();
  });

  test('while All files holds the file in an edit session, its menu here is disabled and says why', async () => {
    const doc = '# A\n';
    const el = await render({
      patch: addedPatch('a.md', doc), filePath: 'a.md', status: 'added', markdownViewDisabledReason: 'Finish editing first',
    }, { oldContent: null, newContent: doc });
    const button = el.querySelector<HTMLButtonElement>(TOGGLE)!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Finish editing first');
  });

  test('a large file asks before rendering', async () => {
    const tail = Array.from({ length: 6000 }, (_, i) => `line ${i} ${'y'.repeat(50)}`).join('\n');
    const oldDoc = `# Old\n\n\`\`\`\n${tail}\n\`\`\`\n`;
    const newDoc = `# Big\n\n\`\`\`\n${tail}\n\`\`\`\n`;
    const patch = [
      'diff --git a/big.md b/big.md',
      'index 1111111..2222222 100644',
      '--- a/big.md',
      '+++ b/big.md',
      '@@ -1,2 +1,2 @@',
      '-# Old',
      '+# Big',
      ' ',
      '',
    ].join('\n');
    const el = await render({ patch, filePath: 'big.md', status: 'modified' }, { oldContent: oldDoc, newContent: newDoc });
    await togglePreview(el);
    expect(el.querySelector('[data-markdown-preview-large]')).not.toBeNull();
    expect(el.querySelector(`${PREVIEW} h1`)).toBeNull();
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-markdown-preview-anyway]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // The rendered diff: the old heading struck, the new one added.
    expect(el.querySelector(`${PREVIEW} .plan-diff-added h1`)?.textContent).toBe('Big');
  });

  test('a non-Markdown binary file keeps its notice above the file comments', async () => {
    const patch = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 1111111111aa..2222222222bb 100644',
      'Binary files a/assets/logo.png and b/assets/logo.png differ',
      '',
    ].join('\n');
    const fileComment = {
      id: 'file-1', type: 'comment', scope: 'file', filePath: 'assets/logo.png',
      lineStart: 0, lineEnd: 0, side: 'new', text: 'on the file', createdAt: 1,
    } as CodeAnnotation;
    const el = await render({ patch, filePath: 'assets/logo.png', annotations: [fileComment] }, { oldContent: null, newContent: null });
    const notice = el.querySelector('[data-binary-file-notice]')!;
    const banner = el.querySelector('[data-annotation-id="file-1"]')!;
    expect(notice).not.toBeNull();
    expect(banner).not.toBeNull();
    expect(notice.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
