import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation } from '../types';
import { compress, decompress, fromShareable, toShareable, type ShareableAnnotation, type SharePayload } from './sharing';

const LABEL: Annotation = {
  id: 'l', blockId: 'blk-a', startOffset: 0, endOffset: 5, type: AnnotationType.COMMENT,
  text: '🔍 Verify this', originalText: 'three retries', createdA: 1,
  isQuickLabel: true, quickLabelTip: 'Verify by reading the actual code before proceeding.',
};

describe('sharing quick labels', () => {
  test('a new link carries the label tip through the compressed payload', async () => {
    const hash = await compress({ p: '# Plan', a: toShareable([LABEL]) });
    const payload = (await decompress(hash)) as SharePayload;
    const [restored] = fromShareable(payload.a);
    expect(restored!.isQuickLabel).toBe(true);
    expect(restored!.text).toBe('🔍 Verify this');
    expect(restored!.quickLabelTip).toBe('Verify by reading the actual code before proceeding.');
  });

  test('a link encoded before the tip slot still decodes to the same label', async () => {
    const old: ShareableAnnotation[] = [['C', 'three retries', '🔍 Verify this', null, undefined, 1]];
    const payload = (await decompress(await compress({ p: '# Plan', a: old }))) as SharePayload;
    const [restored] = fromShareable(payload.a);
    expect(restored!.isQuickLabel).toBe(true);
    expect(restored!.text).toBe('🔍 Verify this');
    expect(restored!.originalText).toBe('three retries');
    expect(restored).not.toHaveProperty('quickLabelTip');
  });

  test('a label without a tip, and a plain comment, encode exactly as before', () => {
    const tipless = { ...LABEL, quickLabelTip: undefined };
    const plain: Annotation = { ...LABEL, isQuickLabel: undefined, text: 'my words' };
    expect(toShareable([tipless])[0]).toHaveLength(6);
    expect(toShareable([plain])[0]).toHaveLength(5);
  });
});
