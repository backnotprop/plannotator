import { describe, expect, mock, test } from 'bun:test';
import type { AIChatEntry } from '../hooks/useAIChat';

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const { projectFileAIMarkers } = await import('./AllFilesCodeView');

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
