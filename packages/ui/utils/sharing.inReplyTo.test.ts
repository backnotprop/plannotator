/**
 * Share-URL contract for threaded replies: like element anchors and
 * multi-select targets, `inReplyTo` is deliberately NOT carried by the
 * compact tuple format. A reply shares as a plain comment on the same
 * quote, which is the existing text-restore contract. Documented choice,
 * pinned here so a future "helpful" addition is a deliberate one.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation } from '../types';
import { fromShareable, toShareable } from './sharing';

const PARENT: Annotation = {
  id: 'p', blockId: 'blk-a', startOffset: 0, endOffset: 5, type: AnnotationType.COMMENT,
  text: 'Parent', originalText: 'quote', createdA: 1, author: 'ramos',
};
const REPLY: Annotation = { ...PARENT, id: 'r', text: 'Reply', author: 'tater', source: 'browser-agent', inReplyTo: 'p', createdA: 2 };

describe('sharing and inReplyTo', () => {
  test('toShareable drops inReplyTo and the round trip restores the reply as a plain comment on the same quote', () => {
    const shareable = toShareable([PARENT, REPLY]);
    expect(JSON.stringify(shareable)).not.toContain('inReplyTo');
    const restored = fromShareable(shareable);
    expect(restored.length).toBe(2);
    expect(restored[1]!.originalText).toBe('quote');
    expect(restored[1]!.text).toBe('Reply');
    expect(restored[1]!.inReplyTo).toBeUndefined();
  });
});
