import { describe, expect, test } from 'bun:test';
import { CanvasStore } from '../events/store';
import { checkObject } from '../model/codec';
import { createDocument } from '../model/document';
import { pastedUrl, referenceCard } from '../model/reference';
import type { ReferenceObject } from '../model/types';
import { CARD_SIZE, CARD_SIZE_WITH_IMAGE, addReference, referenceFromPaste } from '../react/references';
import { createUnfurler, isPrivateAddress, unfurlUrl } from './fetch';
import { parseLinkPreview } from './parse';
import { createUnfurlHandler } from './route';

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
    for (const address of ['file:///etc/passwd', 'ftp://example.test/', 'javascript:alert(1)', 'http://localhost:8080/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.1.1/admin', 'http://[::1]/', 'https://user:pass@example.test/']) {
      expect(await unfurlUrl(address, { fetch })).toBeNull();
    }
    expect(calls).toEqual([]);
    expect(await unfurlUrl('https://public.example.test/', { fetch })).toEqual({ url: 'https://public.example.test/', site: 'public.example.test' });
    expect(calls).toEqual(['https://public.example.test/']);
    // A public-looking name that resolves to a private address is refused too.
    expect(await unfurlUrl('https://named.example.test/', { fetch, lookup: async () => ['10.0.0.7'] })).toBeNull();
    expect(await unfurlUrl('https://named.example.test/', { fetch, lookup: async () => ['93.184.216.34'] })).toMatchObject({ title: 'Inside' });
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  test('the same address asked twice is fetched once', async () => {
    const { fetch, calls } = net({ 'https://notes.example.test/posts/1': html(PAGE) });
    const unfurl = createUnfurler({ fetch });
    const [a, b] = await Promise.all([unfurl('https://notes.example.test/posts/1'), unfurl('https://notes.example.test/posts/1')]);
    expect(a).toEqual(b);
    await unfurl('https://notes.example.test/posts/1');
    expect(calls).toHaveLength(1);
  });

  test('the route answers with JSON, or with nothing for an address it will not preview', async () => {
    const { fetch } = net({ 'https://notes.example.test/posts/1': html(PAGE) });
    const handle = createUnfurlHandler({ fetch });
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
