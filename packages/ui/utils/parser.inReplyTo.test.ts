/**
 * `inReplyTo` in the exported feedback: a reply is grouped under its parent's
 * entry (the coding agent reads the exchange in order) and is not numbered
 * as its own entry; an export with no replies is byte-identical to the
 * pre-`inReplyTo` output, which is the additive-field guarantee.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation } from '../types';
import { exportAnnotations, parseMarkdownToBlocks } from './parser';

const PLAN = '# Plan\n\nRotate the key on every deploy.\n\nShip behind a flag.\n';
const blocks = parseMarkdownToBlocks(PLAN);

function comment(id: string, quote: string, text: string, extra: Partial<Annotation> = {}): Annotation {
  const block = blocks.find((b) => b.content.includes(quote))!;
  return {
    id, blockId: block.id, startOffset: block.content.indexOf(quote), endOffset: block.content.indexOf(quote) + quote.length,
    type: AnnotationType.COMMENT, text, originalText: quote, createdA: 1, author: 'ramos', ...extra,
  };
}

describe('exportAnnotations with inReplyTo', () => {
  test('a reply nests under its parent entry and the entry numbers stay consecutive', () => {
    const parent = comment('p', 'Rotate the key', 'This invalidates in-flight uploads.');
    const reply = comment('r', 'Rotate the key', 'Agreed, proposing a grace window.', { id: 'r', inReplyTo: 'p', author: 'tater', source: 'browser-agent', createdA: 2 });
    const later = comment('l', 'Ship behind a flag', 'Which flag?', { createdA: 3 });
    const out = exportAnnotations(blocks, [parent, reply, later]);
    expect(out).toContain('## 1. ');
    expect(out).toContain('## 2. ');
    expect(out).not.toContain('## 3. ');
    const parentAt = out.indexOf('This invalidates in-flight uploads.');
    // Deliberate pin: the `- **Reply (author):** text` line is the export
    // contract the coding agent parses a thread from; changing its shape is a
    // product decision, not a wording tweak.
    const replyAt = out.indexOf('- **Reply (tater):** Agreed, proposing a grace window.');
    const laterAt = out.indexOf('Which flag?');
    expect(parentAt).toBeGreaterThan(0);
    expect(replyAt).toBeGreaterThan(parentAt);
    expect(laterAt).toBeGreaterThan(replyAt);
    expect(out).toContain('I\'ve reviewed this plan and have 3 pieces of feedback');
  });

  test('a reply whose parent is not exported renders as an ordinary entry', () => {
    const orphan = comment('r', 'Rotate the key', 'Orphan reply', { inReplyTo: 'missing' });
    const out = exportAnnotations(blocks, [orphan]);
    expect(out).toContain('## 1. ');
    expect(out).not.toContain('**Reply');
  });

  test('without any inReplyTo the export is byte-identical to the plain export', () => {
    const a = comment('a', 'Rotate the key', 'one');
    const b = comment('b', 'Ship behind a flag', 'two', { createdA: 2 });
    const plain = exportAnnotations(blocks, [a, b]);
    const withUndefined = exportAnnotations(blocks, [{ ...a, inReplyTo: undefined }, b]);
    expect(withUndefined).toBe(plain);
    expect(plain).not.toContain('Replies');
  });
});
