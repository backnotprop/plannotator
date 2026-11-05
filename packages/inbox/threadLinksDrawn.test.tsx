/**
 * The list reads message text with its own small scanner (threadLinks.ts); the
 * message draws it with `ui`'s renderer. This holds the two together: for a
 * body with every shape of link and non-link, the web links the real Viewer
 * draws are exactly the links the list finds. What this catches: the renderer
 * learning a new link form (or dropping one) with the list left behind.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { linksOfBody } from './threadLinks';

const hasDom = typeof document !== 'undefined';
const { Viewer } = (hasDom ? await import('@plannotator/ui/components/Viewer') : {}) as typeof import('@plannotator/ui/components/Viewer');
const { parseMarkdownToBlocks } = (hasDom ? await import('@plannotator/ui/utils/parser') : {}) as typeof import('@plannotator/ui/utils/parser');

const repo = { display: 'acme/web', host: 'github.com' };
const noop = () => {};

const BODY = [
  '# Heading with https://heading.example.com',
  '',
  'Written [the docs](https://docs.example.com/a), auto <https://auto.example.com>, bare https://bare.example.com/x, trailing https://dot.example.com. And (https://paren.example.com).',
  '',
  'Marks: **https://bold.example.com** *https://em.example.com* ~~https://del.example.com~~ _https://under.example.com_ **[w](https://boldword.example.com)**',
  '',
  'Parens https://en.example.org/wiki/Function_(mathematics) and [w](https://en.example.org/a_(b)).',
  '',
  'Refs #12, other/lib#7, #0012, a1#3, #fff and #abc123, path/to/file.md#2.',
  '',
  'Reference [style][ref].',
  '',
  '[ref]: https://reference.example.com',
  '',
  '> quoted https://quote.example.com',
  '',
  '- item https://item.example.com',
  '  - nested [w](https://nested.example.com)',
  '- [ ] task https://task.example.com',
  '',
  '1. ordered https://ordered.example.com',
  '',
  '| a | b |',
  '|---|---|',
  '| https://cell.example.com | [z](https://cell2.example.com) |',
  '',
  '<div><a href="https://html.example.com/p">page</a></div>',
  '',
  ':::note',
  'In a callout https://callout.example.com',
  ':::',
  '',
  ':::question',
  'Which one? See https://question.example.com',
  '',
  '- [ ] A',
  '- [ ] B',
  ':::',
  '',
  'Not links:',
  '',
  'Span `https://span.example.com` and image ![shot](https://img.example.com/a.png) and <!-- https://comment.example.com --> done, xhttps://glued.example.com, \\[escaped](https://esc.example.com).',
  '',
  '```sh',
  'curl https://fence.example.com',
  '```',
  '',
  '[spec](docs/spec.md) [mail](mailto:a@example.com) @someone',
].join('\n');

const web = (hrefs: string[]) => [...new Set(hrefs)].filter((h) => /^https?:/i.test(h)).sort();

test.skipIf(!hasDom)('the list finds exactly the web links the message draws', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <Viewer
        blocks={parseMarkdownToBlocks(BODY, { frontmatter: false })}
        markdown={BODY}
        annotations={[]}
        onAddAnnotation={noop}
        onSelectAnnotation={noop}
        selectedAnnotationId={null}
        allowImages={false}
        mode="selection"
        taterMode={false}
        maxWidth={null}
        stickyActions={false}
        disableCodePathValidation
        refRepo={repo}
        readOnly
      />,
    );
  });
  // Drawn as links and left out on purpose: a person's @name, and a number no issue can have (#0012).
  const leftOut = ['https://github.com/someone', 'https://github.com/acme/web/issues/0012'];
  const drawn = web([...host.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!)).filter((h) => !leftOut.includes(h));
  await act(async () => root.unmount());
  host.remove();
  // Not vacuous: the renderer really drew them.
  expect(drawn.length).toBeGreaterThan(20);
  expect(web(linksOfBody(BODY, repo).map((l) => l.href))).toEqual(drawn);
});
