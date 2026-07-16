/**
 * Seam test: DocPreviewFetcher override (setDocPreviewFetcher / resetDocPreviewFetcher).
 *
 * Contract: after setDocPreviewFetcher(fake), code-file hover previews use the
 * fake fetcher instead of the default /api/doc. resetDocPreviewFetcher() restores
 * the default.
 *
 * Requires DOM (happy-dom) — runs under bun test (preloaded via bunfig.toml).
 *
 * IMPORTANT: function references are captured at module-load time (top-level)
 * so they remain valid even when configure.test.ts's mock.module() replaces
 * the module exports later during test execution.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import * as InlineMarkdownModule from './InlineMarkdown';

// Capture real function references at import time (before configure.test.ts's
// mock.module() runs and replaces setDocPreviewFetcher with a no-op spy).
const setDocPreviewFetcher = InlineMarkdownModule.setDocPreviewFetcher;
const resetDocPreviewFetcher = InlineMarkdownModule.resetDocPreviewFetcher;
const InlineMarkdown = InlineMarkdownModule.InlineMarkdown;

const hasDom = typeof document !== 'undefined';

afterEach(() => {
  resetDocPreviewFetcher();
  if (hasDom) document.body.innerHTML = '';
});

// The DocPreviewFetcher seam is exercised by the CodeFileLink component when its
// anchor element receives a mouseenter. Render a code-file path reference
// (src/index.ts:10 — has a line number so the hover is enabled) and fire the event.

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

    // Find the rendered code-file link and fire the hover event.
    // CodeFileLink renders a <code role="button"> element with onMouseEnter.
    // React 19 in happy-dom triggers onMouseEnter via mouseover (not mouseenter).
    const codeLink = host.querySelector('code[role="button"]') as HTMLElement | null;
    if (codeLink) {
      await act(async () => {
        // mouseover triggers React's onMouseEnter in happy-dom/React 19.
        codeLink.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        // The hover delay is 150 ms; wait for it.
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

    // After reset, install a fetch spy so the default hits /api/doc
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
        // Use mouseover — triggers React's onMouseEnter in happy-dom/React 19.
        codeLink.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      });
    }

    globalThis.fetch = realFetch;

    // Fake was NOT called (the reset restored the default);
    // the default fetcher would have called /api/doc instead.
    expect(calls).toHaveLength(0);
  });
});
