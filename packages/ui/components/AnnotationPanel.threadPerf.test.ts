/**
 * The panel's thread ordering must stay linear: 2,000 threaded comments took
 * 4.5 s and 5,000 over a minute per render when the sort comparator walked
 * each reply chain with a linear parent lookup. POST /api/external-annotations
 * has no depth or count limit, so a buggy tool could freeze the tab.
 *
 * Exercises the same helpers the panel renders from (threadReplies plus the
 * shared root-timestamp resolution) without a DOM.
 */
import { describe, expect, test } from 'bun:test';
import { resolveThreadRootTimestamps } from '@plannotator/core/annotation-threads';
import { AnnotationType, type Annotation } from '../types';
import { threadReplies } from './AnnotationPanel';

function comment(id: string, extra: Partial<Annotation> = {}): Annotation {
  return { id, blockId: 'b', startOffset: 0, endOffset: 1, type: AnnotationType.COMMENT, text: `t${id}`, originalText: 'x', createdA: Number(id), author: 'a', ...extra };
}

describe('AnnotationPanel threading on a deep chain', () => {
  test('5,000 chained replies thread and sort in well under 100 ms, in order, dropping nothing', () => {
    const anns: Annotation[] = [comment('0')];
    for (let i = 1; i < 5000; i++) anns.push(comment(String(i), { inReplyTo: String(i - 1) }));
    const sorted = [...anns].sort((a, b) => a.createdA - b.createdA);

    const start = performance.now();
    const threaded = threadReplies(sorted);
    const rootTs = resolveThreadRootTimestamps(sorted);
    const entries = threaded.map(({ annotation, isReply }) => ({ ts: annotation.createdA, threadTs: rootTs.get(annotation.id)!, annotation, isReply }));
    entries.sort((a, b) => (a.threadTs !== b.threadTs ? a.threadTs - b.threadTs : a.ts - b.ts));
    const elapsed = performance.now() - start;

    expect(entries.length).toBe(5000);
    expect(entries[0].annotation.id).toBe('0');
    expect(entries[0].isReply).toBe(false);
    expect(entries[4999].annotation.id).toBe('4999');
    expect(entries[4999].isReply).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });
});
