/**
 * The linked-document "Viewing / Back to …" header lives inside the table of
 * contents. A raw-HTML document is never parsed into blocks, so it has no TOC
 * entries at all — and the component used to render nothing in that case,
 * which left a linked HTML document with no visible way back to the root.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Block } from '../types';

const hasDom = typeof document !== 'undefined';
const tocModule = hasDom ? await import('./TableOfContents') : null;

const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

async function mount(props: Record<string, unknown>) {
  const TableOfContents = tocModule!.TableOfContents;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <TableOfContents
        blocks={[]}
        annotations={[]}
        activeId={null}
        onNavigate={() => {}}
        {...props}
      />,
    );
  });
  return host;
}

const HEADING: Block = {
  id: 'h-1',
  type: 'heading',
  content: 'Chapter',
  level: 1,
  order: 0,
  startLine: 0,
};

describe.if(hasDom)('TableOfContents linked-document header', () => {
  test('a heading-less linked document still offers the way back', async () => {
    let backs = 0;
    const host = await mount({
      linkedDocFilepath: '/site/01-entry-point.html',
      onLinkedDocBack: () => { backs += 1; },
      backLabel: 'file',
    });
    const button = host.querySelector<HTMLButtonElement>('nav button');
    expect(button).not.toBeNull();
    expect(host.textContent).toContain('01-entry-point.html');
    await act(async () => { button!.click(); });
    expect(backs).toBe(1);
  });

  test('a heading-less ROOT document still renders nothing', async () => {
    const host = await mount({});
    expect(host.querySelector('nav')).toBeNull();
  });

  test('headings still render for the root document', async () => {
    const host = await mount({ blocks: [HEADING] });
    expect(host.textContent).toContain('Chapter');
  });
});
