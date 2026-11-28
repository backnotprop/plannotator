import { describe, expect, test } from 'bun:test';
import { findingCountsLine, findingsOf } from './jobFindings';

describe('review agent findings on a job row', () => {
  test('counts by severity for Claude and by priority for Codex, most severe first', () => {
    expect(findingCountsLine([{ severity: 'nit' }, { severity: 'important' }, { severity: 'nit' }, { severity: 'pre_existing' }])).toBe('1 important · 2 nit · 1 pre-existing');
    expect(findingCountsLine([{ text: '[P2] Loop runs once' }, { text: '[P1] Token leaks' }, { text: '[P2] x' }])).toBe('1 P1 · 2 P2');
    expect(findingCountsLine([{ text: 'plain' }, { text: 'plain too' }])).toBe('2 findings');
    expect(findingCountsLine([])).toBe('No findings');
  });

  test('the first finding is the most severe one with a place in the diff', () => {
    const anns = [
      { id: 'general', source: 'agent-1', severity: 'important' },
      { id: 'nit', source: 'agent-1', severity: 'nit', filePath: 'a.ts', lineStart: 1 },
      { id: 'late', source: 'agent-1', severity: 'important', filePath: 'b.ts', lineStart: 40 },
      { id: 'early', source: 'agent-1', severity: 'important', filePath: 'b.ts', lineStart: 4 },
      { id: 'other-job', source: 'agent-2', severity: 'important', filePath: 'a.ts', lineStart: 1 },
    ];
    expect(findingsOf('agent-1', anns).map((a) => a.id)).toEqual(['early', 'late', 'general', 'nit']);
  });
});
