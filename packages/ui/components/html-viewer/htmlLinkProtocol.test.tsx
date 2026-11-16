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
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCRIPT } from './bridge-script';
import { frameLinkKey } from '../../test-setup/bridgeLinkPort';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useHtmlAnnotation') : null;
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

const LINK_CLICK = 'plannotator-bridge-link-click';
const LINK_OFFER = 'plannotator-bridge-link-offer';

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
  const RAW = '<html><head><script>var headScript = 1;</script></head><body><a href="a.html">A</a></body></html>';

  async function mountViewer(props: Record<string, unknown>) {
    const HtmlViewer = htmlViewerModule!.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    const render = async (next: Record<string, unknown>) => {
      await act(async () => {
        root.render(
          <HtmlViewer
            rawHtml={RAW}
            annotations={[]}
            onAddAnnotation={() => {}}
            onSelectAnnotation={() => {}}
            selectedAnnotationId={null}
            mode="selection"
            inputMethod="pinpoint"
            {...next}
          />,
        );
      });
      // A served frame (`frameUrl`) gets its address a task after the first render.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await render(props);
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    const frame = iframe.contentWindow;
    /** What the page's own script can do: post on the window, as the frame. */
    const postFromFrame = async (data: Record<string, unknown>, ports: MessagePort[] = []) => {
      await act(async () => {
        // The frame's window now: a new srcdoc gives it a new one.
        window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data, ports }));
      });
    };
    // Anything the host transfers to the frame (it must never hand out a port).
    const handed: Transferable[] = [];
    const deliver = frame.postMessage.bind(frame);
    frame.postMessage = ((data: unknown, origin: string, transfer?: Transferable[]) => {
      if (transfer?.length) handed.push(...transfer);
      deliver(data, origin);
    }) as typeof frame.postMessage;
    /** A link offer as the frame: a channel's end and a key; returns the end the offerer keeps. */
    const offer = async (key: string | null): Promise<MessagePort> => {
      const channel = new MessageChannel();
      await postFromFrame({ type: LINK_OFFER, key }, [channel.port2]);
      return channel.port1;
    };
    /** A message on a port, delivered (port delivery is a task away). */
    const onPort = async (port: MessagePort, data: Record<string, unknown>) => {
      await act(async () => {
        port.postMessage(data);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    const key = () => frameLinkKey(iframe);
    return { iframe, postFromFrame, offer, onPort, key, handed, render };
  }

  test('the link guard runs first in the document, before the shim and the page head script, with a 32-hex key', async () => {
    const { iframe, key } = await mountViewer({});
    const srcdoc = iframe.getAttribute('srcdoc')!;
    expect(key()).toMatch(/^[0-9a-f]{32}$/);
    const guardAt = srcdoc.indexOf('__plannotatorLinkGuard');
    const scripts = [...srcdoc.matchAll(/<script>/g)].map((m) => m.index!);
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(scripts[1]!);
    expect(srcdoc.indexOf('var headScript')).toBeGreaterThan(guardAt);
  });

  test("the offer with this load's key is taken: a link on its port reaches the host", async () => {
    const seen: string[] = [];
    const { offer, onPort, key } = await mountViewer({ onOpenLink: (href: string) => seen.push(href) });
    await onPort(await offer(key()), { type: LINK_CLICK, href: '../index.html' });
    expect(seen).toEqual(['../index.html']);
  });

  test("a link-click posted on the window, as the page's own script can, never reaches the host", async () => {
    const seen: string[] = [];
    const { postFromFrame, offer, key } = await mountViewer({ onOpenLink: (href: string) => seen.push(href) });
    await postFromFrame({ type: LINK_CLICK, href: '../before-offer.html' });
    await offer(key());
    await postFromFrame({ type: LINK_CLICK, href: '../after-offer.html' });
    expect(seen).toEqual([]);
  });

  test('a forged ready gets nothing: the host hands the frame no port', async () => {
    const seen: string[] = [];
    const { postFromFrame, handed } = await mountViewer({ onOpenLink: (href: string) => seen.push(href) });
    await postFromFrame({ type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION });
    await postFromFrame({ type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION });
    expect(handed).toEqual([]);
    expect(seen).toEqual([]);
  });

  // A page that rewrote itself (document.open) or navigated its own frame to the asset route's copy, which has no
  // guard, then offers a port of its own: even with the key it read from the page, it is a second offer.
  test('a second offer for the same load is refused, key or not; the first port keeps working', async () => {
    const seen: string[] = [];
    const { offer, onPort, key } = await mountViewer({ onOpenLink: (href: string) => seen.push(href) });
    const honest = await offer(key());
    const forged = await offer(key());
    await onPort(forged, { type: LINK_CLICK, href: '/#thread=T2' });
    await onPort(honest, { type: LINK_CLICK, href: 'next.html' });
    expect(seen).toEqual(['next.html']);
  });

  test('an offer with another key, or none, is refused and does not use up the load', async () => {
    const seen: string[] = [];
    const { offer, onPort, key } = await mountViewer({ onOpenLink: (href: string) => seen.push(href) });
    await onPort(await offer('f'.repeat(32)), { type: LINK_CLICK, href: '/#thread=T2' });
    await onPort(await offer(null), { type: LINK_CLICK, href: '/#thread=T3' });
    await onPort(await offer(key()), { type: LINK_CLICK, href: 'next.html' });
    expect(seen).toEqual(['next.html']);
  });

  test('a new document from the host has a new key: the old port is dropped and the old key refused', async () => {
    const seen: string[] = [];
    const onOpenLink = (href: string) => seen.push(href);
    const { offer, onPort, key, render } = await mountViewer({ onOpenLink });
    const oldKey = key()!;
    const oldPort = await offer(oldKey);
    await render({ onOpenLink, rawHtml: '<html><body><a href="b.html">B</a></body></html>' });
    expect(key()).not.toBe(oldKey);
    await onPort(oldPort, { type: LINK_CLICK, href: 'old-port.html' });
    await onPort(await offer(oldKey), { type: LINK_CLICK, href: 'old-key.html' });
    await onPort(await offer(key()), { type: LINK_CLICK, href: 'new.html' });
    expect(seen).toEqual(['new.html']);
  });

  test('a rejected href never reaches the host', async () => {
    const seen: string[] = [];
    const { offer, onPort, key } = await mountViewer({ onOpenLink: (href: string) => seen.push(href) });
    const port = await offer(key());
    await onPort(port, { type: LINK_CLICK, href: 'a\u0000b.html' });
    await onPort(port, { type: LINK_CLICK, href: `${'a'.repeat(4096)}.html` });
    await onPort(port, { type: LINK_CLICK });
    expect(seen).toEqual([]);
  });

  test('an armed (Annotate) document follows a link too: the host gets it whatever the mode', async () => {
    const seen: string[] = [];
    const { offer, onPort, key } = await mountViewer({
      annotateModeActive: true,
      onOpenLink: (href: string) => seen.push(href),
    });
    await onPort(await offer(key()), { type: LINK_CLICK, href: 'c.html#top' });
    expect(seen).toEqual(['c.html#top']);
  });

  test('the host gets the frame too; a srcdoc frame has no URL to carry a query, so reload does nothing', async () => {
    const seen: Array<{ href: string; reloaded: boolean | undefined }> = [];
    const { offer, onPort, key } = await mountViewer({
      onOpenLink: (href: string, frame?: { reload(search: string, hash?: string): boolean }) => seen.push({ href, reloaded: frame?.reload('?variant=2') }),
    });
    await onPort(await offer(key()), { type: LINK_CLICK, href: '?variant=2' });
    expect(seen).toEqual([{ href: '?variant=2', reloaded: false }]);
  });

  test('read-only documents still navigate — following a link is a read action', async () => {
    const seen: string[] = [];
    const { offer, onPort, key } = await mountViewer({
      readOnly: true,
      onOpenLink: (href: string) => seen.push(href),
    });
    await onPort(await offer(key()), { type: LINK_CLICK, href: 'b.html' });
    expect(seen).toEqual(['b.html']);
  });

  // The Inbox serves its attached pages (`frameUrl`): the same guard, the same rule. Every serve carries its own new
  // key in the address (`__pnk`, see linkGuard.test.ts), on any scheme; the document's inline key is never armed.
  test('a served frame at a non-web address takes one offer too, with its own key, never a window link-click', async () => {
    let served = '';
    const seen: string[] = [];
    const { iframe, offer, onPort, postFromFrame, key } = await mountViewer({
      frameUrl: async (doc: string) => {
        served = doc;
        return 'about:blank#served';
      },
      onOpenLink: (href: string) => seen.push(href),
    });
    const documentKey = /\)\('([0-9a-f]{32})'\);<\/script>/.exec(served)?.[1] ?? null;
    expect(iframe.getAttribute('src')).toMatch(/^about:blank\?__pnk=[0-9a-f]{32}#served$/);
    expect(key()).not.toBe(documentKey);
    await onPort(await offer(documentKey), { type: LINK_CLICK, href: 'document-key.html' });
    const port = await offer(key());
    await postFromFrame({ type: LINK_CLICK, href: 'forged.html' });
    await onPort(await offer(key()), { type: LINK_CLICK, href: 'second.html' });
    await onPort(port, { type: LINK_CLICK, href: '?variant=2' });
    expect(seen).toEqual(['?variant=2']);
  });

  // A page can say its served copy is gone (`plannotator-frame-gone`), and the host serves it again: a new load,
  // so a new key; the old document, still in the frame until then, read only the old one.
  test('a frame served again gets a new key: the old one is refused', async () => {
    const seen: string[] = [];
    const { iframe, offer, onPort, postFromFrame, key } = await mountViewer({
      frameUrl: async () => 'about:blank#served',
      onOpenLink: (href: string) => seen.push(href),
    });
    const oldKey = key();
    await onPort(await offer(oldKey), { type: LINK_CLICK, href: 'first-load.html' });
    await postFromFrame({ type: 'plannotator-frame-gone' });
    for (let i = 0; i < 4 && key() === oldKey; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(iframe.getAttribute('src')).toMatch(/^about:blank\?__pnk=[0-9a-f]{32}#served$/);
    expect(key()).not.toBe(oldKey);
    await onPort(await offer(oldKey), { type: LINK_CLICK, href: 'old-key.html' });
    await onPort(await offer(key()), { type: LINK_CLICK, href: 'second-load.html' });
    expect(seen).toEqual(['first-load.html', 'second-load.html']);
  });

  test("a served path (the Inbox's /api/inbox/pages/<id>) carries its own key: the document's is refused", async () => {
    let served = '';
    const seen: string[] = [];
    const { iframe, offer, onPort, key } = await mountViewer({
      frameUrl: async (doc: string) => {
        served = doc;
        return '/api/inbox/pages/abc';
      },
      onOpenLink: (href: string) => seen.push(href),
    });
    const documentKey = /\)\('([0-9a-f]{32})'\);<\/script>/.exec(served)?.[1];
    expect(iframe.getAttribute('src')).toMatch(/^(http:\/\/[^/]+)?\/api\/inbox\/pages\/abc\?__pnk=[0-9a-f]{32}$/);
    expect(key()).not.toBe(documentKey);
    await onPort(await offer(documentKey ?? null), { type: LINK_CLICK, href: 'document-key.html' });
    await onPort(await offer(key()), { type: LINK_CLICK, href: 'next.html' });
    expect(seen).toEqual(['next.html']);
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
