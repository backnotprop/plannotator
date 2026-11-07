/**
 * Seam test: BarePathContext (LocalLinkContext.tsx), opt-in. A host that gives one draws the file paths written as
 * plain words through its own wrap, each whole (a `_` or `@` inside one does not cut it); paths in code, links and
 * markdown stay as they are. Without a host, the words render exactly as before.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InlineMarkdown } from './InlineMarkdown';
import { BarePathContext, type BarePathWrap } from './LocalLinkContext';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** A host's finder: a folder, a name with a dot-kind. */
const wrap: BarePathWrap = {
  find: (text) => [...text.matchAll(/(?:[\w@.~-]+\/)+[\w.-]+\.[a-z]{1,4}/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length })),
  wrap: (text) => (
    <button type="button" data-path={text}>
      {text}
    </button>
  ),
};

async function draw(text: string, withHost: boolean): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(withHost ? <BarePathContext.Provider value={wrap}><InlineMarkdown text={text} /></BarePathContext.Provider> : <InlineMarkdown text={text} />);
  });
  return host;
}

const paths = (el: HTMLElement) => [...el.querySelectorAll('[data-path]')].map((b) => b.getAttribute('data-path'));

describe.if(hasDom)('BarePathContext', () => {
  test('a host draws each bare path whole, underscores and @ included, and the words around it stay', async () => {
    const el = await draw('See docs/plan.md, packages/inbox/file_refs.ts and node_modules/@scope/pkg/index.js now.', true);
    expect(paths(el)).toEqual(['docs/plan.md', 'packages/inbox/file_refs.ts', 'node_modules/@scope/pkg/index.js']);
    expect(el.textContent).toBe('See docs/plan.md, packages/inbox/file_refs.ts and node_modules/@scope/pkg/index.js now.');
  });

  test('a path in a code span, a link, or emphasis markers is not the host’s', async () => {
    const el = await draw('Code `src/a.ts`, a [link to docs/b.md](docs/b.md), and **docs/c.md** in bold.', true);
    expect(paths(el)).toEqual(['docs/c.md']);
    expect(el.querySelector('code')?.textContent).toBe('src/a.ts');
    expect(el.querySelector('strong [data-path]')).not.toBeNull();
  });

  test('without a host the words render exactly as before', async () => {
    const text = 'See docs/plan.md and packages/inbox/file_refs.ts now.';
    const withHost = await draw(text, false);
    expect(paths(withHost)).toEqual([]);
    expect(withHost.innerHTML).not.toContain('button');
    expect(withHost.textContent).toBe(text);
  });
});
