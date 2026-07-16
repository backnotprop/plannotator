import { describe, test, expect } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MarkdownBody } from './MarkdownBody';

describe('MarkdownBody', () => {
  test('renders pipe tables as real tables (PR comments previously collapsed them to one line)', () => {
    const md = `Results:

| Scenario | Result |
|----------|--------|
| Render | PASS |
| Approve | PASS |
`;
    const html = renderToString(<MarkdownBody markdown={md} />);
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('Scenario');
    expect(html).toContain('Approve');
    // The old behavior inlined the raw pipes into a paragraph
    expect(html).not.toContain('| Scenario |');
  });

  test('renders escaped pipes inside cells via the shared parser', () => {
    const md = `| Name | Expr |
|------|------|
| or | a \\| b |
`;
    const html = renderToString(<MarkdownBody markdown={md} />);
    expect(html).toContain('a | b');
  });

  test('renders a lone video link as an inline player with a fallback link', () => {
    const md = '[02-annotate-approve.webm](https://github.com/o/r/releases/download/t/02.webm)';
    const html = renderToString(<MarkdownBody markdown={md} />);
    expect(html).toContain('<video');
    expect(html).toContain('controls');
    expect(html).toContain('src="https://github.com/o/r/releases/download/t/02.webm"');
    expect(html).toContain('02-annotate-approve.webm');
  });

  test('renders a bare video URL as a player too', () => {
    const html = renderToString(<MarkdownBody markdown={'https://cdn.example/demo.mp4?sig=abc'} />);
    expect(html).toContain('<video');
  });

  test('leaves non-video links and mixed paragraphs alone', () => {
    const html = renderToString(
      <MarkdownBody markdown={'See [the docs](https://example.com/page) and https://x.test/a.webm plus text'} />
    );
    expect(html).not.toContain('<video');
  });
});
