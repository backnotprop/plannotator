import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApproveButton, ExitButton, FeedbackButton } from './ToolbarButtons';

const noop = () => undefined;

describe('ToolbarButtons responsive labels', () => {
  test('preserves the existing medium breakpoint by default', () => {
    const html = renderToStaticMarkup(
      <>
        <FeedbackButton onClick={noop} shortLabel="Send" />
        <ApproveButton onClick={noop} />
        <ExitButton onClick={noop} />
      </>,
    );

    expect(html).toContain('hidden md:inline lg:hidden');
    expect(html).toContain('hidden lg:inline');
    expect(html).toContain('md:hidden');
  });

  test('can remain compact until the large breakpoint', () => {
    const html = renderToStaticMarkup(
      <>
        <FeedbackButton onClick={noop} shortLabel="Post" labelBreakpoint="lg" />
        <ApproveButton onClick={noop} labelBreakpoint="lg" />
        <ExitButton onClick={noop} labelBreakpoint="lg" />
      </>,
    );

    expect(html).toContain('hidden lg:inline xl:hidden');
    expect(html).toContain('hidden xl:inline');
    expect(html).toContain('lg:hidden');
    expect(html).toContain('aria-label="Close session without sending feedback"');
    expect(html).toContain('lucide-x');
  });
});
