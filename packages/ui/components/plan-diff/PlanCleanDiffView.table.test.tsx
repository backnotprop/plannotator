/**
 * Tables in the plan diff's clean view use the same row parser as the plan.
 *
 * What regresses if this fails: a table indented under a list item (or a tab,
 * or a list inside a quote) shows each header one column right of its values
 * in the plan diff, over an empty first header cell, while the plan itself
 * shows it right.
 */
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanCleanDiffView } from './PlanCleanDiffView';
import { computePlanDiff } from '../../utils/planDiffEngine';

function cells(html: string, tag: 'th' | 'td'): string[] {
  return Array.from(html.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'g')), (m) =>
    m[1]!.replace(/<[^>]+>/g, ''),
  );
}

/** The clean diff of a plan whose table is unchanged and whose closing line changed. */
function renderTable(table: string): string {
  const { blocks } = computePlanDiff(`${table}\n\nOld closing line.\n`, `${table}\n\nNew closing line.\n`);
  return renderToStaticMarkup(<PlanCleanDiffView blocks={blocks} wordLevel={false} />);
}

describe('PlanCleanDiffView tables', () => {
  test('an ordinary table renders its headers over its columns', () => {
    const html = renderTable(['| Name | Value |', '| --- | --- |', '| alpha | 1 |'].join('\n'));
    expect(cells(html, 'th')).toEqual(['Name', 'Value']);
    expect(cells(html, 'td')).toEqual(['alpha', '1']);
  });

  const nested: Record<string, string> = {
    'under a list item': ['- Results:', '', '  | Name | Value |', '  | --- | --- |', '  | alpha | 1 |'].join('\n'),
    'under a tab indent': ['\t| Name | Value |', '\t| --- | --- |', '\t| alpha | 1 |'].join('\n'),
    'under a list inside a quote': ['> - Results:', '>', '>   | Name | Value |', '>   | --- | --- |', '>   | alpha | 1 |'].join(
      '\n',
    ),
  };
  for (const [where, markdown] of Object.entries(nested)) {
    test(`a table ${where} gets no empty header cell`, () => {
      const html = renderTable(markdown);
      expect(cells(html, 'th')).toEqual(['Name', 'Value']);
      expect(cells(html, 'td')).toEqual(['alpha', '1']);
    });
  }
});
