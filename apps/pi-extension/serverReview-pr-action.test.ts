import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PRMetadata,
  PRReviewFileComment,
  PRReviewSubmissionResult,
} from './generated/pr-types.ts';
import { startReviewServer } from './server/serverReview.ts';

const originalAI = process.env.PLANNOTATOR_AI;
const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPath = process.env.PATH;
const originalPort = process.env.PLANNOTATOR_PORT;
const tempDirs: string[] = [];

const prMetadata: PRMetadata = {
  platform: 'gitlab',
  host: 'gitlab.invalid',
  projectPath: 'acme/widgets',
  iid: 7,
  title: 'Reliable comments',
  author: 'reviewer',
  baseBranch: 'main',
  headBranch: 'feature',
  baseSha: 'base',
  headSha: 'head',
  url: 'https://gitlab.invalid/acme/widgets/-/merge_requests/7',
};

const fileComment: PRReviewFileComment = {
  path: 'src/failing.ts',
  line: 19,
  side: 'RIGHT',
  body: 'Handle this failure.',
};

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalAI === undefined) delete process.env.PLANNOTATOR_AI;
  else process.env.PLANNOTATOR_AI = originalAI;
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withReviewServer(
  submit: () => Promise<PRReviewSubmissionResult>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  process.env.PLANNOTATOR_AI = 'disabled';
  process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-pi-pr-action-data-');
  process.env.PATH = makeTempDir('plannotator-pi-pr-action-path-');
  delete process.env.PLANNOTATOR_PORT;
  const server = await startReviewServer({
    rawPatch: 'diff --git a/src/failing.ts b/src/failing.ts\n',
    gitRef: 'MR !7',
    htmlContent: '<!doctype html><html><body>review</body></html>',
    prMetadata,
    prReviewSubmitter: async () => submit(),
  });
  try {
    await run(server.url);
  } finally {
    server.stop();
  }
}

async function postReview(url: string): Promise<Response> {
  return fetch(`${url}/api/pr-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'comment',
      body: 'Overall review',
      fileComments: [fileComment],
    }),
  });
}

describe('Pi /api/pr-action submission contract', () => {
  test('returns complete success', async () => {
    await withReviewServer(
      async () => ({ status: 'complete' }),
      async (url) => {
        const response = await postReview(url);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          ok: true,
          submission: { status: 'complete' },
        });
      },
    );
  });

  test('returns an all-failure as an error', async () => {
    await withReviewServer(
      async () => {
        throw new Error('Failed to post inline comments');
      },
      async (url) => {
        const response = await postReview(url);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: 'Failed to post inline comments',
        });
      },
    );
  });

  test('preserves the actionable mixed-outcome response', async () => {
    const partial: PRReviewSubmissionResult = {
      status: 'partial',
      postedFileCommentCount: 1,
      failedFileComments: [{
        comment: fileComment,
        error: 'src/failing.ts:19: rejected',
      }],
      reviewBodyPosted: true,
      approval: 'not-requested',
      recoveryFile: '/tmp/failed-comments/review.json',
      retry: {
        action: 'comment',
        fileComments: [fileComment],
      },
    };
    await withReviewServer(
      async () => partial,
      async (url) => {
        const response = await postReview(url);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          ok: true,
          prUrl: prMetadata.url,
          submission: partial,
        });
      },
    );
  });
});
