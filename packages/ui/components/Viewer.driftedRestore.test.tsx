/**
 * Draft/share restores survive an upgrade that changes the rendered element
 * census.
 *
 * web-highlighter's stored metas are positional: `parentIndex` is the index
 * among ALL elements of that tag under the container. #1509 hoisted a GitHub
 * alert's bold-only first line out of the alert body and onto the icon row, so
 * a titled alert stopped contributing its own `<p>` — every stored index after
 * it now names a LATER element, and the restore resolves onto the wrong text.
 * Viewer turns the hook's content verification on for exactly this: the bad
 * resolve is dropped and the text search re-anchors the annotation by its own
 * quote.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in web-highlighter, whose UMD bundle reads `window` at
// module-eval time; import lazily (same pattern as Viewer.consumer.test).
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];

const MARKDOWN = [
  '> [!TIP]',
  '> **Browser quirks**',
  '>',
  '> Safari drops the label when ALPHA happens in the caret path.',
  '',
  'Trailing paragraph BRAVO keeps running well past the end of the alert body.',
].join('\n');

const QUOTE = 'ALPHA happens';

let root: Root | null = null;
let host: HTMLElement | null = null;

interface ViewerHandle {
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

async function mount(): Promise<React.RefObject<ViewerHandle | null>> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const ref = React.createRef<ViewerHandle>();
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        ref={ref as never}
        blocks={parseMarkdownToBlocks(MARKDOWN)}
        markdown={MARKDOWN}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="comment"
        taterMode={false}
        disableCodePathValidation
      />,
    );
  });
  return ref;
}

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

const articleRoot = (): HTMLElement => {
  const article = document.querySelector<HTMLElement>('article[data-print-region="article"]');
  if (!article) throw new Error('Viewer did not render its annotation container');
  return article;
};

/**
 * The draft a reviewer wrote on the PRE-#1509 build: the alert body still
 * rendered the title as its own `<p>`, so the paragraph holding the quote sat
 * one `<p>` later in the container than it does today. Everything else (the
 * quote, the offsets inside the paragraph) is unchanged, which is what makes
 * the stale index resolve silently onto a different paragraph.
 */
function preUpgradeDraft(): Annotation {
  const paragraphs = Array.from(articleRoot().getElementsByTagName('p'));
  const index = paragraphs.findIndex((p) => (p.textContent ?? '').includes(QUOTE));
  if (index === -1) throw new Error('Alert body paragraph did not render');
  const drifted = paragraphs[index + 1];
  const textOffset = (paragraphs[index]!.textContent ?? '').indexOf(QUOTE);
  // The stale index must land on real, longer text, or the restore would fail
  // for want of a target rather than because it resolved onto the wrong one.
  if (!drifted || (drifted.textContent ?? '').length < textOffset + QUOTE.length) {
    throw new Error('Fixture no longer reproduces the drift this test guards');
  }
  return {
    id: 'ann-drifted',
    // Any stable id: restore resolves on the metas and the quote, never on
    // this. Keep it camelCase — Tailwind scans this file, and a hyphenated id
    // that parses as a utility candidate leaks a rule into every build.
    blockId: 'alertBody',
    startOffset: textOffset,
    endOffset: textOffset + QUOTE.length,
    type: AnnotationType.COMMENT,
    text: 'which quirk?',
    originalText: QUOTE,
    createdA: 1,
    startMeta: { parentTagName: 'P', parentIndex: index + 1, textOffset },
    endMeta: { parentTagName: 'P', parentIndex: index + 1, textOffset: textOffset + QUOTE.length },
  };
}

describe('Viewer restore after an element-census change', () => {
  test.skipIf(!hasDom)('a pre-#1509 draft is rescued by text instead of painting the wrong line', async () => {
    const ref = await mount();
    const draft = preUpgradeDraft();
    await act(async () => { ref.current!.applySharedAnnotations([draft]); });

    const painted = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-bind-id="${draft.id}"], [data-highlight-id="${draft.id}"]`),
    );
    expect(painted.map((el) => el.textContent ?? '').join('')).toBe(QUOTE);
    // The paragraph the stale index pointed at keeps no highlight at all.
    const trailing = Array.from(articleRoot().getElementsByTagName('p'))
      .find((p) => (p.textContent ?? '').includes('BRAVO'));
    expect(trailing?.querySelector('mark')).toBeNull();
    // ...and the rescued highlight is inside the alert it was written on.
    expect(painted[0]?.closest('[data-block-type="alert"]')).not.toBeNull();
  });
});
