/**
 * Pi parity for Bitbucket Cloud PR review: the vendored provider
 * (generated/pr-bitbucket.ts via pr-provider.ts) fetches the PR from the
 * local fake Bitbucket API, and the Pi review server serves its context and
 * posts a review back through it — the same chain the Bun CLI test covers.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeBitbucket, type FakeBitbucket } from '../../tests/test-fixtures/bitbucket/fake-bitbucket.ts';
import { fetchPR, parsePRUrl } from './server/pr.ts';
import { startReviewServer } from './server/serverReview.ts';

const KEYS = ['PLANNOTATOR_AI', 'PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_PORT', 'PLANNOTATOR_BITBUCKET_API_URL', 'PLANNOTATOR_BITBUCKET_EMAIL', 'PLANNOTATOR_BITBUCKET_TOKEN'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let fake: FakeBitbucket | undefined;
let dataDir: string | undefined;

afterEach(() => {
  fake?.stop();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('Pi reviews a Bitbucket PR: diff, comments, and a posted review', async () => {
  fake = startFakeBitbucket({ email: 'ada@example.invalid', token: 'pi-fake-token' });
  dataDir = mkdtempSync(join(tmpdir(), 'plannotator-pi-bb-'));
  process.env.PLANNOTATOR_AI = 'disabled';
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_PORT;
  process.env.PLANNOTATOR_BITBUCKET_API_URL = fake.apiUrl;
  process.env.PLANNOTATOR_BITBUCKET_EMAIL = 'ada@example.invalid';
  process.env.PLANNOTATOR_BITBUCKET_TOKEN = 'pi-fake-token';

  const ref = parsePRUrl('https://bitbucket.org/ws/repo/pull-requests/1');
  expect(ref?.platform).toBe('bitbucket');
  const pr = await fetchPR(ref!);
  const server = await startReviewServer({
    rawPatch: pr.rawPatch,
    gitRef: 'PR #1',
    htmlContent: '<!doctype html><html><body>review</body></html>',
    prMetadata: pr.metadata,
  });
  try {
    const diff = await (await fetch(`${server.url}/api/diff`)).json() as Record<string, any>;
    expect(diff.prMetadata.platform).toBe('bitbucket');
    expect(diff.platformUser).toBe('Ada Reviewer');

    const ctx = await (await fetch(`${server.url}/api/pr-context`)).json() as Record<string, any>;
    expect(ctx.reviewThreads.length).toBeGreaterThan(0);

    const res = await fetch(`${server.url}/api/pr-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'request_changes',
        body: 'From Pi.',
        fileComments: [{ path: 'notes.txt', line: 1, side: 'LEFT', body: 'Keep this?' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(fake.requests.filter((r) => r.method === 'POST').map((r) => r.path.split('/pullrequests/1')[1])).toEqual([
      '/comments', '/comments', '/request-changes',
    ]);
  } finally {
    server.stop();
  }
});
