import { describe, expect, test } from 'bun:test';
import type { CodeAnnotation } from '@plannotator/ui/types';
import {
  buildExplainFindingPrompt,
  buildExplainFindingRequest,
  isAgentGeneratedFinding,
} from './explainFinding';

const finding: CodeAnnotation = {
  id: 'finding-1',
  type: 'comment',
  filePath: 'src/rules.ts',
  lineStart: 12,
  lineEnd: 16,
  side: 'new',
  text: 'The fallback creates history entries that were not returned by the API.',
  reasoning: 'The empty API response is replaced with form metadata.',
  createdAt: 1,
  source: 'agent-12345678',
};

describe('buildExplainFindingPrompt', () => {
  test('requests an independent learning assessment and a conditional recommendation', () => {
    const prompt = buildExplainFindingPrompt(finding);

    expect(prompt).toContain('Independently assess whether this review finding is valid');
    expect(prompt).toContain('valid, invalid, partially valid, or uncertain');
    expect(prompt).toContain('learning-oriented walkthrough');
    expect(prompt).toContain('concrete impact if valid');
    expect(prompt).toContain('If the finding is valid or partially valid');
    expect(prompt).toContain('brief recommended fix when possible');
    expect(prompt).toContain(`Review finding:\n${finding.text}`);
    expect(prompt).toContain(`Review agent context:\n${finding.reasoning}`);
  });
});

describe('isAgentGeneratedFinding', () => {
  test('accepts review-job findings without exposing the action on other annotations', () => {
    expect(isAgentGeneratedFinding({ source: 'agent-12345678' })).toBe(true);
    expect(isAgentGeneratedFinding({ source: 'eslint' })).toBe(false);
    expect(isAgentGeneratedFinding({})).toBe(false);
  });
});

describe('buildExplainFindingRequest', () => {
  test('targets the finding range without relying on the current line selection', () => {
    const patch = [
      '@@ -10,3 +10,3 @@',
      ' unchanged',
      '-old fallback',
      '+new fallback',
      ' trailing',
    ].join('\n');

    expect(buildExplainFindingRequest({ ...finding, lineStart: 11, lineEnd: 11 }, patch)).toEqual({
      prompt: buildExplainFindingPrompt(finding),
      filePath: 'src/rules.ts',
      lineStart: 11,
      lineEnd: 11,
      side: 'new',
      selectedCode: 'new fallback',
    });
  });

  test('preserves file and general finding scopes', () => {
    expect(buildExplainFindingRequest({ ...finding, scope: 'file' })).toEqual({
      prompt: buildExplainFindingPrompt(finding),
      filePath: 'src/rules.ts',
    });
    expect(buildExplainFindingRequest({ ...finding, scope: 'general' })).toEqual({
      prompt: buildExplainFindingPrompt(finding),
    });
  });
});
