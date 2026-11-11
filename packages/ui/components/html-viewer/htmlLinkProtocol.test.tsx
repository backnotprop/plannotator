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

  test('an armed (Annotate) document follows a link too: the host gets it whatever the mode', async () => {
    const seen: string[] = [];
    const { postFromBridge } = await mountViewer({
      annotateModeActive: true,
      onOpenLink: (href: string) => seen.push(href),
    });
    await postFromBridge({ type: LINK_CLICK, href: 'c.html#top' });
    expect(seen).toEqual(['c.html#top']);
  });

  test('the host gets the frame too; a srcdoc frame has no URL to carry a query, so reload does nothing', async () => {
    const seen: Array<{ href: string; reloaded: boolean | undefined }> = [];
    const { postFromBridge } = await mountViewer({
      onOpenLink: (href: string, frame?: { reload(search: string, hash?: string): boolean }) => seen.push({ href, reloaded: frame?.reload('?variant=2') }),
    });
    await postFromBridge({ type: LINK_CLICK, href: '?variant=2' });
    expect(seen).toEqual([{ href: '?variant=2', reloaded: false }]);
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

describe.if(hasDom)('reloading a served frame with a query', () => {
  // The Inbox serves an attached page at /api/inbox/pages/<id>; a link to the
  // page itself (`?variant=2`) loads that same document with the query. Only
  // the query and fragment ever change: never the path or the origin, so a
  // page cannot use it to frame anything else.
  const base = 'http://localhost:4000/#thread=t1';
  const reloadUrl = (search: string, hash?: string, served = '/api/inbox/pages/abc') => htmlViewerModule!.servedFrameReloadUrl(served, base, search, hash);
  test('the served page with the new query and fragment', () => {
    expect(reloadUrl('?variant=2&n=3')).toBe('http://localhost:4000/api/inbox/pages/abc?variant=2&n=3');
    expect(reloadUrl('?x=1', '#top')).toBe('http://localhost:4000/api/inbox/pages/abc?x=1#top');
    // A query the page had is replaced, not added to.
    expect(reloadUrl('', '', '/api/inbox/pages/abc?old=1#h')).toBe('http://localhost:4000/api/inbox/pages/abc');
  });

  test('anything that is not a query and a fragment does nothing', () => {
    const htmlViewerUrl = htmlViewerModule!.servedFrameReloadUrl;
    for (const [search, hash] of [['x=1', ''], ['/api/inbox/threads', ''], ['//evil.example/', ''], ['?a#b', ''], ['?x=1', 'top'], ['?x\u0000', ''], ['?x', '#a\nb']]) {
      expect(reloadUrl(search!, hash)).toBeNull();
    }
    // No served page yet, a blanked one, or one that is not on the web.
    expect(htmlViewerUrl(undefined, base, '?x=1')).toBeNull();
    expect(htmlViewerUrl('about:blank', base, '?x=1')).toBeNull();
    expect(htmlViewerUrl('data:text/html,hi', base, '?x=1')).toBeNull();
  });

  // `frameStart`: a page opened at `mock.html?variant=2` (a prototype's line, a link in a message) starts there.
  test('the first address: the served page with the start query and fragment; anything else leaves it as served', () => {
    const start = (value: string) => htmlViewerModule!.servedFrameStartUrl('/api/inbox/pages/abc', base, value);
    expect(start('?variant=2')).toBe('http://localhost:4000/api/inbox/pages/abc?variant=2');
    expect(start('#step-2')).toBe('http://localhost:4000/api/inbox/pages/abc#step-2');
    expect(start('?variant=2&n=3#top')).toBe('http://localhost:4000/api/inbox/pages/abc?variant=2&n=3#top');
    for (const value of ['variant=2', '/api/inbox/threads', '//evil.example/x', '?x\u0000']) expect(start(value)).toBe('/api/inbox/pages/abc');
    expect(htmlViewerModule!.servedFrameStartUrl('about:blank', base, '?x=1')).toBe('about:blank');
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
    // shape the live-proxy loopback-bind invariants use. Two places post a
    // link: the link interceptor, and a form's submit (pageNavigation), whose
    // handler is registered only outside live mode too.
    const occurrences = BRIDGE_SCRIPT.split("PREFIX + 'link-click'").length - 1;
    expect(occurrences).toBe(2);
    let found = false;
    let at = BRIDGE_SCRIPT.indexOf('if (!LIVE) {');
    while (at !== -1) {
      if (liveExcludedBlock(BRIDGE_SCRIPT, at).includes("PREFIX + 'link-click'")) found = true;
      at = BRIDGE_SCRIPT.indexOf('if (!LIVE) {', at + 1);
    }
    expect(found).toBe(true);
    const form = BRIDGE_SCRIPT.indexOf('function submitPageForm(');
    expect(liveExcludedBlock(BRIDGE_SCRIPT, form)).toContain("PREFIX + 'link-click'");
    expect(BRIDGE_SCRIPT.split('submitPageForm').length - 1).toBe(2);
    expect(BRIDGE_SCRIPT).toContain("if (!LIVE) window.addEventListener('click', submitPageForm, false);");
  });
});
