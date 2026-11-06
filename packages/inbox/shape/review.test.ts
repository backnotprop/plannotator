/**
 * A board's review in the Inbox (approval "shape-whats-changed"). What regresses if these fail:
 * - the board links to an older review in its thread, or to a plain guide that is no review;
 * - a review place does not survive the address (a reload, Back) or lands somewhere else;
 * - a file the review does not change, or a step it does not have, opens the review anyway (at its top).
 */
import { expect, test } from 'bun:test';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeReviewAt } from '@plannotator/ui/components/shape/types';
import { shapeReview, shapeReviewAtOf, shapeReviewMessage, writeShapeReviewAt } from './review';

const snapshot = buildGuideSnapshot({
  guide: { title: 'Kettle', intent: 'One whistle.', sections: [{ title: 'The whistle', overview: '', diffs: [{ file: 'src/kettle.ts', summary: '' }] }, { title: 'The setting', overview: '', diffs: [{ file: 'src/settings.ts', summary: '' }] }] },
  reviewed: [false, false],
  review: { rawPatch: ['src/kettle.ts', 'src/settings.ts'].map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new\n`).join(''), gitRef: 'main...HEAD', source: { kind: 'pr', pr: { url: 'https://github.com/acme/kettle/pull/12', number: 12 } } },
  exportedAt: '2026-11-05T10:00:00.000Z',
});
const guide = (review: boolean) => ({ sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Kettle', sections: 2, files: 2, additions: 2, deletions: 2, ...(review ? { review: true as const, source: { kind: 'pr' as const, pr: { url: 'https://github.com/acme/kettle/pull/12', number: 12 } } } : {}) });
const msg = (id: string, g: ReturnType<typeof guide> | null) => ({ id, guide: g }) as unknown as InboxMessageWire;
const thread = (messages: InboxMessageWire[]) => ({ thread_id: 'msg_1', messages }) as unknown as InboxThread;

test("the board's review is its thread's newest review, never a plain guide", () => {
  expect(shapeReviewMessage(null)).toBeNull();
  expect(shapeReviewMessage(thread([msg('m1', null), msg('m2', guide(false))]))).toBeNull();
  expect(shapeReviewMessage(thread([msg('m1', guide(true)), msg('m2', guide(true)), msg('m3', guide(false)), msg('m4', null)]))?.id).toBe('m2');
});

test('a place in the review survives the address', () => {
  const places: ShapeReviewAt[] = [{ path: 'src/a b.ts', line: 42 }, { path: 'src/kettle.ts' }, { step: 3 }, { files: true }];
  for (const at of places) {
    const params = new URLSearchParams('thread=msg_1&guide=msg_2');
    writeShapeReviewAt(params, at);
    expect(shapeReviewAtOf(new URLSearchParams(params.toString()))).toEqual(at);
  }
  expect(shapeReviewAtOf(new URLSearchParams('thread=msg_1&guide=msg_2'))).toBeNull();
  expect(shapeReviewAtOf(new URLSearchParams('step=0'))).toBeNull();
});

test('open goes to the review at a file it changes or a step it has, and answers false otherwise', async () => {
  const went: [string, ShapeReviewAt | null][] = [];
  let reads = 0;
  const read = async () => (reads++, { snapshot });
  const review = shapeReview(msg('msg_review', guide(true)), (id, at) => went.push([id, at]), read);
  expect([review.label, review.files, review.additions, review.deletions]).toEqual(['#12', 2, 2, 2]);
  expect(await review.open({ path: 'src/kettle.ts', line: 7 })).toBe(true);
  expect(await review.open({ path: 'src/elsewhere.ts', line: 1 })).toBe(false);
  expect(await review.open({ step: 2 })).toBe(true);
  expect(await review.open({ step: 3 })).toBe(false);
  expect(await review.open({})).toBe(true);
  expect(await review.open({ files: true })).toBe(true);
  expect(went).toEqual([['msg_review', { path: 'src/kettle.ts', line: 7 }], ['msg_review', { step: 2 }], ['msg_review', null], ['msg_review', { files: true }]]);
  // The review's files are read once.
  expect(reads).toBe(1);
});
