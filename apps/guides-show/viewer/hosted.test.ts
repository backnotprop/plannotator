/**
 * The hosted boot helpers are pure enough to test without a browser: the
 * error mapping (which card a reader sees) and the viewer pin rebuilt from
 * the DOM (which decides whether the client-side download opens at all).
 * The full boot path is covered by the headless smoke, not here.
 */
import { describe, expect, test } from 'bun:test';
import { FIXTURE_V1_PR } from '@plannotator/core/guide-format-fixtures';
import { GUIDE_HOSTED_META_NAME, GUIDE_PAYLOAD_META_NAME, guideExportFilename, readEmbeddedGuideSnapshot } from '@plannotator/core/guide-format';
import { compress } from '@plannotator/core/compress';
import { encrypt } from '@plannotator/core/crypto';
import { buildPortableGuideFile, loadHostedEncryptedSnapshot, readShareKey, readViewerAssetsFromDocument, type ViewerDocumentLike } from './hosted';

const PAYLOAD_URL = 'https://guides.example/api/g/abc';

function fakeFetch(body: string | null, status = 200): typeof fetch {
  const impl = async () => (body === null ? new Response('{"error":"not found"}', { status: 404 }) : new Response(body, { status }));
  return impl as unknown as typeof fetch;
}

describe('readShareKey', () => {
  test('reads key= from the fragment and nothing else', () => {
    expect(readShareKey('#key=abc-DEF_123')).toBe('abc-DEF_123');
    expect(readShareKey('key=abc')).toBe('abc');
    expect(readShareKey('#other=1&key=zzz')).toBe('zzz');
    expect(readShareKey('')).toBeNull();
    expect(readShareKey('#')).toBeNull();
    expect(readShareKey('#key=')).toBeNull();
    expect(readShareKey('#other=1')).toBeNull();
  });
});

describe('loadHostedEncryptedSnapshot', () => {
  test('round-trips encrypt(compress(snapshot)) with the key from the fragment', async () => {
    const { ciphertext, key } = await encrypt(await compress(FIXTURE_V1_PR));
    const result = await loadHostedEncryptedSnapshot(PAYLOAD_URL, `#key=${key}`, fakeFetch(ciphertext));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.snapshot).toEqual(FIXTURE_V1_PR);
  });

  test('a link without its fragment is missing-key and never fetches', async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response('x');
    }) as unknown as typeof fetch;
    const result = await loadHostedEncryptedSnapshot(PAYLOAD_URL, '', counting);
    expect(result.kind).toBe('missing-key');
    expect(calls).toBe(0);
  });

  test('a 404 or a network failure is unavailable, not wrong-key', async () => {
    const gone = await loadHostedEncryptedSnapshot(PAYLOAD_URL, '#key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', fakeFetch(null));
    expect(gone.kind).toBe('unavailable');
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const down = await loadHostedEncryptedSnapshot(PAYLOAD_URL, '#key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', failing);
    expect(down.kind).toBe('unavailable');
  });

  test('a body that arrives but does not open with the key is wrong-key', async () => {
    const { ciphertext } = await encrypt(await compress(FIXTURE_V1_PR));
    const { key: otherKey } = await encrypt('unrelated');
    const result = await loadHostedEncryptedSnapshot(PAYLOAD_URL, `#key=${otherKey}`, fakeFetch(ciphertext));
    expect(result.kind).toBe('wrong-key');
  });

  test('a payload that decrypts to something other than a guide is invalid with a path', async () => {
    const { ciphertext, key } = await encrypt(await compress({ kind: 'not-a-guide' }));
    const result = await loadHostedEncryptedSnapshot(PAYLOAD_URL, `#key=${key}`, fakeFetch(ciphertext));
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.path.length).toBeGreaterThan(0);
  });
});

describe('readViewerAssetsFromDocument + buildPortableGuideFile', () => {
  const SCRIPT_URL = 'https://guides.show/v1/viewer.abc123.js';

  /** A DOM-free stand-in: elements are attribute bags, selectors are matched by tag + rel/type. */
  function hostedDocument(overrides: { cssHref?: string } = {}): ViewerDocumentLike {
    const el = (attrs: Record<string, string>) => ({ getAttribute: (name: string) => attrs[name] ?? null });
    const link = el({ rel: 'stylesheet', href: overrides.cssHref ?? 'https://guides.show/v1/viewer.def456.css', integrity: 'sha384-css' });
    const script = el({ type: 'module', src: SCRIPT_URL, integrity: 'sha384-js' });
    return {
      baseURI: 'https://guides.show/g/id',
      querySelectorAll: (selectors: string) => (selectors.startsWith('link') ? [link] : selectors.startsWith('script') ? [script] : []),
    };
  }

  test('rebuilds the pin from the stylesheet and module script this page loaded', () => {
    const viewer = readViewerAssetsFromDocument(hostedDocument(), SCRIPT_URL);
    expect(viewer).toEqual({
      baseUrl: 'https://guides.show/v1/',
      js: 'viewer.abc123.js',
      css: 'viewer.def456.css',
      jsIntegrity: 'sha384-js',
      cssIntegrity: 'sha384-css',
    });
  });

  test('gives up when the stylesheet is not under the script directory', () => {
    expect(readViewerAssetsFromDocument(hostedDocument({ cssHref: 'https://elsewhere.example/other.css' }), SCRIPT_URL)).toBeNull();
  });

  test('resolves relative asset URLs against the page, as the browser did when loading them', () => {
    const doc = hostedDocument({ cssHref: '/v1/viewer.def456.css' });
    expect(readViewerAssetsFromDocument(doc, SCRIPT_URL)?.css).toBe('viewer.def456.css');
  });

  test('the client-built file is a plain export: embedded snapshot, pinned viewer, no host metas', () => {
    const viewer = readViewerAssetsFromDocument(hostedDocument(), SCRIPT_URL)!;
    const file = buildPortableGuideFile(FIXTURE_V1_PR, viewer)!;
    expect(file.filename).toBe(guideExportFilename(FIXTURE_V1_PR.guide.title));
    expect(file.html).toContain(`src="${SCRIPT_URL}" integrity="sha384-js"`);
    expect(file.html).toContain('href="https://guides.show/v1/viewer.def456.css" integrity="sha384-css"');
    expect(file.html).not.toContain(GUIDE_HOSTED_META_NAME);
    expect(file.html).not.toContain(GUIDE_PAYLOAD_META_NAME);
    const embedded = /<script id="plannotator-guided-review" type="application\/json">([\s\S]*?)<\/script>/.exec(file.html);
    const parsed = readEmbeddedGuideSnapshot({ getElementById: () => (embedded ? { textContent: embedded[1] } : null) });
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) expect(parsed.value).toEqual(FIXTURE_V1_PR);
  });

  test('refuses a viewer base createGuideHtml would not accept (plain http off localhost)', () => {
    const viewer = { baseUrl: 'http://10.0.0.5/v1/', js: 'viewer.js', css: 'viewer.css' };
    expect(buildPortableGuideFile(FIXTURE_V1_PR, viewer)).toBeNull();
  });
});
