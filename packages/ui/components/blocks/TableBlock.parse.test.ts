/**
 * How a table block's markdown splits into header cells and body cells.
 *
 * What regresses if this fails: a table indented under a list item renders its
 * header row one column right of its body (the header gains an empty first
 * cell), so every header sits over the wrong values.
 */
import { describe, expect, test } from 'bun:test';
import { parseTableContent } from './TableBlock';
import { parseMarkdownToBlocks } from '../../utils/parser';

describe('parseTableContent', () => {
  test('an indented table keeps its header cells over their columns', () => {
    const { headers, rows } = parseTableContent(
      ['  | Name | Value |', '  | --- | --- |', '  | alpha | 1 |'].join('\n'),
    );
    expect(headers).toEqual(['Name', 'Value']);
    expect(rows).toEqual([['alpha', '1']]);
  });

  test('trailing whitespace after the closing pipe adds no empty header cell', () => {
    const { headers } = parseTableContent(['| Name | Value |  ', '| --- | --- |'].join('\n'));
    expect(headers).toEqual(['Name', 'Value']);
  });

  test('a table nested under a list item parses to aligned headers and rows', () => {
    const markdown = [
      '- Results:',
      '',
      '  | Name | Value |',
      '  | --- | --- |',
      '  | alpha | 1 |',
      '  | beta | 2 |',
    ].join('\n');
    const table = parseMarkdownToBlocks(markdown).find((block) => block.type === 'table');
    expect(table).toBeDefined();
    const { headers, rows } = parseTableContent(table!.content);
    expect(headers).toEqual(['Name', 'Value']);
    expect(rows).toEqual([
      ['alpha', '1'],
      ['beta', '2'],
    ]);
  });
});
