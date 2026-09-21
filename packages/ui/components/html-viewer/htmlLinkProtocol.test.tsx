/**
 * Parent-side contract for link clicks relayed out of a raw-HTML document.
 *
 * The bridge runs inside a sandboxed iframe rendering arbitrary HTML, so the
 * href it reports is attacker-controllable text. These tests cover the trust
 * boundary (what `parseBridgeMessage` accepts), the delivery to the host, and
 * the live-app exclusion — a live session navigates the proxied app for real,
 * so the bridge must not swallow its links.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BRIDGE_SCRIPT } from './bridge-script';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useHtmlAnnotation') : null;
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

const LINK_CLICK = 'plannotator-bridge-link-click';

const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe.if(hasDom)('link-click at the trust boundary', () => {
  const parse = () => hookModule!.parseBridgeMessage;

  test('accepts a well-formed href and trims it', () => {
    expect(parse()({ type: LINK_CLICK, href: '  ../index.html#top  ' }))
      .toEqual({ type: LINK_CLICK, href: '../index.html#top' });
  });

  test('rejects non-strings, empties, and messages with no href', () => {
    expect(parse()({ type: LINK_CLICK })).toBeNull();
    expect(parse()({ type: LINK_CLICK, href: 42 })).toBeNull();
    expect(parse()({ type: LINK_CLICK, href: '' })).toBeNull();
    expect(parse()({ type: LINK_CLICK, href: '   ' })).toBeNull();
  });

  test('rejects an unbounded href rather than truncating it into a path', () => {
    expect(parse()({ type: LINK_CLICK, href: `${'a'.repeat(2048)}.html` })).toBeNull();
    expect(parse()({ type: LINK_CLICK, href: 'a'.repeat(2048) }))
      .toEqual({ type: LINK_CLICK, href: 'a'.repeat(2048) });
  });

  test('rejects control characters — the way structure gets smuggled into a path', () => {
    expect(parse()({ type: LINK_CLICK, href: 'a\u0000.html' })).toBeNull();
    expect(parse()({ type: LINK_CLICK, href: 'a\n../../etc/passwd' })).toBeNull();
    expect(parse()({ type: LINK_CLICK, href: 'a\u007f.html' })).toBeNull();
  });
});

describe.if(hasDom)('HtmlViewer link delivery', () => {
  async function mountViewer(props: Record<string, unknown>) {
    const HtmlViewer = htmlViewerModule!.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <HtmlViewer
          rawHtml='<html><body><a href="a.html">A</a></body></html>'
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          {...props}
        />,
      );
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    const postFromBridge = async (data: Record<string, unknown>) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data }));
      });
    };
    return { postFromBridge };
  }

  test('a validated link-click reaches the host', async () => {
    const seen: string[] = [];
    const { postFromBridge } = await mountViewer({ onOpenLink: (href: string) => seen.push(href) });
    await postFromBridge({ type: LINK_CLICK, href: '../index.html' });
    expect(seen).toEqual(['../index.html']);
  });

  test('a rejected href never reaches the host', async () => {
    const seen: string[] = [];
    const { postFromBridge } = await mountViewer({ onOpenLink: (href: string) => seen.push(href) });
    await postFromBridge({ type: LINK_CLICK, href: 'a\u0000b.html' });
    await postFromBridge({ type: LINK_CLICK, href: `${'a'.repeat(4096)}.html` });
    await postFromBridge({ type: LINK_CLICK });
    expect(seen).toEqual([]);
  });

  test('read-only documents still navigate — following a link is a read action', async () => {
    const seen: string[] = [];
    const { postFromBridge } = await mountViewer({
      readOnly: true,
      onOpenLink: (href: string) => seen.push(href),
    });
    await postFromBridge({ type: LINK_CLICK, href: 'b.html' });
    expect(seen).toEqual(['b.html']);
  });
});

describe('live app sessions keep their own navigation', () => {
  /** The balanced `{ … }` body of the `if (!LIVE) { … }` block at `from`. */
  function liveExcludedBlock(source: string, from: number): string {
    const open = source.indexOf('{', from);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    throw new Error('unbalanced !LIVE block');
  }

  test('the link interceptor is installed only outside live mode', () => {
    // A live session mirrors a real dev server through the proxy: its links
    // must navigate the framed app, not be swallowed and handed to the host.
    // The bridge is a string, so this is asserted at source level — the same
    // shape the live-proxy loopback-bind invariants use.
    const occurrences = BRIDGE_SCRIPT.split("PREFIX + 'link-click'").length - 1;
    expect(occurrences).toBe(1);
    let found = false;
    let at = BRIDGE_SCRIPT.indexOf('if (!LIVE) {');
    while (at !== -1) {
      if (liveExcludedBlock(BRIDGE_SCRIPT, at).includes("PREFIX + 'link-click'")) found = true;
      at = BRIDGE_SCRIPT.indexOf('if (!LIVE) {', at + 1);
    }
    expect(found).toBe(true);
  });
});
