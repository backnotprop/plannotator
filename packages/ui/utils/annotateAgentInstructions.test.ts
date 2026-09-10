import { describe, expect, test } from 'bun:test';
import { buildAnnotateAgentInstructions } from './annotateAgentInstructions';

describe('buildAnnotateAgentInstructions', () => {
  const origin = 'http://localhost:54321';

  test('targets a single document with plan-shaped inline and global annotations', () => {
    const instructions = buildAnnotateAgentInstructions(origin, {
      source: 'file',
      filePath: '/workspace/docs/plan.md',
    });

    expect(instructions).toContain(`Base URL: ${origin}`);
    expect(instructions).toContain('/workspace/docs/plan.md');
    expect(instructions).toContain('`"annotate"` or `"annotate-last"`');
    expect(instructions).toContain('"type": "COMMENT"');
    expect(instructions).toContain('"type": "GLOBAL_COMMENT"');
    expect(instructions).toContain('"originalText": "exact text copied from the document"');
  });

  test('describes annotate-last as an agent message', () => {
    const instructions = buildAnnotateAgentInstructions(origin, {
      source: 'message',
    });

    expect(instructions).toContain('agent message open in this Annotate session');
    expect(instructions).toContain(`${origin}/api/plan`);
  });

  test('limits folder sessions to file-labelled global comments', () => {
    const instructions = buildAnnotateAgentInstructions(origin, {
      source: 'folder',
      filePath: '/workspace/docs/architecture.md',
    });

    expect(instructions).toContain('`"annotate-folder"`');
    expect(instructions).toContain('/workspace/docs/architecture.md');
    expect(instructions).toContain('cannot currently bind an inline highlight');
    expect(instructions).toContain('Do not submit `COMMENT` annotations');
    expect(instructions).toContain('"type": "GLOBAL_COMMENT"');
    expect(instructions).not.toContain('"type": "COMMENT"');
  });

  test('forbids finalizing the session or clearing other annotations', () => {
    const instructions = buildAnnotateAgentInstructions(origin, {
      source: 'file',
    });

    expect(instructions).toContain('Do not call `/api/feedback`, `/api/approve`, or `/api/exit`');
    expect(instructions).toContain('Never clear all annotations');
    expect(instructions).toContain(`DELETE "${origin}/api/external-annotations?source=gpt-live"`);
  });
});
