import { describe, expect, test } from 'bun:test';
import { CanvasStore } from '../events/store';
import { checkObject } from '../model/codec';
import { createDocument } from '../model/document';
import { pastedUrl, referenceCard } from '../model/reference';
import type { ReferenceObject } from '../model/types';
import { CARD_SIZE, CARD_SIZE_WITH_IMAGE, addReference, referenceFromPaste } from '../react/references';
import { isPrivateAddress } from './address';
import { type PinnedFetch, type UnfurlOptions, createUnfurler, resolveHost, unfurlFault, unfurlUrl as unfurlReal } from './fetch';
import { readLinkPreview } from '../react/link-preview';
import { parseLinkPreview } from './parse';
import { createUnfurlHandler, isLoopbackHost } from './route';

const PAGE = `<!doctype html><html><head>
<title>Plain &amp; simple title</title>
<meta name="description" content="A plain description.">
<meta property="og:title" content="Rich &quot;title&quot; &lt;b&gt;bold&lt;/b&gt;">
<meta property='og:description' content='Line one
line two'>
<meta property="og:site_name" content="Field Notes">
<meta property="og:image" content="/img/card.png">
<link rel="icon" href="favicon.png" type="image/png">
</head><body><meta property="og:title" content="from the body"></body></html>`;

/** Every name in these tests resolves here, to a public address, unless a test says otherwise. No test asks real DNS. */
const PUBLIC = async () => ['93.184.216.34'];
/** The stand-in network as a pin: the request is made at the address that was checked, which a plain `fetch` cannot promise. */
const pinned = (fetch: typeof globalThis.fetch): PinnedFetch => (url, _address, init) => fetch(url.href, init);
/** A test's `fetch` stands for the network; unless the test allows private addresses, it is reached through a pin. */
const unfurlUrl = (address: string, options: UnfurlOptions = {}) =>
  unfurlReal(address, { lookup: PUBLIC, ...options, ...(options.fetch && !options.allowPrivate && !options.pin ? { pin: pinned(options.fetch) } : {}) });

/** A stand-in for the network: a map from address to response. */
function net(pages: Record<string, () => Response>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const stub = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const page = pages[url];
    if (!page) throw new Error(`no route to ${url}`);
    return page();
  };
  return { fetch: stub as typeof fetch, calls };
}

const html = (body: string, type = 'text/html; charset=utf-8') => () => new Response(body, { headers: { 'content-type': type } });
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });

describe('reading a page for its preview', () => {
  test('Open Graph wins over the plain tags, addresses become absolute, and markup becomes text', () => {
    expect(parseLinkPreview(PAGE, 'https://notes.example.test/posts/1')).toEqual({
      url: 'https://notes.example.test/posts/1',
      title: 'Rich "title" bold',
      description: 'Line one line two',
      site: 'Field Notes',
      image: 'https://notes.example.test/img/card.png',
      icon: 'https://notes.example.test/posts/favicon.png',
    });
  });

  test('a page with nothing but a title still gives a title, the host as its site and the usual icon', () => {
    expect(parseLinkPreview('<title> Only this </title>', 'https://www.example.test/a')).toEqual({
      url: 'https://www.example.test/a',
      title: 'Only this',
      site: 'example.test',
      icon: 'https://www.example.test/favicon.ico',
    });
  });

  test('a picture address that is not http(s) is dropped', () => {
    const preview = parseLinkPreview('<meta property="og:image" content="javascript:alert(1)"><meta property="og:title" content="T">', 'https://example.test/');
    expect(preview.image).toBeUndefined();
    expect(preview.title).toBe('T');
  });
});

describe('fetching a preview', () => {
  test('follows redirects to the page and reports the address it ended on', async () => {
    const { fetch } = net({
      'https://short.example.test/x': redirect('https://notes.example.test/posts/1'),
      'https://notes.example.test/posts/1': html(PAGE),
    });
    const preview = await unfurlUrl('https://short.example.test/x', { fetch });
    expect(preview).toMatchObject({ url: 'https://notes.example.test/posts/1', title: 'Rich "title" bold', site: 'Field Notes' });
  });

  test('when a site gives nothing, fails, or is not a page, the answer is the bare link', async () => {
    const { fetch } = net({
      'https://down.example.test/': () => new Response('nope', { status: 503, headers: { 'content-type': 'text/html' } }),
      'https://files.example.test/report.pdf': html('%PDF', 'application/pdf'),
      'https://loop.example.test/': redirect('https://loop.example.test/'),
    });
    expect(await unfurlUrl('https://down.example.test/', { fetch })).toEqual({ url: 'https://down.example.test/', site: 'down.example.test' });
    expect(await unfurlUrl('https://files.example.test/report.pdf', { fetch })).toEqual({ url: 'https://files.example.test/report.pdf', site: 'files.example.test' });
    expect(await unfurlUrl('https://loop.example.test/', { fetch })).toEqual({ url: 'https://loop.example.test/', site: 'loop.example.test' });
    expect(await unfurlUrl('https://unreachable.example.test/', { fetch })).toEqual({ url: 'https://unreachable.example.test/', site: 'unreachable.example.test' });
  });

  test("a picture's address previews as the picture", async () => {
    const { fetch } = net({ 'https://img.example.test/shots/a%20b.png': html('PNG', 'image/png') });
    expect(await unfurlUrl('https://img.example.test/shots/a%20b.png', { fetch })).toMatchObject({ image: 'https://img.example.test/shots/a%20b.png', title: 'a b.png' });
  });

  test('only the start of a large page is read', async () => {
    const huge = `<title>Big</title>${'x'.repeat(200_000)}<meta property="og:title" content="too late">`;
    const { fetch } = net({ 'https://big.example.test/': html(huge) });
    const preview = await unfurlUrl('https://big.example.test/', { fetch, maxBytes: 1000 });
    expect(preview?.title).toBe('Big');
  });

  test('a slow site is given up on and the bare link returned', async () => {
    const slow = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
    const started = Date.now();
    expect(await unfurlUrl('https://slow.example.test/', { fetch: slow, timeoutMs: 40 })).toEqual({ url: 'https://slow.example.test/', site: 'slow.example.test' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('only http and https, and never this machine or a private network, directly or by redirect', async () => {
    const { fetch, calls } = net({
      'https://public.example.test/': redirect('http://169.254.169.254/latest/meta-data'),
      'https://named.example.test/': html('<title>Inside</title>'),
    });
    for (const address of [
      'file:///etc/passwd',
      'ftp://example.test/',
      'javascript:alert(1)',
      'http://localhost:8080/',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://10.1.2.3/',
      'http://192.168.1.1/admin',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[64:ff9b::a00:1]/',
      'http://[2002:c0a8:101::]/',
      'http://[fd12:3456::1]/',
      'http://[fe80::1]/',
      'https://user:pass@example.test/',
    ]) {
      expect(await unfurlUrl(address, { fetch })).toBeNull();
    }
    expect(calls).toEqual([]);
    expect(await unfurlUrl('https://public.example.test/', { fetch })).toEqual({ url: 'https://public.example.test/', site: 'public.example.test' });
    expect(calls).toEqual(['https://public.example.test/']);
    // A public-looking name that resolves to a private address is refused too, whichever family answers.
    expect(await unfurlUrl('https://named.example.test/', { fetch, lookup: async () => ['10.0.0.7'] })).toBeNull();
    expect(await unfurlUrl('https://named.example.test/', { fetch, lookup: async () => ['93.184.216.34', '::ffff:7f00:1'] })).toBeNull();
    expect(await unfurlUrl('https://named.example.test/', { fetch, lookup: async () => [] })).toBeNull();
    expect(await unfurlUrl('https://named.example.test/', { fetch, lookup: async () => ['93.184.216.34'] })).toMatchObject({ title: 'Inside' });
  });

  test('an address is judged by its bytes, however it is written', () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '10.255.255.255', '100.127.0.1', '169.254.169.254', '172.31.0.1', '192.168.0.1', '192.88.99.1', '224.0.0.1', '255.255.255.255', '::', '::1', '64:ff9b:1::808:808', '64:ff9b:1:ffff::1', '::ffff:192.88.99.7', '::ffff:0:8.8.8.8', '::ffff:0:808:808', '100::1', '100::ffff:ffff:ffff:ffff', '2001:2::1', '2001:2:0:ffff::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '0:0:0:0:0:ffff:c0a8:0101', '64:ff9b::7f00:1', '2002:7f00:1::', 'fc00::1', 'fdff::1', 'fe80::1%en0', 'febf::1', 'ff02::1', '[::1]', 'not an address', '']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '192.88.98.1', '192.88.100.1', '64:ff9b:2::808:808', '100:0:0:1::1', '2001:2:1::1', '2001:3::1', '::fffe:0:808:808', '2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  test('the request goes to the address that was checked, not to the name again', async () => {
    const seen: string[] = [];
    let answers = 0;
    // A name that answers with a public address the first time and loopback after: DNS rebinding.
    const lookup = async () => (answers++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
    const preview = await unfurlReal('https://rebind.example.test/page', {
      lookup,
      pin: async (url, address) => {
        seen.push(`${url.href} at ${address}`);
        return new Response('<title>Pinned</title>', { headers: { 'content-type': 'text/html' } });
      },
    });
    expect(preview?.title).toBe('Pinned');
    expect(seen).toEqual(['https://rebind.example.test/page at 93.184.216.34']);
    // The page's own icon would be fetched by a viewer's browser from the name, which now answers loopback: dropped.
    expect(preview?.icon).toBeUndefined();
  });

  test("a preview picture or icon that points at a private address is dropped; the host's own policy may allow it", async () => {
    const page = '<title>T</title><meta property="og:image" content="http://192.168.1.10/cam.jpg"><link rel="icon" href="http://[::ffff:7f00:1]/i.png">';
    const { fetch } = net({ 'https://a.example.test/': html(page), 'http://127.0.0.1:3000/': html(page) });
    const lookup = async (host: string) => (host === 'a.example.test' ? ['93.184.216.34'] : ['10.0.0.1']);
    expect(await unfurlUrl('https://a.example.test/', { fetch, lookup })).toEqual({ url: 'https://a.example.test/', title: 'T', site: 'a.example.test' });
    // A local single-user server: the person's own localhost gets its card, pictures and all.
    expect(await unfurlUrl('http://127.0.0.1:3000/', { fetch })).toBeNull();
    expect(await unfurlUrl('http://127.0.0.1:3000/', { fetch, allowPrivate: true })).toMatchObject({ title: 'T', image: 'http://192.168.1.10/cam.jpg' });
  });

  test('a fetcher that could not keep private addresses out is refused when it is made, not at the first paste', async () => {
    const { fetch } = net({ 'https://named.example.test/': html('<title>Named</title>') });
    const pin = pinned(fetch);
    // A fetch of the host's own (or Node): the request would go by name after the check, so a name could answer
    // with a public address when checked and 127.0.0.1 when connected to.
    expect(() => createUnfurler({ fetch, lookup: PUBLIC })).toThrow(/pin/);
    expect(() => createUnfurlHandler({ fetch, lookup: PUBLIC })).toThrow(/pin/);
    await expect(unfurlReal("https://named.example.test/", { fetch, lookup: PUBLIC })).rejects.toThrow(/pin/);
    // With no lookup a name is never checked at all, pin or no pin.
    expect(() => createUnfurler({ pin, lookup: false })).toThrow(/lookup/);
    expect(() => createUnfurler({ fetch, lookup: false })).toThrow();
    expect(() => createUnfurler({ fetch, pin, lookup: PUBLIC, allowPrivate: false })).not.toThrow();
    // A server one person runs for themselves says so, and may then do either.
    expect(unfurlFault({ fetch, allowPrivate: true })).toBeNull();
    expect(await unfurlReal('https://named.example.test/', { fetch, lookup: false, allowPrivate: true })).toMatchObject({ title: 'Named' });
    expect(await resolveHost(new URL('http://printer.local/'), { lookup: false })).toEqual({ address: null, private: true });
    // Under Bun with nothing passed, Bun's own pin applies.
    expect(unfurlFault({})).toBeNull();
  });

  test('a name that never resolves is given up on when the time is up, and is not remembered as unpreviewable', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    let hang = true;
    const lookup = (_host: string, signal?: AbortSignal) => {
      signals.push(signal);
      return hang ? new Promise<string[]>(() => {}) : Promise.resolve(['93.184.216.34']);
    };
    const { fetch } = net({ 'https://stuck.example.test/': html('<title>Here now</title>') });
    const unfurl = createUnfurler({ pin: pinned(fetch), lookup, timeoutMs: 40 });
    const started = Date.now();
    expect(await unfurl('https://stuck.example.test/')).toEqual({ url: 'https://stuck.example.test/', site: 'stuck.example.test' });
    expect(Date.now() - started).toBeLessThan(2000);
    // The lookup was handed the signal, so a resolver that can stop does.
    expect(signals[0]?.aborted).toBe(true);
    // It was a failure, not an answer: the next paste asks again.
    hang = false;
    expect(await unfurl('https://stuck.example.test/')).toMatchObject({ title: 'Here now' });
    // The asker going away ends the wait too.
    hang = true;
    const gone = new AbortController();
    const waiting = unfurlReal('https://stuck.example.test/', { pin: pinned(fetch), lookup, signal: gone.signal });
    gone.abort();
    expect(await waiting).toEqual({ url: 'https://stuck.example.test/', site: 'stuck.example.test' });
  });

  test('a route that reads the local network answers only a request that names this machine', () => {
    for (const host of ['localhost', 'localhost:3017', 'LOCALHOST:3017', '127.0.0.1', '127.0.0.1:3017', '[::1]', '[::1]:3017']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of [undefined, null, '', 'evil.example', 'evil.example:3017', '127.0.0.1.evil.example', 'localhost.evil.example:80', 'evil.example#localhost', '127.0.0.2', '0.0.0.0:3017', '[::1].evil.example', 'localhost:99999999', 'localhost:', 'a'.repeat(300)]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test('a site that failed is asked again next time; a real answer is kept', async () => {
    let up = false;
    const calls: string[] = [];
    const flaky = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (!up) throw new Error('down');
      return new Response('<title>Back</title>', { headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    const unfurl = createUnfurler({ pin: pinned(flaky), lookup: PUBLIC });
    expect(await unfurl('https://flaky.example.test/')).toEqual({ url: 'https://flaky.example.test/', site: 'flaky.example.test' });
    up = true;
    expect(await unfurl('https://flaky.example.test/')).toMatchObject({ title: 'Back' });
    await unfurl('https://flaky.example.test/');
    expect(calls).toHaveLength(2);
  });

  test('what the route sends back is read as a preview and nothing else', () => {
    expect(readLinkPreview({ url: 'https://a.example.test/', title: 'T', image: 7, extra: '<b>', description: 'x'.repeat(5000) })).toEqual({ url: 'https://a.example.test/', title: 'T', description: 'x'.repeat(600) });
    for (const bad of [null, 'text', 5, {}, { title: 'no address' }, []]) expect(readLinkPreview(bad)).toBeNull();
  });

  test('the same address asked twice is fetched once', async () => {
    const { fetch, calls } = net({ 'https://notes.example.test/posts/1': html(PAGE) });
    const unfurl = createUnfurler({ pin: pinned(fetch), lookup: PUBLIC });
    const [a, b] = await Promise.all([unfurl('https://notes.example.test/posts/1'), unfurl('https://notes.example.test/posts/1')]);
    expect(a).toEqual(b);
    await unfurl('https://notes.example.test/posts/1');
    expect(calls).toHaveLength(1);
  });

  test('the route answers with JSON, or with nothing for an address it will not preview', async () => {
    const { fetch } = net({ 'https://notes.example.test/posts/1': html(PAGE) });
    const handle = createUnfurlHandler({ pin: pinned(fetch), lookup: PUBLIC });
    const ok = await handle(new Request(`http://server.test/unfurl?url=${encodeURIComponent('https://notes.example.test/posts/1')}`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('application/json');
    expect(((await ok.json()) as { site: string }).site).toBe('Field Notes');
    expect((await handle(new Request('http://server.test/unfurl?url=file:///etc/passwd'))).status).toBe(204);
    expect((await handle(new Request('http://server.test/unfurl'))).status).toBe(204);
    expect((await handle(new Request('http://server.test/unfurl?url=x', { method: 'POST' }))).status).toBe(405);
  });
});

describe('reference cards on the board', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('a pasted address is a card at once, and fills in when the preview lands, as one undo step', async () => {
    const store = new CanvasStore(createDocument('board'));
    let land: (value: unknown) => void = () => {};
    const preview = () => new Promise<never>((resolve) => (land = resolve as (value: unknown) => void));
    const id = addReference(store, { x: 500, y: 300 }, referenceFromPaste(' https://notes.example.test/posts/1 ')!, preview)!;
    const bare = store.getDocument().objects[id] as ReferenceObject;
    expect(bare).toMatchObject({ type: 'reference', target: { kind: 'web', url: 'https://notes.example.test/posts/1' }, site: 'notes.example.test', ...CARD_SIZE });
    expect(referenceCard(bare).title).toBe('notes.example.test/posts/1');

    land({ url: 'https://notes.example.test/posts/1', title: 'Rich title', site: 'Field Notes', image: 'https://notes.example.test/img/card.png' });
    await settle();
    const filled = store.getDocument().objects[id] as ReferenceObject;
    expect(filled).toMatchObject({ title: 'Rich title', site: 'Field Notes', image: 'https://notes.example.test/img/card.png', ...CARD_SIZE_WITH_IMAGE });
    store.undo();
    expect(store.getDocument().objects[id]).toBeUndefined();
    expect(store.canUndo).toBe(false);
  });

  test('a card the person resized or deleted meanwhile is left as they made it', async () => {
    const store = new CanvasStore(createDocument('board'));
    const lands: ((value: unknown) => void)[] = [];
    const preview = () => new Promise<never>((resolve) => lands.push(resolve as (value: unknown) => void));
    const kept = addReference(store, { x: 0, y: 0 }, referenceFromPaste('https://a.example.test/')!, preview)!;
    const gone = addReference(store, { x: 0, y: 400 }, referenceFromPaste('https://b.example.test/')!, preview)!;
    store.dispatch({ type: 'resize', id: kept, rect: { x: 0, y: 0, w: 400, h: 120 } });
    store.dispatch({ type: 'delete', ids: [gone] });
    for (const land of lands) land({ url: 'x', title: 'T', image: 'https://a.example.test/i.png' });
    await settle();
    expect(store.getDocument().objects[kept]).toMatchObject({ title: 'T', w: 400, h: 120 });
    expect(store.getDocument().objects[gone]).toBeUndefined();
  });

  test('a paste is a card only when it is one address, or something the host knows as its own', () => {
    expect(pastedUrl('see https://example.test/ for more')).toBeNull();
    expect(pastedUrl('javascript:alert(1)')).toBeNull();
    expect(referenceFromPaste('just words')).toBeNull();
    const host = (text: string) => (text.startsWith('artifact:') ? { target: { kind: 'artifact' as const, artifact: text.slice(9), artifactKind: 'image' as const }, title: 'shot.png' } : null);
    expect(referenceFromPaste('artifact:shots/shot.png', host)).toMatchObject({ target: { kind: 'artifact', artifact: 'shots/shot.png' } });
    expect(referenceFromPaste('https://example.test/', host)).toMatchObject({ target: { kind: 'web' } });
  });

  test('an agent adds cards with the same command, and a card may not carry an unsafe address', () => {
    const store = new CanvasStore(createDocument('board'));
    const card = { id: 'r1', type: 'reference', x: 0, y: 0, w: 280, h: 84 };
    const added = store.dispatch(
      {
        type: 'add',
        objects: [
          { ...card, target: { kind: 'plan', anchor: 'Rollout' }, title: 'Rollout' },
          { ...card, id: 'r2', target: { kind: 'artifact', artifact: 'a1', artifactKind: 'video' }, color: 'blue' },
        ] as never,
      },
      { actor: { kind: 'agent', id: 'a' } },
    );
    expect(added.ok).toBe(true);
    expect(store.dispatch({ type: 'add-snapshot', snapshot: { id: 's', title: '', source: { kind: 'objects', objects: ['r1', 'r2'] } } }).ok).toBe(true);
    for (const bad of [
      { ...card, target: { kind: 'web', url: 'javascript:alert(1)' } },
      { ...card, target: { kind: 'web', url: 'file:///etc/passwd' } },
      { ...card, target: { kind: 'artifact', artifact: 'a', artifactKind: 'exe' } },
      { ...card, target: { kind: 'web', url: 'https://example.test/' }, image: 'javascript:alert(1)' },
      { ...card, target: { kind: 'nothing' } },
    ]) {
      expect(checkObject(bad).ok).toBe(false);
    }
  });
});
