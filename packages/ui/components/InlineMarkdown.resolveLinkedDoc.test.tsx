import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { InlineMarkdown } from './InlineMarkdown';

const hasDom = typeof document !== 'undefined';

afterEach(() => {
  if (hasDom) document.body.innerHTML = '';
});

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
  return host;
}

describe('InlineMarkdown resolveLinkedDoc', () => {
  test.skipIf(!hasDom)('absent callback: current rendering, pinned explicitly', async () => {
    const host = await render(
      <InlineMarkdown text="See [[doc_01XYZ|My Doc]] please" onOpenLinkedDoc={() => {}} />,
    );
    const anchor = host.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.textContent).toBe('My Doc');
    expect(anchor?.getAttribute('href')).toBe('doc_01XYZ.md');
    expect(anchor?.getAttribute('title')).toBe('Open: doc_01XYZ');
    expect(anchor?.querySelector('svg')).not.toBeNull();
  });

  test.skipIf(!hasDom)('callback returning null: byte-identical to absent callback', async () => {
    const text = 'See [[doc_01XYZ|My Doc]] and [[plain-target]] please';
    const noop = () => {};
    const without = await render(<InlineMarkdown text={text} onOpenLinkedDoc={noop} />);
    const withNull = await render(
      <InlineMarkdown text={text} onOpenLinkedDoc={noop} resolveLinkedDoc={() => null} />,
    );
    expect(withNull.innerHTML).toBe(without.innerHTML);

    const withoutLink = await render(<InlineMarkdown text={text} />);
    const withNullNoLink = await render(
      <InlineMarkdown text={text} resolveLinkedDoc={() => null} />,
    );
    expect(withNullNoLink.innerHTML).toBe(withoutLink.innerHTML);
  });

  test.skipIf(!hasDom)('callback receives the RAW stored target, not the .md path', async () => {
    const seen: string[] = [];
    await render(
      <InlineMarkdown
        text="[[doc_01XYZ]] and [[notes.md|Notes]] and [[  spaced  ]]"
        onOpenLinkedDoc={() => {}}
        resolveLinkedDoc={(target) => {
          seen.push(target);
          return null;
        }}
      />,
    );
    expect(seen).toEqual(['doc_01XYZ', 'notes.md', 'spaced']);
  });

  test.skipIf(!hasDom)('resolved label overrides the stored label; link behavior unchanged', async () => {
    const opened: string[] = [];
    const host = await render(
      <InlineMarkdown
        text="[[doc_01XYZ|Stale Stored Title]]"
        onOpenLinkedDoc={(path) => opened.push(path)}
        resolveLinkedDoc={() => ({ label: 'Fresh Live Title', status: 'active' })}
      />,
    );
    const anchor = host.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.textContent).toBe('Fresh Live Title');
    await act(async () => {
      anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(opened).toEqual(['doc_01XYZ.md']);
  });

  test.skipIf(!hasDom)('label fallback chain: resolved label → stored label → target', async () => {
    const stored = await render(
      <InlineMarkdown
        text="[[doc_01XYZ|Stored Label]]"
        onOpenLinkedDoc={() => {}}
        resolveLinkedDoc={() => ({ status: 'active' })}
      />,
    );
    expect(stored.querySelector('a')?.textContent).toBe('Stored Label');

    const target = await render(
      <InlineMarkdown
        text="[[doc_01XYZ]]"
        onOpenLinkedDoc={() => {}}
        resolveLinkedDoc={() => ({ status: 'active' })}
      />,
    );
    expect(target.querySelector('a')?.textContent).toBe('doc_01XYZ');
  });

  test.skipIf(!hasDom)('label override also applies to the non-link rendering', async () => {
    const host = await render(
      <InlineMarkdown
        text="[[doc_01XYZ|Stored]]"
        resolveLinkedDoc={() => ({ label: 'Live' })}
      />,
    );
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toContain('Live');
    expect(host.textContent).not.toContain('Stored');
  });

  test.skipIf(!hasDom)("status 'deleted': muted non-link, even with onOpenLinkedDoc present", async () => {
    const opened: string[] = [];
    const host = await render(
      <InlineMarkdown
        text="[[doc_01XYZ|Old Doc]]"
        onOpenLinkedDoc={(path) => opened.push(path)}
        resolveLinkedDoc={() => ({ status: 'deleted' })}
      />,
    );
    expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('svg')).toBeNull();

    const span = host.querySelector('span[title="Document deleted"]');
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe('Old Doc');
    expect(span?.className).toContain('text-muted-foreground');
    expect(span?.className).toContain('line-through');
    expect(span?.className).not.toContain('cursor-pointer');

    await act(async () => {
      span?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(opened).toEqual([]);
  });

  test.skipIf(!hasDom)("deleted + resolved label: label still overrides on the muted span", async () => {
    const host = await render(
      <InlineMarkdown
        text="[[doc_01XYZ]]"
        onOpenLinkedDoc={() => {}}
        resolveLinkedDoc={() => ({ label: 'Old Doc (final title)', status: 'deleted' })}
      />,
    );
    const span = host.querySelector('span[title="Document deleted"]');
    expect(span?.textContent).toBe('Old Doc (final title)');
  });

  test.skipIf(!hasDom)('resolution reaches wiki-links nested in emphasis (recursive threading)', async () => {
    const seen: string[] = [];
    const host = await render(
      <InlineMarkdown
        text="**bold [[doc_01XYZ|Stored]]** and ~~struck [[doc_02ABC]]~~"
        onOpenLinkedDoc={() => {}}
        resolveLinkedDoc={(target) => {
          seen.push(target);
          return target === 'doc_02ABC' ? { status: 'deleted' } : { label: 'Live' };
        }}
      />,
    );
    expect(seen).toContain('doc_01XYZ');
    expect(seen).toContain('doc_02ABC');
    expect(host.querySelector('strong a')?.textContent).toBe('Live');
    expect(host.querySelector('del span[title="Document deleted"]')).not.toBeNull();
  });
});
