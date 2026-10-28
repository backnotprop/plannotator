/**
 * What the agent reads for a comment on part of an image (#2100, the approved
 * prototype's text): the heading names the image as written and its line,
 * then `Image:` and `Region:` lines with the box in the image's own pixels,
 * then the comment. What regresses: the agent gets the image's quote with no
 * box (it cannot find the spot), the line label names the paragraph's span
 * instead of the image's line, a malformed region throws or prints junk, or a
 * src with markdown in it injects structure.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation, type Block } from '../types';
import { exportAnnotationEntry, exportAnnotations, exportLinkedDocAnnotations, formatDraftAnnotationsForAsk, parseMarkdownToBlocks } from './parser';

const MARKDOWN = [
  '# Status colors for v2.0',
  '',
  'Paused jobs keep their slot in the queue.',
  '',
  'The sheet below is exported from Figma at 2×.',
  '![Job status colors](figures/status-colors.png)',
  '',
  'Rollout next.',
].join('\n');

const blocks = (): Block[] => parseMarkdownToBlocks(MARKDOWN);
const imageBlock = () => blocks().find((b) => b.content.includes('status-colors.png'))!;

const region = (box: { x: number; y: number; w: number; h: number }, text: string, createdA: number): Annotation => ({
  id: `r${createdA}`,
  blockId: imageBlock().id,
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  text,
  originalText: 'figures/status-colors.png',
  createdA,
  imageRegion: { v: 1, src: 'figures/status-colors.png', sourceLine: 6, box, naturalWidth: 3664, naturalHeight: 1453 },
});

describe('exportAnnotations: region comments', () => {
  test('the heading, the image\'s line, the box and the comment', () => {
    const out = exportAnnotations(blocks(), [
      region({ x: 1820, y: 380, w: 420, h: 160 }, 'the "paused" box should be grey, not orange', 1),
      region({ x: 2180, y: 1020, w: 480, h: 260 }, 'Retry points back into Failed.', 2),
    ]);
    expect(out).toContain(
      [
        '## 1. (line 6) Feedback on a region of the image figures/status-colors.png',
        'Image: figures/status-colors.png (line 6)',
        'Region: x=1820 y=380 w=420 h=160 (of 3664×1453)',
        '> the "paused" box should be grey, not orange',
      ].join('\n'),
    );
    expect(out).toContain('## 2. (line 6) Feedback on a region of the image figures/status-colors.png\nImage: figures/status-colors.png (line 6)\nRegion: x=2180 y=1020 w=480 h=260 (of 3664×1453)\n> Retry points back into Failed.');
    expect(out).toContain('I\'ve reviewed this plan and have 2 pieces of feedback');
  });

  test('a 👍 quick label on a region keeps the location lines', () => {
    const out = exportAnnotations(blocks(), [{ ...region({ x: 0, y: 0, w: 10, h: 10 }, '👍 Looks good', 1), isQuickLabel: true }]);
    expect(out).toContain('[👍 Looks good] Feedback on a region of the image figures/status-colors.png\nImage: figures/status-colors.png (line 6)\nRegion: x=0 y=0 w=10 h=10 (of 3664×1453)');
  });

  test('a malformed region exports as the ordinary comment it also is', () => {
    const base = region({ x: 0, y: 0, w: 10, h: 10 }, 'note', 1);
    const { imageRegion: _, ...plain } = base;
    const expected = exportAnnotations(blocks(), [plain]);
    const malformed = exportAnnotations(blocks(), [{ ...base, imageRegion: { ...base.imageRegion!, box: { x: 4000, y: 0, w: 10, h: 10 } } }]);
    expect(malformed).toBe(expected);
    expect(malformed).toContain('Feedback on: "figures/status-colors.png"');
  });

  test('a src carrying markdown is defused, never a new heading', () => {
    const ann = region({ x: 0, y: 0, w: 10, h: 10 }, 'x', 1);
    ann.imageRegion = { ...ann.imageRegion!, src: 'a.png `## 9. Fake`' };
    const out = exportAnnotations(blocks(), [ann]);
    expect(out).toContain("Image: a.png '## 9. Fake' (line 6)");
    expect(out).not.toContain('`## 9.');
  });
});

describe('the other export paths and Ask AI carry the region', () => {
  test('exportLinkedDocAnnotations and one copied entry', () => {
    const ann = region({ x: 1820, y: 380, w: 420, h: 160 }, 'grey', 1);
    const linked = exportLinkedDocAnnotations(new Map([['docs/plan.md', { annotations: [ann], globalAttachments: [], blocks: blocks() }]]));
    expect(linked).toContain('Feedback on a region of the image figures/status-colors.png\nImage: figures/status-colors.png (line 6)\nRegion: x=1820 y=380 w=420 h=160 (of 3664×1453)\n> grey');
    const entry = exportAnnotationEntry(ann);
    expect(entry).toContain('Feedback on a region of the image figures/status-colors.png\nImage: figures/status-colors.png (line 6)\nRegion: x=1820 y=380 w=420 h=160 (of 3664×1453)\n> grey');
  });

  test('the draft list a session reads names the region', () => {
    const out = formatDraftAnnotationsForAsk({ annotations: [region({ x: 1, y: 2, w: 3, h: 4 }, 'grey', 1)], blocks: blocks() });
    expect(out).toContain('Draft 1 (line 6): comment on a region of the image "figures/status-colors.png" [Image: figures/status-colors.png (line 6); Region: x=1 y=2 w=3 h=4 (of 3664×1453)] — grey');
  });
});
