/**
 * Which heading each document's feedback lands under in the submitted export.
 *
 * Failures to catch:
 *  - The open document exported twice: once from the host's live state under
 *    the session heading and again from the linked-doc map, which also carries
 *    the open document (every folder session since at least 0.27.25).
 *  - The root document's comments vanishing while a linked document is open
 *    (plan review has no source path, so the stashed plan never reached the
 *    export), or landing under the linked heading instead of their own.
 *  - A folder session's documents described as "referenced in the plan".
 *  - The per-section counts disagreeing with what is printed.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation, type ImageAttachment } from '@plannotator/ui/types';
import type { CachedDocState, FeedbackDocuments } from '@plannotator/ui/hooks/useLinkedDoc';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { buildCompleteAnnotateFeedback } from './annotateSubmission';
import { collectSubmittedAnnotations, mergeExternalsIntoMessageEntries, resolveFeedbackSections } from './feedbackDocuments';

const A_PATH = '/repo/docs/a.md';
const B_PATH = '/repo/docs/b.md';
const A_TEXT = '# A\n\nAlpha paragraph to quote.';
const B_TEXT = '# B\n\nBravo paragraph to quote.';
const PLAN_TEXT = '# Plan\n\nPlan paragraph to quote.';

function inline(id: string, markdown: string, quote: string, text: string): Annotation {
  const block = parseMarkdownToBlocks(markdown).find((b) => b.type === 'paragraph')!;
  const start = block.content.indexOf(quote);
  return {
    id,
    blockId: block.id,
    startOffset: start,
    endOffset: start + quote.length,
    type: AnnotationType.COMMENT,
    text,
    originalText: quote,
    createdA: 1,
  };
}

function global(id: string, text: string): Annotation {
  return {
    id,
    blockId: '',
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.GLOBAL_COMMENT,
    text,
    originalText: '',
    createdA: 2,
  };
}

function doc(markdown: string, annotations: Annotation[]): CachedDocState {
  return { annotations, globalAttachments: [], markdown };
}

type Source = 'file' | 'folder' | null;

/** What App's getCurrentFeedbackPayload hands the builder. */
function submit(args: {
  annotateSource: Source;
  feedbackDocuments: FeedbackDocuments;
  live: { markdown: string; annotations: Annotation[]; globalAttachments?: ImageAttachment[] };
  externalAnnotations?: Annotation[];
}): string {
  const externals = args.externalAnnotations ?? [];
  const sections = resolveFeedbackSections({
    feedbackDocuments: args.feedbackDocuments,
    live: {
      // App's allAnnotations: the active document's local rows plus externals.
      annotations: [...args.live.annotations, ...externals],
      globalAttachments: args.live.globalAttachments ?? [],
      blocks: parseMarkdownToBlocks(args.live.markdown),
    },
    externalAnnotations: externals,
    sourceConverted: false,
    annotateSource: args.annotateSource,
  });
  return buildCompleteAnnotateFeedback({
    blocks: sections.blocks,
    annotations: sections.annotations,
    globalAttachments: sections.globalAttachments,
    linkedDocuments: sections.linkedDocuments,
    linkedDocumentsHeading: sections.linkedDocumentsHeading,
    editorAnnotations: [],
    codeAnnotations: [],
    title: args.annotateSource === 'folder' ? 'Folder Feedback' : args.annotateSource === 'file' ? 'File Feedback' : 'Plan Feedback',
    subject: args.annotateSource ?? 'plan',
    sourceConverted: sections.sourceConverted,
    directEditsSection: '',
    savedFileChangesSection: '',
  });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Folder sessions: the root is the empty folder placeholder, stashed while a file is open. */
const FOLDER_ROOT = { annotations: [], globalAttachments: [], markdown: '', isConverted: false, renderAs: 'markdown' as const };

describe('folder session feedback export', () => {
  test('comments on the open document are exported once, under its path', () => {
    const anns = [global('g1', 'OPEN-GLOBAL'), inline('i1', A_TEXT, 'Alpha paragraph', 'OPEN-INLINE')];
    const out = submit({
      annotateSource: 'folder',
      feedbackDocuments: { root: FOLDER_ROOT, documents: new Map([[A_PATH, doc(A_TEXT, anns)]]) },
      live: { markdown: A_TEXT, annotations: anns },
    });

    expect(count(out, 'OPEN-GLOBAL')).toBe(1);
    expect(count(out, 'OPEN-INLINE')).toBe(1);
    expect(count(out, `## ${A_PATH}`)).toBe(1);
    expect(out).toContain('have 2 pieces of feedback');
    // Nothing was said about the folder as a whole.
    expect(out).not.toContain('# Folder Feedback');
    // A folder's files are not documents a plan referenced.
    expect(out).not.toContain('referenced in the plan');
    // The payload opens on the heading, not a stray blank line.
    expect(out.startsWith('# Folder Document Feedback\n')).toBe(true);
  });

  test('the open document keeps full fidelity: document order, replies, diff and quick-label comments', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Paragraph number ${i + 1} text.`).join('\n\n');
    const at = (id: string, blockId: string, text: string, extra: Partial<Annotation> = {}): Annotation => ({
      id, blockId, startOffset: 0, endOffset: 9, type: AnnotationType.COMMENT,
      text, originalText: 'Paragraph', createdA: 1, ...extra,
    });
    const anns: Annotation[] = [
      at('c10', 'block-10', 'ON-BLOCK-TEN'),
      at('c2', 'block-2', 'ON-BLOCK-TWO'),
      at('r1', 'block-2', 'A-REPLY', { inReplyTo: 'c2', author: 'agent', createdA: 9 }),
      at('d1', 'block-5', 'IN-THE-DIFF', { diffContext: 'modified' }),
      at('q1', 'block-7', 'Needs tests', { isQuickLabel: true, quickLabelTip: 'Add a test.' } as Partial<Annotation>),
    ];
    const out = submit({
      annotateSource: 'folder',
      feedbackDocuments: { root: FOLDER_ROOT, documents: new Map([[A_PATH, doc(long, anns)]]) },
      live: { markdown: long, annotations: anns },
    });

    for (const text of ['ON-BLOCK-TEN', 'ON-BLOCK-TWO', 'A-REPLY', 'IN-THE-DIFF', 'Add a test.']) {
      expect(count(out, text)).toBe(1);
    }
    expect(out.indexOf('ON-BLOCK-TWO')).toBeLessThan(out.indexOf('ON-BLOCK-TEN'));
    expect(out).toContain('**Replies:**\n- **Reply (agent):** A-REPLY');
    expect(out).toContain('[In diff content]');
    expect(out).toContain('[Needs tests] Feedback on: "Paragraph"');
    expect(out).toContain('### Label Summary');
  });

  test('comments on another document only are exported once, under that path', () => {
    const bAnns = [inline('i2', B_TEXT, 'Bravo paragraph', 'OTHER-INLINE')];
    const out = submit({
      annotateSource: 'folder',
      feedbackDocuments: {
        root: FOLDER_ROOT,
        documents: new Map([[B_PATH, doc(B_TEXT, bAnns)], [A_PATH, doc(A_TEXT, [])]]),
      },
      live: { markdown: A_TEXT, annotations: [] },
    });

    expect(count(out, 'OTHER-INLINE')).toBe(1);
    expect(count(out, `## ${B_PATH}`)).toBe(1);
    expect(out).not.toContain(`## ${A_PATH}`);
    expect(out).toContain('have 1 piece of feedback');
  });

  test('comments on both documents each appear once, under their own path', () => {
    const aAnns = [global('g1', 'OPEN-GLOBAL'), inline('i1', A_TEXT, 'Alpha paragraph', 'OPEN-INLINE')];
    const bAnns = [inline('i2', B_TEXT, 'Bravo paragraph', 'OTHER-INLINE')];
    const out = submit({
      annotateSource: 'folder',
      feedbackDocuments: {
        root: FOLDER_ROOT,
        documents: new Map([[B_PATH, doc(B_TEXT, bAnns)], [A_PATH, doc(A_TEXT, aAnns)]]),
      },
      live: { markdown: A_TEXT, annotations: aAnns },
    });

    for (const text of ['OPEN-GLOBAL', 'OPEN-INLINE', 'OTHER-INLINE']) expect(count(out, text)).toBe(1);
    const aSection = out.slice(out.indexOf(`## ${A_PATH}`));
    const bSection = out.slice(out.indexOf(`## ${B_PATH}`), out.indexOf(`## ${A_PATH}`));
    expect(bSection).toContain('OTHER-INLINE');
    expect(bSection).toContain('have 1 piece of feedback');
    expect(aSection).toContain('OPEN-INLINE');
    expect(aSection).toContain('have 2 pieces of feedback');
  });
});

// A review of several files: the failure is the export following the order
// the reviewer happened to open files in (or path order) instead of the
// order the files were given for review.
describe('bundle session feedback export', () => {
  test('files are exported in bundle order, a linked document after them, each once', () => {
    const LINKED = '/repo/docs/linked.md';
    const sections = resolveFeedbackSections({
      feedbackDocuments: {
        root: FOLDER_ROOT,
        // Opened in this order: a linked document, then A, then B.
        documents: new Map([
          [LINKED, doc('# L\n\nLinked text.', [global('gl', 'LINKED-NOTE')])],
          [A_PATH, doc(A_TEXT, [inline('ia', A_TEXT, 'Alpha paragraph', 'A-NOTE')])],
          [B_PATH, doc(B_TEXT, [inline('ib', B_TEXT, 'Bravo paragraph', 'B-NOTE')])],
        ]),
      },
      live: { annotations: [], globalAttachments: [], blocks: parseMarkdownToBlocks(B_TEXT) },
      externalAnnotations: [],
      sourceConverted: false,
      annotateSource: 'folder',
      bundleOrder: [B_PATH, A_PATH],
    });
    expect([...sections.linkedDocuments.keys()]).toEqual([B_PATH, A_PATH, LINKED]);
    expect(sections.linkedDocumentsHeading.title).toBe('File Feedback');
    expect(collectSubmittedAnnotations(sections).map((a) => [a.id, a.documentPath])).toEqual([
      ['ib', B_PATH],
      ['ia', A_PATH],
      ['gl', LINKED],
    ]);
  });
});

describe('plain session with a linked document', () => {
  const planAnn = inline('p1', PLAN_TEXT, 'Plan paragraph', 'PLAN-COMMENT');
  const linkedAnn = inline('l1', B_TEXT, 'Bravo paragraph', 'LINKED-COMMENT');

  test('submitted from the plan: plan under its heading, linked doc under the linked heading (unchanged)', () => {
    const out = submit({
      annotateSource: null,
      feedbackDocuments: { root: null, documents: new Map([[B_PATH, doc(B_TEXT, [linkedAnn])]]) },
      live: { markdown: PLAN_TEXT, annotations: [planAnn] },
    });

    expect(out.indexOf('# Plan Feedback')).toBeLessThan(out.indexOf('PLAN-COMMENT'));
    expect(out.indexOf('# Linked Document Feedback')).toBeLessThan(out.indexOf('LINKED-COMMENT'));
    expect(out.indexOf('PLAN-COMMENT')).toBeLessThan(out.indexOf('# Linked Document Feedback'));
    expect(count(out, 'PLAN-COMMENT')).toBe(1);
    expect(count(out, 'LINKED-COMMENT')).toBe(1);
    expect(out).toContain('documents referenced in the plan');
  });

  test('submitted while the linked doc is open: same headings, each comment once', () => {
    const out = submit({
      annotateSource: null,
      feedbackDocuments: {
        root: { annotations: [planAnn], globalAttachments: [], markdown: PLAN_TEXT, isConverted: false, renderAs: 'markdown' },
        documents: new Map([[B_PATH, doc(B_TEXT, [linkedAnn])]]),
      },
      live: { markdown: B_TEXT, annotations: [linkedAnn] },
    });

    expect(count(out, 'PLAN-COMMENT')).toBe(1);
    expect(count(out, 'LINKED-COMMENT')).toBe(1);
    expect(out.indexOf('# Plan Feedback')).toBeLessThan(out.indexOf('PLAN-COMMENT'));
    expect(out.indexOf('PLAN-COMMENT')).toBeLessThan(out.indexOf('# Linked Document Feedback'));
    expect(out.indexOf(`## ${B_PATH}`)).toBeLessThan(out.indexOf('LINKED-COMMENT'));
    // The plan comment keeps the plan's line number, not the linked doc's.
    expect(out).toContain('(line 3) Feedback on: "Plan paragraph"');
  });

  test('external annotations ride the session heading whichever document is open', () => {
    const external: Annotation = { ...global('x1', 'EXTERNAL-NOTE'), source: 'eslint' };
    const out = submit({
      annotateSource: 'file',
      feedbackDocuments: {
        root: { annotations: [planAnn], globalAttachments: [], markdown: PLAN_TEXT, isConverted: false, renderAs: 'markdown' },
        documents: new Map([[B_PATH, doc(B_TEXT, [linkedAnn])]]),
      },
      live: { markdown: B_TEXT, annotations: [linkedAnn] },
      externalAnnotations: [external],
    });

    expect(count(out, 'EXTERNAL-NOTE')).toBe(1);
    expect(out.indexOf('EXTERNAL-NOTE')).toBeLessThan(out.indexOf('# Linked Document Feedback'));
    expect(out).toContain('have 2 pieces of feedback');
  });
});

// #1701: the submit body's `annotations` drives the host's "N comments" and the
// feedback archive's counts; it used to be the open document's comments only.
describe('collectSubmittedAnnotations', () => {
  test("a folder session submits every document's comments, each tagged with its document", () => {
    const a = inline('a1', A_TEXT, 'Alpha paragraph', 'ON-A');
    const b = inline('b1', B_TEXT, 'Bravo paragraph', 'ON-B');
    const sections = resolveFeedbackSections({
      // b.md is open; a.md was visited earlier.
      feedbackDocuments: { root: FOLDER_ROOT, documents: new Map([[A_PATH, doc(A_TEXT, [a])], [B_PATH, doc(B_TEXT, [b])]]) },
      live: { annotations: [b], globalAttachments: [], blocks: parseMarkdownToBlocks(B_TEXT) },
      externalAnnotations: [],
      sourceConverted: false,
      annotateSource: 'folder',
    });
    const submitted = collectSubmittedAnnotations(sections);
    expect(submitted.map((x) => [x.id, x.documentPath])).toEqual([['a1', A_PATH], ['b1', B_PATH]]);
  });

  test("the session's own document stays untagged; a linked document is tagged", () => {
    const plan = inline('p1', PLAN_TEXT, 'Plan paragraph', 'ON-PLAN');
    const a = inline('a1', A_TEXT, 'Alpha paragraph', 'ON-A');
    const sections = resolveFeedbackSections({
      feedbackDocuments: { root: null, documents: new Map([[A_PATH, doc(A_TEXT, [a])]]) },
      live: { annotations: [plan], globalAttachments: [], blocks: parseMarkdownToBlocks(PLAN_TEXT) },
      externalAnnotations: [],
      sourceConverted: false,
      annotateSource: 'file',
    });
    const submitted = collectSubmittedAnnotations(sections);
    expect(submitted.map((x) => [x.id, x.documentPath])).toEqual([['p1', undefined], ['a1', A_PATH]]);
  });

  test("multi-message annotate-last submits every message's comments", () => {
    const m1 = inline('m1', A_TEXT, 'Alpha paragraph', 'ON-MSG-1');
    const m2 = inline('m2', B_TEXT, 'Bravo paragraph', 'ON-MSG-2');
    const entry = (messageId: string, text: string, annotations: Annotation[]) =>
      ({ messageId, text, annotations, globalAttachments: [] });
    const submitted = collectSubmittedAnnotations(
      { annotations: [], linkedDocuments: new Map() },
      [entry('x', A_TEXT, [m1]), entry('y', B_TEXT, [m2])],
    );
    expect(submitted.map((x) => x.id)).toEqual(['m1', 'm2']);
  });
});

// #1701 review: multi-message annotate-last built its entries from LOCAL
// annotations only, so an agent / WebMCP comment reached neither the exported
// feedback nor the submit body, and a session holding only such a comment
// posted the "no feedback" sentence marked nothing-to-send.
describe('mergeExternalsIntoMessageEntries', () => {
  const entry = (messageId: string, text: string, annotations: Annotation[]) =>
    ({ messageId, text, annotations, globalAttachments: [] as ImageAttachment[] });
  const external = (id: string, text: string): Annotation => ({ ...global(id, text), source: 'browser-agent' });

  function exportMessages(entries: ReturnType<typeof entry>[]): string {
    return buildCompleteAnnotateFeedback({
      blocks: [], annotations: [], globalAttachments: [], linkedDocuments: new Map(),
      editorAnnotations: [], codeAnnotations: [], title: 'Message Feedback', subject: 'message',
      sourceConverted: false, directEditsSection: '', savedFileChangesSection: '',
      messageEntries: entries,
    });
  }

  test('an external comment rides the current message into the export and the submit body', () => {
    const entries = [entry('latest', A_TEXT, []), entry('older', B_TEXT, [])];
    const merged = mergeExternalsIntoMessageEntries(entries, 'older', [external('x1', 'AGENT-NOTE')]);

    const out = exportMessages(merged);
    expect(out).toContain('AGENT-NOTE');
    expect(out).not.toContain('has no feedback');
    expect(collectSubmittedAnnotations({ annotations: [], linkedDocuments: new Map() }, merged).map((a) => a.id))
      .toEqual(['x1']);
    expect(merged[1]!.annotations.map((a) => a.id)).toEqual(['x1']);
    expect(merged[0]!.annotations).toEqual([]);
  });

  test('a draft-restored copy of the same external is not exported twice', () => {
    const restored = { ...external('old-id', 'AGENT-NOTE') };
    const merged = mergeExternalsIntoMessageEntries([entry('latest', A_TEXT, [restored])], 'latest', [external('x1', 'AGENT-NOTE')]);
    expect(merged[0]!.annotations.map((a) => a.id)).toEqual(['x1']);
  });

  test('with no current match the latest message carries them; no externals changes nothing', () => {
    const entries = [entry('latest', A_TEXT, []), entry('older', B_TEXT, [])];
    expect(mergeExternalsIntoMessageEntries(entries, null, [external('x1', 'N')])[0]!.annotations.map((a) => a.id)).toEqual(['x1']);
    expect(mergeExternalsIntoMessageEntries(entries, 'older', [])).toBe(entries);
  });
});
