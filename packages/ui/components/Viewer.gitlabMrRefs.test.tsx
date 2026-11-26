/**
 * Plan review and annotate pass the session's repo to the Viewer (`repoInfo`),
 * so a GitLab project's `!123` links to its merge request there, as its `#123`
 * links to the issue. What this catches: the `!` form dropped from the plan
 * document, or read inside code (`if (!1)` in a code span or block is code), or
 * linked on a GitHub project, where `!123` is no ref.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { Viewer } = (hasDom ? await import('./Viewer') : {}) as typeof import('./Viewer');
const { parseMarkdownToBlocks } = (hasDom ? await import('../utils/parser') : {}) as typeof import('../utils/parser');

const PLAN = ['# Plan', '', 'Lands after !123 and #7; guard with `if (!1)` first.', '', '```js', 'if (!2) return;', '```'].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(repoInfo: { display: string; host: string; branch: string }): Promise<string[][]> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <Viewer
        blocks={parseMarkdownToBlocks(PLAN, { frontmatter: false })}
        markdown={PLAN}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        repoInfo={repoInfo}
      />,
    );
  });
  return [...host.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => [a.textContent ?? '', a.getAttribute('href') ?? '']);
}

test.skipIf(!hasDom)("a GitLab project's plan links !123 to its merge request; !1 in code stays code", async () => {
  const links = await render({ display: 'harbor-group/harbor', host: 'gitlab.harbor.dev', branch: 'main' });
  expect(links).toEqual([
    ['!123', 'https://gitlab.harbor.dev/harbor-group/harbor/-/merge_requests/123'],
    ['#7', 'https://gitlab.harbor.dev/harbor-group/harbor/-/issues/7'],
  ]);
  expect(host!.querySelector('code')?.textContent).toBe('if (!1)');
  expect(host!.textContent).toContain('if (!2) return;');
});

test.skipIf(!hasDom)("a GitHub project's plan links only the #7", async () => {
  const links = await render({ display: 'fern/fern-api', host: 'github.com', branch: 'main' });
  expect(links).toEqual([['#7', 'https://github.com/fern/fern-api/issues/7']]);
  expect(host!.textContent).toContain('Lands after !123 and #7');
});
