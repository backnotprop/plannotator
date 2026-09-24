import { describe, expect, test } from 'bun:test';
import { resolveAnnotateInstructionsSurface } from './annotateAgentInstructions';

// The surface decides which read command and targeting rules the agent gets;
// a wrong pick hands it instructions that do not work for the session (e.g.
// `.plan`, which is empty for HTML, live-app and folder sessions).
describe('resolveAnnotateInstructionsSurface', () => {
  test('a live app wins over its HTML render', () => {
    expect(resolveAnnotateInstructionsSurface({ liveApp: true, annotateSource: 'file', renderAs: 'html' })).toBe('live-app');
  });

  test('a folder session stays a folder whatever file type is open', () => {
    for (const renderAs of ['markdown', 'html', 'mermaid']) {
      expect(resolveAnnotateInstructionsSurface({ liveApp: false, annotateSource: 'folder', renderAs })).toBe('folder');
    }
  });

  test('single-file sessions follow the render kind', () => {
    const pick = (renderAs: string) => resolveAnnotateInstructionsSurface({ liveApp: false, annotateSource: 'file', renderAs });
    expect(pick('html')).toBe('html');
    expect(pick('mermaid')).toBe('diagram');
    expect(pick('graphviz')).toBe('diagram');
    expect(pick('markdown')).toBe('markdown');
  });

  test('annotate-last is a message session', () => {
    expect(resolveAnnotateInstructionsSurface({ liveApp: false, annotateSource: 'message', renderAs: 'markdown' })).toBe('message');
  });
});
