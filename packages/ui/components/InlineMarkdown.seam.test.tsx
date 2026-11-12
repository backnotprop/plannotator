import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import * as InlineMarkdownModule from './InlineMarkdown';

// Captured at import time, before configure.test.ts's mock.module() replaces it with a no-op spy.
const setDocPreviewFetcher = InlineMarkdownModule.setDocPreviewFetcher;
const resetDocPreviewFetcher = InlineMarkdownModule.resetDocPreviewFetcher;
const InlineMarkdown = InlineMarkdownModule.InlineMarkdown;

const hasDom = typeof document !== 'undefined';

afterEach(() => {
  resetDocPreviewFetcher();
  if (hasDom) document.body.innerHTML = '';
});

describe('DocPreviewFetcher seam', () => {
  test.skipIf(!hasDom)('fake fetcher is called with the code-file path on hover', async () => {
    const calls: Array<{ path: string; base?: string }> = [];
    const fakeFetcher = async (path: string, base?: string) => {
      calls.push({ path, base });
      return { contents: '// fake content', filepath: path };
    };

    setDocPreviewFetcher(fakeFetcher);

    const host = document.createElement('div');
    document.body.appendChild(host);
    let root: Root;
    await act(async () => {
      root = createRoot(host);
      root.render(
        <InlineMarkdown
          text="See src/index.ts:10 for details."
          onOpenCodeFile={() => {}}
        />,
      );
    });

    const codeLink = host.querySelector('code[role="button"]') as HTMLElement | null;
    if (codeLink) {
      await act(async () => {
        codeLink.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      });
    }

    // The fake fetcher must have been invoked with the code path.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].path).toContain('src/index.ts');
  });

  test.skipIf(!hasDom)('resetDocPreviewFetcher restores the /api/doc default (does not call the fake)', async () => {
    const calls: string[] = [];
    const fake = async (path: string) => { calls.push(path); return null; };

    setDocPreviewFetcher(fake);
    resetDocPreviewFetcher();

    const fetchCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify(null), { status: 200 });
    }) as typeof fetch;

    const host = document.createElement('div');
    document.body.appendChild(host);
    let root: Root;
    await act(async () => {
      root = createRoot(host);
      root.render(
        <InlineMarkdown
          text="See src/index.ts:1 for details."
          onOpenCodeFile={() => {}}
        />,
      );
    });

    const codeLink = host.querySelector('code[role="button"]') as HTMLElement | null;
    if (codeLink) {
      await act(async () => {
        codeLink.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      });
    }

    globalThis.fetch = realFetch;

    expect(calls).toHaveLength(0);
  });
});
