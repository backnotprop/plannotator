/**
 * RenderedMarkdown's optional host seams (`resolveLocalLink`, `resolveImage`,
 * `headingAnchors`) must leave a host that passes none of them EXACTLY where
 * it was: the same DOM as rendering the blocks straight through BlockRenderer
 * (the component's body before the seams existed), raw-HTML media included,
 * and an enclosing LocalLinkContext provider still applies.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RenderedMarkdown } from './RenderedMarkdown';
import { BlockRenderer } from './BlockRenderer';
import { LocalLinkContext } from './LocalLinkContext';
import { computeListIndices, groupBlocks, parseMarkdownToBlocks } from '../utils/parser';

const hasDom = typeof document !== 'undefined';

const DOC = [
  '# Title',
  '',
  'A [local doc](notes.md), a [web link](https://example.com), an [anchor](#title) and ![shot](img/a.png).',
  '',
  '- one',
  '- two',
  '',
  '<p><a href="other.md">raw link</a> <img src="img/b.png" srcset="img/b@2x.png 2x" alt="raw"></p>',
  '',
  '<picture><source srcset="img/dark.png"><img src="img/light.png" alt="themed"></picture>',
  '',
  '<video src="clip.mp4" poster="poster.png" controls></video>',
  '',
  '## Title',
  '',
].join('\n');

/** RenderedMarkdown's body as it was before the host seams. */
function Baseline({ markdown, className }: { markdown: string; className?: string }) {
  const groups = groupBlocks(parseMarkdownToBlocks(markdown));
  return (
    <div className={className}>
      {groups.map((group) =>
        group.type === 'list-group' ? (
          (() => {
            const indices = computeListIndices(group.blocks);
            return (
              <div key={group.key}>
                {group.blocks.map((block, i) => (
                  <BlockRenderer key={block.id} block={block} orderedIndex={indices[i]} />
                ))}
              </div>
            );
          })()
        ) : (
          <BlockRenderer key={group.block.id} block={group.block} />
        ),
      )}
    </div>
  );
}

describe.if(hasDom)('RenderedMarkdown host seams (DOM)', () => {
  let roots: Root[] = [];
  let hosts: HTMLElement[] = [];

  async function render(node: React.ReactElement): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    hosts.push(host);
    await act(async () => {
      root.render(node);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    return host;
  }

  afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount());
    for (const host of hosts) host.remove();
    roots = [];
    hosts = [];
  });

  test('a host passing no seam renders exactly as before', async () => {
    const before = await render(<Baseline markdown={DOC} className="md-compact" />);
    const after = await render(<RenderedMarkdown markdown={DOC} className="md-compact" />);
    expect(after.innerHTML).toBe(before.innerHTML);
    // Raw-HTML media untouched: srcset, <source> and <video> stay.
    expect(after.querySelector('img[srcset]')).not.toBeNull();
    expect(after.querySelector('picture source')).not.toBeNull();
    expect(after.querySelector('video')).not.toBeNull();
    expect(after.querySelector('h1')?.hasAttribute('id')).toBe(false);
  });

  test('an enclosing LocalLinkContext still applies when resolveLocalLink is absent', async () => {
    const el = await render(
      <LocalLinkContext.Provider value={() => ({ kind: 'unavailable', title: 'From the outer host' })}>
        <RenderedMarkdown markdown={DOC} />
      </LocalLinkContext.Provider>,
    );
    const inert = Array.from(el.querySelectorAll('[data-local-link="unavailable"]')).find((n) => n.textContent === 'local doc');
    expect(inert?.getAttribute('title')).toBe('From the outer host');
  });

  test('headingAnchors gives headings deduplicated slug ids', async () => {
    const el = await render(<RenderedMarkdown markdown={DOC} headingAnchors />);
    expect(Array.from(el.querySelectorAll('h1, h2')).map((h) => h.id)).toEqual(['title', 'title-1']);
  });
});
