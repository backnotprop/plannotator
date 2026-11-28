import { describe, expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import {
  SEM_DIFF_FILES,
  SEM_DIFF_ROUTE_PREFIX,
  answerSemDiffRequest,
  createSemDiffAssets,
  type SemDiffSources,
} from './sem-diff-assets';

const sources = Object.fromEntries(
  SEM_DIFF_FILES.map((name, i) => [name, new Uint8Array(Array.from({ length: 4096 }, (_, j) => (i + j) % 7))]),
) as SemDiffSources;

describe('sem-diff assets', () => {
  test('advertises every file under the route with a content hash', async () => {
    const assets = createSemDiffAssets(sources);
    const advert = await assets.advert();
    expect(advert?.runtime).toMatch(new RegExp(`^${SEM_DIFF_ROUTE_PREFIX}web-tree-sitter-[0-9a-f]{16}\\.wasm$`));
    expect(Object.keys(advert!.grammars).sort()).toEqual(SEM_DIFF_FILES.filter((f) => f !== 'web-tree-sitter.wasm').sort());
    expect(await assets.file(advert!.runtime)).toEqual(sources['web-tree-sitter.wasm']);
  });

  test('a host without the files advertises nothing and serves nothing', async () => {
    const missing = createSemDiffAssets(async () => null);
    expect(await missing.advert()).toBeUndefined();
    const answer = await answerSemDiffRequest(missing, `${SEM_DIFF_ROUTE_PREFIX}web-tree-sitter-0.wasm`, 'GET', null, false);
    expect(answer.status).toBe(404);
    const partial = { ...sources, 'tree-sitter-go.wasm': new Uint8Array() };
    expect(await createSemDiffAssets(partial).advert()).toBeUndefined();
  });

  test('serves wasm as immutable, rejects other methods and unknown names', async () => {
    const assets = createSemDiffAssets(sources);
    const path = (await assets.advert())!.runtime;
    const ok = await answerSemDiffRequest(assets, path, 'GET', null, false);
    expect(ok.status).toBe(200);
    expect(ok.headers['Content-Type']).toBe('application/wasm');
    expect(ok.headers['Cache-Control']).toContain('immutable');
    expect(ok.headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(ok.body).toEqual(sources['web-tree-sitter.wasm']);
    const head = await answerSemDiffRequest(assets, path, 'HEAD', null, false);
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect((await answerSemDiffRequest(assets, path, 'POST', null, false)).status).toBe(405);
    expect((await answerSemDiffRequest(assets, `${SEM_DIFF_ROUTE_PREFIX}web-tree-sitter.wasm`, 'GET', null, false)).status).toBe(404);
  });

  test('compresses only for sessions that compress the app page', async () => {
    const assets = createSemDiffAssets(sources);
    const path = (await assets.advert())!.runtime;
    const local = await answerSemDiffRequest(assets, path, 'GET', 'gzip', false);
    expect(local.headers['Content-Encoding']).toBeUndefined();
    const remote = await answerSemDiffRequest(assets, path, 'GET', 'gzip', true);
    expect(remote.headers['Content-Encoding']).toBe('gzip');
    expect(new Uint8Array(gunzipSync(remote.body as Uint8Array))).toEqual(sources['web-tree-sitter.wasm']);
  });
});
