/**
 * The plan diff card follows Settings → Plan Width like the document does:
 * Wide (null) fills the column, a number caps it, and a host that passes no
 * width keeps the old 832px card.
 */
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanDiffViewer } from './PlanDiffViewer';
import { computePlanDiff } from '../../utils/planDiffEngine';

const { blocks, stats } = computePlanDiff('# Plan\n\nOld step.\n', '# Plan\n\nNew step.\n');

function outerStyle(maxWidth?: number | null): string {
  const html = renderToStaticMarkup(
    <PlanDiffViewer
      diffBlocks={blocks}
      diffStats={stats}
      diffMode="clean"
      onDiffModeChange={() => {}}
      onPlanDiffToggle={() => {}}
      {...(maxWidth === undefined ? {} : { maxWidth })}
    />,
  );
  const outer = html.match(/^<div[^>]*>/)?.[0] ?? '';
  expect(outer).toContain('w-full');
  return outer;
}

describe('plan diff card width', () => {
  test('Wide fills the column (no cap)', () => {
    expect(outerStyle(null)).not.toContain('max-width');
  });

  test('Compact and Default keep their caps', () => {
    expect(outerStyle(832)).toContain('max-width:832px');
    expect(outerStyle(1040)).toContain('max-width:1040px');
  });

  test('a host that passes no width keeps the 832px card', () => {
    expect(outerStyle()).toContain('max-width:832px');
  });
});
