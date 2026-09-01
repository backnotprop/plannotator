import { describe, expect, test } from 'bun:test';

const hasDom = typeof document !== 'undefined';
const mod = hasDom ? await import('./renderedText') : null;
const renderMarkdownToText = mod?.renderMarkdownToText as
  typeof import('./renderedText')['renderMarkdownToText'];

describe('renderMarkdownToText', () => {
  // Each row is a quote an agent can legitimately take from `/api/plan` (which
  // serves markdown SOURCE) paired with what the page actually shows. The
  // point of the function is that the second column is produced by the real
  // renderer rather than guessed at, so these are the divergences that used to
  // need a regex rung each.
  const cases: [string, string, string][] = [
    ['**Install** now', 'Install now', 'emphasis is consumed'],
    ['Setup `bun`', 'Setup bun', 'code span delimiters are consumed'],
    ['[Deployment](./s.md) guide', 'Deployment guide', 'link target is consumed'],
    ['Part 1 --- end', 'Part 1 — end', 'smart punctuation is applied'],
    ['ship it :rocket:', 'ship it 🚀', 'emoji shortcodes are expanded'],
    ['plain sentence', 'plain sentence', 'text with no markup renders to itself'],
    [
      '| a | `JIRA_*` |',
      'aJIRA_*',
      'table pipes vanish, and a code span keeps the `_*` a stripper would eat',
    ],
    ['- item one', 'item one', 'the bullet is drawn, not document text'],
    ['5. item five', 'item five', 'the ordered numeral is drawn, not document text'],
  ];

  for (const [source, rendered, label] of cases) {
    test.skipIf(!hasDom)(label, () => {
      expect(renderMarkdownToText(source)).toBe(rendered);
    });
  }

  test.skipIf(!hasDom)('table cells are joined the way sibling <td>s are: with nothing', () => {
    // Not cosmetic. The document DOM has no text between cells either, so a
    // needle that inserted a space here would never match.
    expect(renderMarkdownToText('| left | right |')).toBe('leftright');
  });

  test.skipIf(!hasDom)('empty source has no rendering', () => {
    expect(renderMarkdownToText('')).toBeNull();
  });
});
