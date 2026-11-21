/**
 * Footnote references, `www.`/e-mail autolinks and character references in
 * the plan Viewer, and the comments people already saved on such text.
 *
 * Before these were drawn, `[^1]`, `www.example.org`, `someone@example.com`
 * and `&amp;` rendered as the literal text. A comment saved then holds its
 * block id (`block-N`), web-highlighter metas (`parentTagName`/`parentIndex`/
 * `textOffset`) counted in THAT page, and a quote that may hold `[^1]` or
 * `&amp;` as written. `tests/test-fixtures/footnote-old-anchors.json` holds
 * comments made on origin/main's Viewer (see its `generatedFrom`); each must
 * come back on exactly its words, in its own block, with nothing rewritten,
 * even where the sentence is written twice. The other anchors below are
 * written by hand in the same shape. New selections across a link or a
 * reference must make comments that restore too.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnnotationType, type Annotation } from '../types';
import { exportAnnotations, parseMarkdownToBlocks } from '../utils/parser';
import type { AnnotationRestoreReport } from '../hooks/useAnnotationHighlighter';

const hasDom = typeof document !== 'undefined';
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];

// Each paragraph as the OLD renderer showed it: its source, character for character.
const PARA_A = 'Here is a claim with a footnote.[^1] And another claim.[^note] Then more words.';
const PARA_B = 'Visit www.example.org and mail someone@example.com today, then https://example.com/docs for more.';
const PARA_C = 'Example &amp; Co is a name with an entity in it.';
const MARKDOWN = ['# Title', '', PARA_A, '', PARA_B, '', PARA_C, '', '[^1]: The first note.', '[^note]: A named note.'].join('\n');

interface ViewerHandle {
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

const roots: Root[] = [];

async function mount(
  onAdd: (a: Annotation) => void = () => {},
  markdown = MARKDOWN,
  onRestoreReport?: (report: AnnotationRestoreReport) => void,
): Promise<{ ref: React.RefObject<ViewerHandle | null>; host: HTMLElement }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ref = React.createRef<ViewerHandle>();
  await act(async () => {
    const root = createRoot(host);
    roots.push(root);
    root.render(
      <Viewer
        ref={ref as never}
        blocks={parseMarkdownToBlocks(markdown)}
        markdown={markdown}
        annotations={[]}
        onAddAnnotation={onAdd}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="comment"
        inputMethod="drag"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        onRestoreReport={onRestoreReport}
      />,
    );
  });
  await settle();
  return { ref, host };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const paragraphs = (host: HTMLElement) => Array.from(host.querySelector('article')!.getElementsByTagName('p'));

/** The index the old page gave the paragraph that starts with `start`: no `<p>` was added before it. */
const oldParagraphIndex = (host: HTMLElement, start: string): number => {
  const index = paragraphs(host).findIndex((p) => (p.textContent ?? '').startsWith(start));
  if (index === -1) throw new Error(`paragraph "${start}" did not render`);
  return index;
};

/** A comment saved on the old page: metas counted in `oldText`, the quote as the old page showed it. */
function oldAnchor(id: string, parentIndex: number, oldText: string, quote: string, parentTagName = 'P'): Annotation {
  const at = oldText.indexOf(quote);
  if (at === -1) throw new Error(`"${quote}" is not in the old text`);
  return {
    id,
    blockId: 'oldBlock',
    startOffset: at,
    endOffset: at + quote.length,
    type: AnnotationType.COMMENT,
    text: 'a comment',
    originalText: quote,
    createdA: 1,
    startMeta: { parentTagName, parentIndex, textOffset: at },
    endMeta: { parentTagName, parentIndex, textOffset: at + quote.length },
  };
}

const marks = (id: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-highlight-id="${id}"], [data-bind-id="${id}"]`));
const painted = (id: string): string => marks(id).map((el) => el.textContent ?? '').join('');
/** The block (`data-block-id`) a comment's highlight sits in. */
const paintedBlock = (id: string): string | undefined => marks(id)[0]?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;

const OLD = JSON.parse(readFileSync(join(import.meta.dir, '../../../tests/test-fixtures/footnote-old-anchors.json'), 'utf8')) as {
  docs: { name: string; markdown: string; restoreOn?: string; annotation: Annotation }[];
};
/** What each captured comment paints on the page now: its words as drawn (a reference's number is not part of a quote). */
const NOW: Record<string, { text: string; inNotes?: boolean; block?: string }> = {
  'a definition mid-document; the second copy of a repeated sentence': { text: 'Then run the tests.' },
  'a run of definitions under a line; the second copy of a repeated sentence': { text: 'Then run the tests.' },
  'a repeated sentence after a character reference in its paragraph': { text: 'Then run the tests.' },
  'a repeated link after a new www. link in its paragraph': { text: 'the docs' },
  'a whole old definition paragraph, marker included': { text: 'The first note.', inNotes: true },
  'a quote across a reference': { text: 'a footnote. And another' },
  // No footnotes: the saved positions win, as on main. The stored block-2 now
  // names the FIRST copy; the positions lead to the second, the right one.
  'a draft reopened after a heading was inserted above a repeated sentence': { text: 'Run the tests.', block: 'block-3' },
};

describe.if(hasDom)('comments made on the page before footnotes, links and references were drawn (captured on origin/main)', () => {
  test('the fixture covers every case', () => {
    expect(OLD.docs.map((d) => d.name).sort()).toEqual(Object.keys(NOW).sort());
  });
  for (const doc of OLD.docs) {
    test(doc.name, async () => {
      const reports: AnnotationRestoreReport[] = [];
      const { ref } = await mount(() => {}, doc.restoreOn ?? doc.markdown, (r) => reports.push(r));
      const ann = doc.annotation;
      await act(async () => ref.current!.applySharedAnnotations([ann]));
      await settle();
      expect(painted(ann.id)).toBe(NOW[doc.name].text);
      // In the block it was made in (block ids are kept), not the first copy of its words.
      expect(paintedBlock(ann.id)).toBe(NOW[doc.name].block ?? ann.blockId);
      expect(Boolean(marks(ann.id)[0]?.closest('[data-footnotes]'))).toBe(Boolean(NOW[doc.name].inNotes));
      // Nothing to write back: the plan editor would otherwise save a new block id and drop the positions.
      const last = reports.filter((r) => r.attempted.includes(ann.id)).at(-1)!;
      expect(last.unanchored).toEqual([]);
      expect(last.moved ?? []).toEqual([]);
    });
  }

  const THREE = ['# One', '', 'Run the tests.', '', '# Two', '', 'Run the tests.', '', '# Three', '', 'Run the tests.', '', 'Closing words.'].join('\n');
  const lost = (id: string, blockId: string, quote = 'Run the tests.'): Annotation => ({
    ...oldAnchor(id, 40, quote, quote),
    blockId,
  });

  test('positions that miss and a quote written three times: the copy nearest the stored block, reported moved', async () => {
    // The copies are block-1, block-3 and block-5; block-6 is "Closing words.", next to the third. The positions lead nowhere.
    const reports: AnnotationRestoreReport[] = [];
    const { ref } = await mount(() => {}, THREE, (r) => reports.push(r));
    await act(async () => ref.current!.applySharedAnnotations([lost('near', 'block-6')]));
    await settle();
    expect(painted('near')).toBe('Run the tests.');
    expect(paintedBlock('near')).toBe('block-5');
    const last = reports.filter((r) => r.attempted.includes('near')).at(-1)!;
    expect(last.unanchored).toEqual([]);
    expect(last.moved?.map((m) => [m.id, m.blockId])).toEqual([['near', 'block-5']]);
  });

  test('a stored block that is gone goes by where its number falls; a tie takes the later copy', async () => {
    const reports: AnnotationRestoreReport[] = [];
    const { ref } = await mount(() => {}, THREE, (r) => reports.push(r));
    // block-2 is "# Two" (holds no copy): the copies in block-1 and block-3 are equally near, the later wins.
    await act(async () => ref.current!.applySharedAnnotations([lost('tie', 'block-2'), lost('gone', 'block-99')]));
    await settle();
    expect(paintedBlock('tie')).toBe('block-3');
    // block-99 falls after the last block: the third copy.
    expect(paintedBlock('gone')).toBe('block-5');
  });

  test('words that are nowhere: unanchored, no block (so no line label), words and positions kept', async () => {
    const reports: AnnotationRestoreReport[] = [];
    const { ref } = await mount(() => {}, THREE, (r) => reports.push(r));
    const ann = lost('nowhere', 'block-2', 'Deploy on Friday.');
    await act(async () => ref.current!.applySharedAnnotations([ann]));
    await settle();
    expect(painted('nowhere')).toBe('');
    const last = reports.filter((r) => r.attempted.includes('nowhere')).at(-1)!;
    expect(last.unanchored).toEqual(['nowhere']);
    expect(last.moved).toEqual([{ id: 'nowhere', blockId: '', positionsStale: false }]);
    // What the plan editor stores from that (restoredAnchors.test.ts): no block, so the export names no line.
    expect(exportAnnotations(parseMarkdownToBlocks(THREE), [{ ...ann, blockId: '' }])).not.toMatch(/\(lines? \d/);
    // Kept, its stale block would label an unrelated line (block-2 is the "# Two" heading).
    expect(exportAnnotations(parseMarkdownToBlocks(THREE), [ann])).toMatch(/\(line 5\)/);
  });

  test('an unanchored comment whose words come back paints and takes its block (and line label) back', async () => {
    const reports: AnnotationRestoreReport[] = [];
    const { ref, host } = await mount(() => {}, THREE, (r) => reports.push(r));
    // As the plan editor stored it after a restore found its words nowhere: no block, words and positions kept.
    const byPositions: Annotation = { ...oldAnchor('back', oldParagraphIndex(host, 'Closing'), 'Closing words.', 'Closing words.'), blockId: '' };
    const bySearch: Annotation = { ...lost('backSearch', '', 'Closing'), id: 'backSearch' };
    // A share link's comment comes with no block and no positions: it stays without one, as on main.
    const shared: Annotation = { ...bySearch, id: 'shared', originalText: 'words.', startMeta: undefined, endMeta: undefined, startOffset: 0, endOffset: 0 };
    await act(async () => ref.current!.applySharedAnnotations([byPositions, bySearch, shared]));
    await settle();
    expect(painted('back')).toBe('Closing words.');
    expect(painted('backSearch')).toBe('Closing');
    expect(painted('shared')).toBe('words.');
    const last = reports.filter((r) => r.attempted.includes('back')).at(-1)!;
    expect(last.unanchored).toEqual([]);
    expect(last.moved?.map((m) => [m.id, m.blockId, m.startOffset])).toEqual([['back', 'block-6', 0], ['backSearch', 'block-6', 0]]);
    expect(exportAnnotations(parseMarkdownToBlocks(THREE), [{ ...byPositions, blockId: 'block-6' }])).toMatch(/\(line 13\)/);
  });

  test('a comment whose block is gone and whose words are written once still follows them', async () => {
    const reports: AnnotationRestoreReport[] = [];
    const { ref } = await mount(() => {}, MARKDOWN, (r) => reports.push(r));
    const ann = oldAnchor('once', 40, PARA_C, 'with an entity');
    await act(async () => ref.current!.applySharedAnnotations([{ ...ann, blockId: 'block-99' }]));
    await settle();
    expect(painted('once')).toBe('with an entity');
    const last = reports.filter((r) => r.attempted.includes('once')).at(-1)!;
    expect(last.moved?.map((m) => m.id)).toEqual(['once']);
  });
});

describe.if(hasDom)('comments saved before footnotes and autolinks were drawn', () => {
  test('a quote after a reference (its offsets moved) restores on its words', async () => {
    const { ref, host } = await mount();
    const old = oldAnchor('afterRef', oldParagraphIndex(host, 'Here is'), PARA_A, 'Then more words');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('afterRef')).toBe('Then more words');
  });

  test('a quote that held the reference as written restores on the words and the number', async () => {
    const { ref, host } = await mount();
    const old = oldAnchor('acrossRef', oldParagraphIndex(host, 'Here is'), PARA_A, 'a footnote.[^1] And another');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('acrossRef')).toBe('a footnote. And another');
  });

  test('a quote across text that is now a www. link and a mail link restores as it was saved', async () => {
    const { ref, host } = await mount();
    const old = oldAnchor('acrossLinks', oldParagraphIndex(host, 'Visit'), PARA_B, 'www.example.org and mail someone@example');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('acrossLinks')).toBe('www.example.org and mail someone@example');
  });

  test('a quote inside a link that now has new links before it is found again', async () => {
    const { ref } = await mount();
    // On the old page https://example.com/docs was the document's first <a>.
    const old = oldAnchor('inLink', 0, 'https://example.com/docs', 'example.com/docs', 'A');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('inLink')).toBe('example.com/docs');
  });

  test('a quote that held &amp; as written restores on the character', async () => {
    const { ref, host } = await mount();
    const old = oldAnchor('entity', oldParagraphIndex(host, 'Example'), PARA_C, 'Example &amp; Co');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('entity')).toBe('Example & Co');
  });

  test('a comment on the old definition paragraph finds its words in the notes list', async () => {
    const { ref, host } = await mount();
    const old = oldAnchor('noteText', oldParagraphIndex(host, 'Example') + 1, '[^1]: The first note.\n[^note]: A named note.', 'The first note');
    await act(async () => ref.current!.applySharedAnnotations([old]));
    expect(painted('noteText')).toBe('The first note');
    expect(document.querySelector('[data-highlight-id="noteText"], [data-bind-id="noteText"]')!.closest('[data-footnotes]')).not.toBeNull();
  });
});

async function selectBetween(host: HTMLElement, from: string, fromAt: string, to: string, toAt: string): Promise<void> {
  const find = (needle: string): Text => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(needle)) return n as Text;
    throw new Error(`no text node with "${needle}"`);
  };
  const start = find(from);
  const end = find(to);
  const range = document.createRange();
  range.setStart(start, start.textContent!.indexOf(fromAt));
  range.setEnd(end, end.textContent!.indexOf(toAt) + toAt.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    host.querySelector('article')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!textarea) throw new Error('composer did not open');
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set?.call(textarea, 'why?');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  });
  await settle();
}

describe.if(hasDom)('new comments across a reference or a link', () => {
  test('a selection across a footnote reference and one across links comment and restore after a reload', async () => {
    const added: Annotation[] = [];
    const first = await mount((a) => added.push(a));
    await selectBetween(first.host, 'with a footnote.', 'footnote.', ' And another claim.', 'And another');
    await selectBetween(first.host, 'Visit ', 'Visit', ' and mail ', 'and mail');
    // The reference's number is not part of the quote: the agent reads its own words back.
    expect(added.map((a) => a.originalText)).toEqual(['footnote. And another', 'Visit www.example.org and mail']);

    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();
    const second = await mount();
    await act(async () => second.ref.current!.applySharedAnnotations(added));
    expect(added.map((a) => painted(a.id))).toEqual(['footnote. And another', 'Visit www.example.org and mail']);
  });
});

describe.if(hasDom)('footnote navigation', () => {
  test('a reference moves focus to its note, the back link returns to that reference; two documents keep their own ids', async () => {
    const a = await mount();
    const b = await mount();
    const ids = Array.from(document.querySelectorAll('[data-footnotes] li')).map((li) => li.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);

    const refs = Array.from(b.host.querySelectorAll<HTMLAnchorElement>('a[data-footnote-ref]'));
    expect(refs.map((r) => r.textContent)).toEqual(['1', '2']);
    const note = b.host.querySelector<HTMLElement>(refs[1].getAttribute('href')!)!;
    expect(b.host.contains(note)).toBe(true);
    await act(async () => { refs[1].click(); });
    expect(document.activeElement).toBe(note);

    await act(async () => { note.querySelector<HTMLAnchorElement>('a[role="doc-backlink"]')!.click(); });
    expect(document.activeElement).toBe(refs[1]);

    // A Cmd/Ctrl click and a middle click move in place too: no new tab at an address without the page's hash.
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      (document.activeElement as HTMLElement | null)?.blur();
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
      await act(async () => { refs[1].dispatchEvent(click); });
      expect(click.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(note);
    }
    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    await act(async () => { note.querySelector<HTMLAnchorElement>('a[role="doc-backlink"]')!.dispatchEvent(middle); });
    expect(middle.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(refs[1]);
    expect(a.host.contains(document.activeElement)).toBe(false);
  });
});
