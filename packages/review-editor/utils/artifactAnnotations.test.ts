import { describe, expect, it } from 'bun:test';
import type { CommentAnnotation } from '@plannotator/ui/types';
import {
  artifactAnchorLabel,
  commentAnnotationAsDocument,
  formatArtifactTimestamp,
} from './artifactAnnotations';

describe('artifact annotations', () => {
  it('formats short and hour-long video timestamps', () => {
    expect(formatArtifactTimestamp(83.9)).toBe('1:23');
    expect(formatArtifactTimestamp(3661.2)).toBe('1:01:01');
    expect(formatArtifactTimestamp(-3)).toBe('0:00');
  });

  it('describes normalized image points without leaking raw decimals', () => {
    expect(artifactAnchorLabel({ kind: 'image', x: 0.246, y: 0.404 })).toBe(
      'Pin at 25%, 40%',
    );
  });

  it('projects comment-backed document anchors into the shared highlighter shape', () => {
    const annotation: CommentAnnotation = {
      id: 'artifact-quote',
      commentId: 'source-comment',
      commentAuthor: 'alice',
      commentBody: '[Report](https://example.com/report.md)',
      text: 'Clarify this sentence.',
      createdAt: 42,
      artifact: {
        artifactId: 'report',
        artifactName: 'Report',
        artifactUrl: 'https://example.com/report.md',
        artifactKind: 'markdown',
        sourceUrl: 'https://github.com/acme/repo/pull/1#issuecomment-1',
        anchor: {
          kind: 'document',
          originalText: 'The important sentence.',
          blockId: 'block-2',
          startOffset: 4,
          endOffset: 27,
          startMeta: { parentTagName: 'P', parentIndex: 1, textOffset: 4 },
          endMeta: { parentTagName: 'P', parentIndex: 1, textOffset: 27 },
        },
      },
    };

    expect(commentAnnotationAsDocument(annotation)).toMatchObject({
      id: 'artifact-quote',
      blockId: 'block-2',
      startOffset: 4,
      endOffset: 27,
      originalText: 'The important sentence.',
      text: 'Clarify this sentence.',
      artifact: annotation.artifact,
    });
  });

  it('does not project non-document anchors into the text highlighter', () => {
    const annotation: CommentAnnotation = {
      id: 'video-note',
      commentId: 'source-comment',
      commentAuthor: 'alice',
      commentBody: 'Video',
      text: 'Pause here.',
      createdAt: 42,
      artifact: {
        artifactId: 'video',
        artifactName: 'Video',
        artifactUrl: 'https://example.com/demo.webm',
        artifactKind: 'video',
        sourceUrl: 'https://github.com/acme/repo/pull/1',
        anchor: { kind: 'video', timestamp: 2.5 },
      },
    };

    expect(commentAnnotationAsDocument(annotation)).toBeNull();
  });
});
