/**
 * Pi mirror of packages/server/review-draft-pr.test.ts: /api/draft in PR mode survives a changed PR diff (#1590), and every
 * decision clears it under both keys. Local reviews keep the content-hash key.
 *
 * Temp PLANNOTATOR_DATA_DIR per test; PATH emptied so no platform CLI runs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PRMetadata } from './generated/pr-types.ts';
import { startReviewServer } from './server/serverReview.ts';

const ENV_KEYS = ['PLANNOTATOR_AI', 'PLANNOTATOR_DATA_DIR', 'PATH', 'PLANNOTATOR_PORT', 'PLANNOTATOR_REMOTE', 'PLANNOTATOR_BROWSER'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const tempDirs: string[] = [];

const prMetadata: PRMetadata = {
  platform: 'github',
  host: 'github.invalid',
  owner: 'acme',
  repo: 'widgets',
  number: 42,
  title: 'Keep drafts',
  author: 'someone',
  baseBranch: 'main',
  headBranch: 'feature',
  baseSha: 'base',
  headSha: 'head',
  url: 'https://github.invalid/acme/widgets/pull/42',
};

const PATCH_BEFORE_PUSH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
const PATCH_AFTER_PUSH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+c\n';

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sandbox(): string {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.PLANNOTATOR_AI = 'disabled';
  process.env.PLANNOTATOR_REMOTE = '0';
  process.env.PLANNOTATOR_BROWSER = '/usr/bin/true';
  delete process.env.PLANNOTATOR_PORT;
  process.env.PATH = makeTempDir('plannotator-draft-pr-path-');
  const dataDir = makeTempDir('plannotator-draft-pr-data-');
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  return dataDir;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function withSession(
  rawPatch: string,
  pr: PRMetadata | undefined,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = await startReviewServer({
    rawPatch,
    gitRef: pr ? 'PR #42' : 'HEAD',
    htmlContent: '<!doctype html><html><body>review</body></html>',
    ...(pr ? { prMetadata: pr } : {}),
  });
  try {
    await run(server.url);
  } finally {
    server.stop();
  }
}

const draftBody = (generation: number) => ({
  codeAnnotations: [{ id: 'c1', type: 'comment', scope: 'line', filePath: 'src/a.ts', lineStart: 1, lineEnd: 1, side: 'new', text: 'unsent', anchorText: 'b', createdAt: 1 }],
  draftGeneration: generation,
  ts: 1,
});

async function saveDraft(url: string, generation: number): Promise<void> {
  const res = await fetch(`${url}/api/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draftBody(generation)),
  });
  expect(res.status).toBe(200);
}

describe('PR review drafts across a push', () => {
  test('reopening the PR after new commits restores the unsent comments, flagged as a changed patch', async () => {
    sandbox();
    await withSession(PATCH_BEFORE_PUSH, prMetadata, (url) => saveDraft(url, 3));
    await withSession(PATCH_AFTER_PUSH, prMetadata, async (url) => {
      const res = await fetch(`${url}/api/draft`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.codeAnnotations[0].text).toBe('unsent');
      expect(body.patchChanged).toBe(true);
    });
  });

  test('reopening on the unchanged patch restores exactly as before (no patchChanged)', async () => {
    sandbox();
    await withSession(PATCH_BEFORE_PUSH, prMetadata, (url) => saveDraft(url, 3));
    await withSession(PATCH_BEFORE_PUSH, prMetadata, async (url) => {
      const body = await (await fetch(`${url}/api/draft`)).json();
      expect(body).toEqual(draftBody(3));
      expect(body.patchChanged).toBeUndefined();
    });
  });

  for (const decision of ['feedback', 'exit'] as const) {
    test(`${decision} after a push clears the draft under both keys, so no later session sees it`, async () => {
      sandbox();
      await withSession(PATCH_BEFORE_PUSH, prMetadata, (url) => saveDraft(url, 3));
      await withSession(PATCH_AFTER_PUSH, prMetadata, async (url) => {
        const res = decision === 'feedback'
          ? await fetch(`${url}/api/feedback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ feedback: 'x', annotations: [], draftGeneration: 4 }),
            })
          : await fetch(`${url}/api/exit?draftGeneration=4`, { method: 'POST' });
        expect(res.status).toBe(200);
      });
      for (const patch of [PATCH_BEFORE_PUSH, PATCH_AFTER_PUSH]) {
        await withSession(patch, prMetadata, async (url) => {
          expect((await fetch(`${url}/api/draft`)).status).toBe(404);
        });
      }
    });
  }

  test('a stale tab on the pre-push patch cannot resurrect a draft deleted after the push', async () => {
    sandbox();
    await withSession(PATCH_BEFORE_PUSH, prMetadata, async (staleTab) => {
      await saveDraft(staleTab, 3);
      await withSession(PATCH_AFTER_PUSH, prMetadata, async (fresh) => {
        await fetch(`${fresh}/api/draft?generation=4`, { method: 'DELETE' });
      });
      // The stale tab's debounced save lands after the delete, same generation:
      // refused (409), and nothing is written.
      const late = await fetch(`${staleTab}/api/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftBody(4)),
      });
      expect(late.status).toBe(409);
      expect((await fetch(`${staleTab}/api/draft`)).status).toBe(404);
    });
    await withSession(PATCH_AFTER_PUSH, prMetadata, async (url) => {
      const res = await fetch(`${url}/api/draft`);
      expect(res.status).toBe(404);
      expect((await res.json()).draftGeneration).toBe(4);
    });
  });
});

describe('local reviews are unchanged', () => {
  test('a changed local diff still misses the draft, and only the content-hash file is written', async () => {
    const dataDir = sandbox();
    await withSession(PATCH_BEFORE_PUSH, undefined, (url) => saveDraft(url, 3));
    const files = readdirSync(join(dataDir, 'drafts'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.json$/);
    await withSession(PATCH_AFTER_PUSH, undefined, async (url) => {
      expect((await fetch(`${url}/api/draft`)).status).toBe(404);
    });
  });
});


// ---------------------------------------------------------------------------
// In-place switches (#1590 review items 1 and 2). /api/pr-switch fetches the
// target PR through the server's `prFetcher` test seam, so no platform CLI or
// network is involved; the PRs live on an unresolvable host.
// ---------------------------------------------------------------------------

const PATCH_PR_43 = 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-x\n+y\n';
const pr43: PRMetadata = { ...prMetadata, number: 43, url: 'https://github.invalid/acme/widgets/pull/43' };
const fakeFetcher = async (ref: { number?: number }) => {
  if (ref.number !== 43) throw new Error('unexpected PR');
  return { metadata: pr43, rawPatch: PATCH_PR_43 };
};

async function withSwitchableSession(
  rawPatch: string,
  pr: PRMetadata,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = await startReviewServer({
    rawPatch,
    gitRef: 'PR',
    htmlContent: '<!doctype html><html><body>review</body></html>',
    prMetadata: pr,
    prFetcher: fakeFetcher as never,
  });
  try {
    await run(server.url);
  } finally {
    server.stop();
  }
}

async function switchTo43(url: string): Promise<{ draftState?: { found: boolean; draftGeneration: number | null } }> {
  const res = await fetch(`${url}/api/pr-switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: pr43.url }),
  });
  if (res.status !== 200) throw new Error(`pr-switch ${res.status}: ${await res.text()}`);
  return res.json();
}

describe('in-place PR switches', () => {
  test('submitting after switching A→B clears A too, so its comments do not come back after a push', async () => {
    sandbox();
    await withSwitchableSession(PATCH_BEFORE_PUSH, prMetadata, async (url) => {
      await saveDraft(url, 3); // saved on A (#42)
      await switchTo43(url);
      await saveDraft(url, 4); // saved on B (#43)
      const res = await fetch(`${url}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: 'x', annotations: [], draftGeneration: 5 }),
      });
      expect(res.status).toBe(200);
    });
    // A teammate pushes to #42; reopening it must not offer the submitted comments.
    await withSession(PATCH_AFTER_PUSH, prMetadata, async (url) => {
      expect((await fetch(`${url}/api/draft`)).status).toBe(404);
    });
    await withSession(PATCH_PR_43, pr43, async (url) => {
      expect((await fetch(`${url}/api/draft`)).status).toBe(404);
    });
  });

  test('switching onto a PR submitted in an earlier session reports its generation floor, and a stale save is refused, not swallowed', async () => {
    sandbox();
    // Earlier session on #43: saved at 39, closed at 40.
    await withSession(PATCH_PR_43, pr43, async (url) => {
      await saveDraft(url, 39);
      await fetch(`${url}/api/exit?draftGeneration=40`, { method: 'POST' });
    });
    await withSwitchableSession(PATCH_BEFORE_PUSH, prMetadata, async (url) => {
      const switched = await switchTo43(url);
      expect(switched.draftState).toEqual({ found: false, draftGeneration: 40 });
      const stale = await fetch(`${url}/api/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftBody(5)),
      });
      expect(stale.status).toBe(409);
      expect((await stale.json()).ok).toBe(false);
      // A client that adopted the floor saves normally.
      await saveDraft(url, 41);
    });
  });

  test('switching onto a PR with an unsent draft reports it, so the client can offer it instead of overwriting it', async () => {
    sandbox();
    await withSession(PATCH_PR_43, pr43, (url) => saveDraft(url, 12));
    await withSwitchableSession(PATCH_BEFORE_PUSH, prMetadata, async (url) => {
      const switched = await switchTo43(url);
      expect(switched.draftState).toEqual({ found: true, draftGeneration: 12 });
      const body = await (await fetch(`${url}/api/draft`)).json();
      expect(body.codeAnnotations[0].text).toBe('unsent');
    });
  });
});
