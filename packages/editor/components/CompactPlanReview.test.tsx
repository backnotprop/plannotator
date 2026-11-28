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

  test('follows the document: capped like it, or uncapped when Wide fills the space', () => {
    const capped = renderToStaticMarkup(
      <CompactPlanCompletion feedbackSummary="" maxWidth={1040} onOpenReview={() => {}} />,
    );
    const filling = renderToStaticMarkup(
      <CompactPlanCompletion feedbackSummary="" maxWidth={null} onOpenReview={() => {}} />,
    );

    expect(capped).toContain('max-width:1040px');
    expect(filling).not.toContain('max-width');
    expect(filling).toContain('w-full');
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
