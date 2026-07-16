/**
 * resolveLinkedDoc: synchronous host resolution of wiki-links ([[target]] /
 * [[target|label]]) in InlineMarkdown.
 *
 * Contract under test:
 *  - callback absent, or returning null → byte-identical to today's rendering
 *  - the callback receives the RAW stored target (no `.md` normalization)
 *  - `label` overrides the stored label; stored label is the fallback,
 *    target the last resort
 *  - `status: 'deleted'` → muted NON-link (no anchor, no icon, no
 *    onOpenLinkedDoc wiring) even when onOpenLinkedDoc is present
 *  - non-deleted links keep today's onOpenLinkedDoc payload (normalized path)
 *
 * Requires DOM (happy-dom) — run with DOM_TESTS=1 bun test.
 */
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
    expect(anchor?.querySelector('svg')).not.toBeNull(); // link icon present
  });

  test.skipIf(!hasDom)('callback returning null: byte-identical to absent callback', async () => {
    const text = 'See [[doc_01XYZ|My Doc]] and [[plain-target]] please';
    const noop = () => {};
    const without = await render(<InlineMarkdown text={text} onOpenLinkedDoc={noop} />);
    const withNull = await render(
      <InlineMarkdown text={text} onOpenLinkedDoc={noop} resolveLinkedDoc={() => null} />,
    );
    expect(withNull.innerHTML).toBe(without.innerHTML);

    // Same equivalence without onOpenLinkedDoc (the non-link branch).
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
    // Raw targets: no `.md` appended to the opaque id; an existing extension
    // passes through as stored; surrounding whitespace is trimmed (as it
    // already is for display/path today).
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
    // onOpenLinkedDoc still receives today's payload: the normalized path.
    await act(async () => {
      anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(opened).toEqual(['doc_01XYZ.md']);
  });

  test.skipIf(!hasDom)('label fallback chain: resolved label → stored label → target', async () => {
    // Resolution without label → stored label wins.
    const stored = await render(
      <InlineMarkdown
        text="[[doc_01XYZ|Stored Label]]"
        onOpenLinkedDoc={() => {}}
        resolveLinkedDoc={() => ({ status: 'active' })}
      />,
    );
    expect(stored.querySelector('a')?.textContent).toBe('Stored Label');

    // No stored label, resolution without label → target is the last resort.
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
    // No anchor, no link icon.
    expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('svg')).toBeNull();

    const span = host.querySelector('span[title="Document deleted"]');
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe('Old Doc');
    // Quiet, muted, struck-through — not the link treatment.
    expect(span?.className).toContain('text-muted-foreground');
    expect(span?.className).toContain('line-through');
    expect(span?.className).not.toContain('cursor-pointer');

    // Clicking is inert: onOpenLinkedDoc is NOT wired on deleted links.
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
