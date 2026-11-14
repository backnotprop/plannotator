import { describe, expect, mock, test } from 'bun:test';
import type { AIChatEntry } from '../hooks/useAIChat';
import type { CodeAnnotation } from '@plannotator/ui/types';

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const { projectFileAIMarkers, projectFileAnnotations } = await import('./AllFilesCodeView');

function makeMessage(
  id: string,
  filePath: string,
  overrides: Partial<AIChatEntry['question']> = {},
): AIChatEntry {
  return {
    question: {
      id,
      prompt: 'Explain why this deliberately long line-scoped question changed.',
      filePath,
      lineStart: 3,
      lineEnd: 5,
      side: 'new',
      createdAt: 1,
      ...overrides,
    },
    response: {
      questionId: id,
      text: 'Because the behavior changed.',
      isStreaming: false,
      createdAt: 2,
    },
  };
}

describe('projectFileAIMarkers', () => {
  test('projects only line-scoped messages for the requested file', () => {
    const target = makeMessage('target', 'src/target.ts');
    const otherFile = makeMessage('other', 'src/other.ts');
    const fileScoped = makeMessage('file-scope', 'src/target.ts', {
      lineStart: undefined,
      lineEnd: undefined,
    });

    expect(projectFileAIMarkers([target, otherFile, fileScoped], 'src/target.ts')).toEqual([
      {
        side: 'additions',
        lineNumber: 5,
        metadata: {
          annotationId: 'target',
          type: 'comment',
          kind: 'ai-marker',
          questionId: 'target',
          promptPreview: 'Explain why this deliberately long line-...',
          hasResponse: true,
          isStreaming: false,
        },
      },
    ]);
  });
});

describe('the context notes seam', () => {
  const comment = { id: 'c1', type: 'comment', filePath: 'src/target.ts', lineStart: 2, lineEnd: 4, side: 'new', text: 'Why?', createdAt: 1 } as unknown as CodeAnnotation;
  const marker = makeMessage('m1', 'src/target.ts');

  test('absent or empty: the projection is what it was without notes', () => {
    const before = projectFileAnnotations([comment], [marker], 'src/target.ts', undefined, undefined);
    expect(projectFileAnnotations([comment], [marker], 'src/target.ts', undefined, undefined, [])).toEqual(before);
    expect(before.map((a) => a.metadata.kind ?? 'annotation')).toEqual(['annotation', 'ai-marker']);
  });

  test('a note is its own kind on its last line, never a comment; comments and markers stay as they were', () => {
    const notes = [
      { id: 'n1', filePath: 'src/target.ts', side: 'new' as const, lineStart: 6, lineEnd: 8 },
      { id: 'n2', filePath: 'src/target.ts', side: 'old' as const, lineStart: 3, lineEnd: 3 },
      { id: 'n3', filePath: 'src/other.ts', side: 'new' as const, lineStart: 1, lineEnd: 1 },
    ];
    const without = projectFileAnnotations([comment], [marker], 'src/target.ts', undefined, undefined);
    const withNotes = projectFileAnnotations([comment], [marker], 'src/target.ts', undefined, undefined, notes);
    const noteItems = withNotes.filter((a) => a.metadata.kind === 'context-note');
    expect(noteItems.map((a) => [a.side, a.lineNumber, a.metadata.contextNoteId])).toEqual([['additions', 8, 'n1'], ['deletions', 3, 'n2']]);
    expect(withNotes.filter((a) => a.metadata.kind !== 'context-note')).toEqual(without);
  });
});
