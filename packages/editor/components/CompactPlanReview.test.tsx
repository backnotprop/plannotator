import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CompactPlanCompletion, CompactPlanReview } from './CompactPlanReview';

describe('compact Plan completion', () => {
  test('keeps the handoff in document flow with one explicit review action', () => {
    const html = renderToStaticMarkup(
      <CompactPlanCompletion
        feedbackSummary="Two annotations are ready."
        maxWidth={832}
        onOpenReview={() => {}}
      />,
    );

    expect(html).toContain('data-pn-compact-plan-completion="true"');
    expect(html).toContain('Ready to finish?');
    expect(html).toContain('Review and finish');
    expect(html).toContain('pn-compact-plan-review-trigger');
    expect(html).toContain('--pn-safe-bottom');
  });

  test('promotes one incumbent decision without duplicating decision logic', () => {
    const html = renderToStaticMarkup(
      <CompactPlanReview
        feedbackSummary="One annotation is ready."
        actions={[
          { id: 'exit', label: 'Close session', onSelect: () => {} },
          { id: 'feedback', label: 'Send feedback', onSelect: () => {} },
          { id: 'approve', label: 'Approve', onSelect: () => {} },
        ]}
        primaryActionId="feedback"
        onOpenAnnotations={() => {}}
      />,
    );

    expect(html).toContain('Review annotations');
    expect(html).toContain('data-pn-compact-review-action="feedback"');
    expect(html).toContain('bg-primary text-primary-foreground');
    expect(html.indexOf('Send feedback')).toBeLessThan(html.indexOf('Approve'));
    expect(html.indexOf('Approve')).toBeLessThan(html.indexOf('Close session'));
  });
});
