import { describe, expect, test } from 'bun:test';
import {
  annotationTargetForCallFlowRawLine,
  findCallFlowRawMatches,
  formatCallFlowInstallSize,
  getCallFlowRawLines,
  splitCallFlowFilePath,
} from './callFlowPresentation';

describe('formatCallFlowInstallSize', () => {
  test('rounds bytes up to whole megabytes', () => {
    expect(formatCallFlowInstallSize(7 * 1024 * 1024)).toBe('~7 MB');
    expect(formatCallFlowInstallSize(7 * 1024 * 1024 + 1)).toBe('~8 MB');
    expect(formatCallFlowInstallSize(1)).toBe('~1 MB');
  });
});

describe('Call Flow paths', () => {
  test('keeps the filename visible independently of a long directory', () => {
    expect(splitCallFlowFilePath('packages/review-editor/dock/panels/ReviewCallFlowPanel.tsx')).toEqual({
      directory: 'packages/review-editor/dock/panels',
      name: 'ReviewCallFlowPanel.tsx',
    });
    expect(splitCallFlowFilePath('index.ts')).toEqual({ directory: '', name: 'index.ts' });
  });
});

describe('Call Flow raw output', () => {
  test('colors only explicit CallDiff status markers and preserves every byte of text', () => {
    const raw = [
      'calldiff diff abc → def',
      '+ └─ save  src/new-file.ts:5',
      '- ├─ load  src/old-file.ts:9',
      '  └─ total(a + b)  src/context-file.ts:2',
    ].join('\n');

    const lines = getCallFlowRawLines(raw);
    expect(lines.map((line) => line.kind)).toEqual(['context', 'added', 'removed', 'context']);
    expect(lines.map((line) => line.content).join('\n')).toBe(raw);
  });

  test('finds literal matches case-insensitively across raw lines', () => {
    const lines = getCallFlowRawLines([
      '+ CallFlowTreeView({})',
      '- callflowtreeview()',
      '  total(a + b)',
    ].join('\n'));

    expect(findCallFlowRawMatches(lines, 'CallFlowTreeView')).toEqual([
      { lineIndex: 0, start: 2, end: 18 },
      { lineIndex: 1, start: 2, end: 18 },
    ]);
    expect(findCallFlowRawMatches(lines, 'a + b')).toEqual([
      { lineIndex: 2, start: 8, end: 13 },
    ]);
    expect(findCallFlowRawMatches(lines, '')).toEqual([]);
  });

  test('creates one-based review targets without inventing source locations', () => {
    const [added, removed] = getCallFlowRawLines('+ newCall()\n- oldCall()');
    expect(added && annotationTargetForCallFlowRawLine(added)).toEqual({
      treePath: 'raw:1',
      entry: 'Raw CallDiff output',
      label: '+ newCall()',
      rawLine: 1,
      side: 'new',
    });
    expect(removed && annotationTargetForCallFlowRawLine(removed)).toEqual({
      treePath: 'raw:2',
      entry: 'Raw CallDiff output',
      label: '- oldCall()',
      rawLine: 2,
      side: 'old',
    });

    const [offsetLine] = getCallFlowRawLines('+ laterCall()', 41);
    expect(offsetLine && annotationTargetForCallFlowRawLine(offsetLine)).toMatchObject({
      treePath: 'raw:41',
      rawLine: 41,
    });
  });
});
