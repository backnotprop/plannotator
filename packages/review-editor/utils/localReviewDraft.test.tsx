import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useAnnotationFactory } from '../hooks/useAnnotationFactory';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { parseDiffToFiles } from './diffParser';
import { reanchorCodeAnnotations } from './codeAnnotationAnchor';
import { localReviewDraftTransport, withLocalReviewTarget } from './localReviewDraft';
import { DraftTargetChangedError } from '@plannotator/ui/hooks/useCodeAnnotationDraft';

const hasDom = typeof document !== 'undefined';

const patch = (text: string) => `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+${text}\n`;
const files = parseDiffToFiles(patch('after'));
const annotation: CodeAnnotation = {
  id: 'a', type: 'comment', filePath: 'a.ts', side: 'new', lineStart: 1, lineEnd: 1, text: 'why?', createdAt: 1,
};

test('generation conflicts do not masquerade as target changes, and missing drafts keep their generation floor', async () => {
  const previousFetch = globalThis.fetch;
  const transport = localReviewDraftTransport('local-a', 'page-1');
  try {
    globalThis.fetch = (async () => Response.json({ error: 'stale draft generation', draftGeneration: 40 }, { status: 409 })) as typeof fetch;
    const error = await transport.save({}, { keepalive: false }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DraftTargetChangedError);
    globalThis.fetch = (async () => Response.json({ found: false, draftGeneration: 40 }, { status: 404 })) as typeof fetch;
    expect(await transport.load()).toEqual({ data: null, generation: 40 });
  } finally { globalThis.fetch = previousFetch; }
});

test.skipIf(!hasDom)('new local comments acquire anchors; refresh preserves unchanged comments and marks shifted code outdated', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  let make!: (a: CodeAnnotation) => CodeAnnotation;
  function Harness({ target }: { target?: string }) {
    make = useAnnotationFactory(null, undefined, undefined, undefined, files, 'before', target).withPRContext;
    return null;
  }
  try {
    await act(async () => { root.render(<Harness target="local-a" />); });
    const created = make(annotation);
    const unchanged = reanchorCodeAnnotations([created], files, { currentSnapshot: 'unrelated-edit' });
    expect(unchanged[0]).toMatchObject({ localReviewTarget: 'local-a', anchorText: 'after', anchorSnapshot: 'unrelated-edit' });
    expect(unchanged[0].outdated).toBeUndefined();
    const changed = reanchorCodeAnnotations(unchanged, parseDiffToFiles(patch('different')), { currentSnapshot: 'edited' });
    expect(changed[0]).toMatchObject({ text: 'why?', anchorText: 'after', lineStart: 1, outdated: true });
    // Unsupported surfaces/older servers retain the previous annotation shape.
    await act(async () => { root.render(<Harness />); });
    expect(make(annotation)).toEqual(annotation);
  } finally { await act(async () => { root.unmount(); }); }
});

test('an exact-patch legacy restore starts tracking subsequent edits, but a changed legacy patch cannot invent an anchor', () => {
  const exact = withLocalReviewTarget([annotation], 'local-a', files, 's1', false);
  expect(reanchorCodeAnnotations(exact, parseDiffToFiles(patch('edited')), { currentSnapshot: 's2' })[0].outdated).toBe(true);
  const changed = withLocalReviewTarget([annotation], 'local-a', files, 's1', true);
  expect(reanchorCodeAnnotations(changed, files, { currentSnapshot: 's1', patchChanged: true })[0].outdated).toBe(true);
});
