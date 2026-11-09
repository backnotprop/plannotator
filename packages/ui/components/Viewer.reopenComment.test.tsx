/**
 * `ViewerHandle.reopenComment`: a host that kept a comment being written when
 * its file closed puts it back, and the markdown Viewer opens the composer on
 * the same words of the document, holding the person's words, without saving
 * anything. Missing anchors say so (`onMissing`), and kinds the Viewer has no
 * composer for refuse (false), so the host can keep the words some other way.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useLayoutEffect } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';
import type { ViewerHandle } from './Viewer';

const hasDom = typeof document !== 'undefined';
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];

const MARKDOWN = [
  'First paragraph alpha ends here.',
  '',
  'Second paragraph beta starts here, and beta again.',
  '',
  '```ts',
  'const hotel = 1;',
  '```',
].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;
let added: Annotation[] = [];

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  added = [];
  if (hasDom) document.body.innerHTML = '';
});

function viewer(ref: React.RefObject<ViewerHandle | null>) {
  return (
    <Viewer
      ref={ref as never}
      blocks={parseMarkdownToBlocks(MARKDOWN)}
      markdown={MARKDOWN}
      annotations={[]}
      onAddAnnotation={(annotation) => { added.push(annotation); }}
      onSelectAnnotation={() => {}}
      selectedAnnotationId={null}
      mode="comment"
      taterMode={false}
      disableCodePathValidation
    />
  );
}

async function mount(node?: (ref: React.RefObject<ViewerHandle | null>) => React.ReactNode): Promise<React.RefObject<ViewerHandle | null>> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const ref = React.createRef<ViewerHandle>();
  await act(async () => {
    root = createRoot(host!);
    root.render(node ? node(ref) : viewer(ref));
  });
  return ref;
}

const articleRoot = (): HTMLElement => document.querySelector<HTMLElement>('article[data-print-region="article"]')!;
const paragraph = (needle: string): HTMLElement =>
  Array.from(articleRoot().getElementsByTagName('p')).find((el) => (el.textContent ?? '').includes(needle)) as HTMLElement;
const metaFor = (el: HTMLElement, textOffset: number) => ({
  parentTagName: el.tagName,
  parentIndex: Array.from(articleRoot().getElementsByTagName(el.tagName)).indexOf(el),
  textOffset,
});
const composer = (): HTMLTextAreaElement | null => document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');

/** The comment a person was writing on the SECOND "beta" (its stored positions name it, not the first). */
function keptOnSecondBeta(): Annotation {
  const p = paragraph('Second');
  const text = p.textContent ?? '';
  const at = text.lastIndexOf('beta');
  return {
    id: 'keptOne',
    blockId: '',
    startOffset: 0,
    endOffset: 4,
    type: AnnotationType.COMMENT,
    text: 'Not sent yet',
    originalText: 'beta',
    createdA: 1,
    startMeta: metaFor(p, at),
    endMeta: metaFor(p, at + 4),
  };
}

const submit = async (area: HTMLTextAreaElement) => {
  await act(async () => {
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  });
};

describe('Viewer.reopenComment', () => {
  test.skipIf(!hasDom)('a text selection comes back on its own words, holding the words, and saves as a new comment only when the person saves', async () => {
    const ref = await mount();
    const kept = keptOnSecondBeta();
    let missing = 0;
    let answer: boolean | undefined;
    await act(async () => { answer = ref.current!.reopenComment!(kept, () => { missing += 1; }); });
    expect(answer).toBe(true);
    expect(missing).toBe(0);
    expect(composer()?.value).toBe('Not sent yet');
    // The pending mark is on the second "beta", where the stored positions put it.
    const marks = Array.from(paragraph('Second').querySelectorAll('mark'));
    expect(marks.map((m) => m.textContent).join('')).toBe('beta');
    expect(marks[0]!.nextSibling?.textContent?.startsWith(' again')).toBe(true);
    expect(added).toEqual([]);

    await submit(composer()!);
    expect(added.length).toBe(1);
    expect(added[0]!.text).toBe('Not sent yet');
    expect(added[0]!.originalText).toBe('beta');
    expect(added[0]!.startMeta).toEqual(kept.startMeta);
    expect(added[0]!.endMeta).toEqual(kept.endMeta);
    expect(composer()).toBeNull();
  });

  test.skipIf(!hasDom)('without stored positions the quote is searched, and the composer still holds the words', async () => {
    const ref = await mount();
    const kept: Annotation = { ...keptOnSecondBeta(), originalText: 'alpha ends', startMeta: undefined, endMeta: undefined };
    await act(async () => { ref.current!.reopenComment!(kept); });
    expect(composer()?.value).toBe('Not sent yet');
    expect(Array.from(paragraph('First').querySelectorAll('mark')).map((m) => m.textContent).join('')).toBe('alpha ends');
    expect(added).toEqual([]);
  });

  test.skipIf(!hasDom)('a quote no longer in the document: onMissing once, nothing opens', async () => {
    const ref = await mount();
    const kept: Annotation = { ...keptOnSecondBeta(), originalText: 'zulu was removed', startMeta: undefined, endMeta: undefined };
    let missing = 0;
    await act(async () => { ref.current!.reopenComment!(kept, () => { missing += 1; }); });
    expect(missing).toBe(1);
    expect(composer()).toBeNull();
    expect(articleRoot().querySelector('mark')).toBeNull();
  });

  test.skipIf(!hasDom)('asked during the first commit (before the highlighter exists), it opens once the document is ready', async () => {
    const kept = { current: null as Annotation | null };
    function Host({ viewerRef }: { viewerRef: React.RefObject<ViewerHandle | null> }) {
      useLayoutEffect(() => {
        // The Viewer's layout phase is done (the handle is set), its effects are not.
        const p = Array.from(document.querySelectorAll('article p')).find((el) => (el.textContent ?? '').includes('Second')) as HTMLElement;
        const text = p.textContent ?? '';
        const at = text.lastIndexOf('beta');
        const tagIndex = Array.from(document.querySelector('article')!.getElementsByTagName('P')).indexOf(p);
        kept.current = {
          id: 'early',
          blockId: '',
          startOffset: 0,
          endOffset: 4,
          type: AnnotationType.COMMENT,
          text: 'Typed before the close',
          originalText: 'beta',
          createdA: 1,
          startMeta: { parentTagName: 'P', parentIndex: tagIndex, textOffset: at },
          endMeta: { parentTagName: 'P', parentIndex: tagIndex, textOffset: at + 4 },
        };
        viewerRef.current?.reopenComment?.(kept.current);
      }, [viewerRef]);
      return null;
    }
    await mount((ref) => (
      <>
        {viewer(ref)}
        <Host viewerRef={ref} />
      </>
    ));
    expect(kept.current).not.toBeNull();
    expect(composer()?.value).toBe('Typed before the close');
  });

  test.skipIf(!hasDom)('a fenced code block comment opens on its block with the words', async () => {
    const ref = await mount();
    const block = parseMarkdownToBlocks(MARKDOWN).find((b) => b.type === 'code')!;
    const kept: Annotation = {
      id: 'codeblock-1',
      blockId: block.id,
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.COMMENT,
      text: 'Rename hotel',
      originalText: articleRoot().querySelector(`[data-block-id="${block.id}"] code`)?.textContent ?? '',
      createdA: 1,
    };
    let answer: boolean | undefined;
    await act(async () => { answer = ref.current!.reopenComment!(kept); });
    expect(answer).toBe(true);
    expect(composer()?.value).toBe('Rename hotel');
    await submit(composer()!);
    expect(added.length).toBe(1);
    expect(added[0]!.blockId).toBe(block.id);
    expect(added[0]!.text).toBe('Rename hotel');
  });

  test.skipIf(!hasDom)('kinds with no composer here refuse, so the host keeps the words', async () => {
    const ref = await mount();
    const base = keptOnSecondBeta();
    expect(ref.current!.reopenComment!({ ...base, imageRegion: { src: 'a.png', line: 1, x: 0, y: 0, w: 1, h: 1 } as never })).toBe(false);
    expect(ref.current!.reopenComment!({ ...base, questionAnswer: { key: 'q' } as never })).toBe(false);
    expect(ref.current!.reopenComment!({ ...base, type: AnnotationType.DELETION })).toBe(false);
    expect(composer()).toBeNull();
  });

  test.skipIf(!hasDom)('a global comment opens the global composer with its words', async () => {
    const ref = await mount();
    const kept: Annotation = {
      id: 'globalKept',
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.GLOBAL_COMMENT,
      text: 'Overall fine',
      originalText: '',
      createdA: 1,
    };
    let answer: boolean | undefined;
    await act(async () => { answer = ref.current!.reopenComment!(kept); });
    expect(document.querySelector('[title="Add global comment"]')).not.toBeNull();
    expect(answer).toBe(true);
    expect(composer()?.value).toBe('Overall fine');
  });
});
