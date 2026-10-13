/**
 * Pi `/plannotator-review` delivery through the real Pi review server: what
 * the browser posts to /api/feedback, what the decision carries, and whether
 * the agent message gets the verification suffix.
 *
 * Guards the 0.28.0 regression where "zero code annotations" was read as the
 * PR-platform status post: feedback made only of PR description, PR comment
 * or editor comments rides only in `feedback`, so it has an empty
 * `annotations` array and must still be delivered as feedback. Only the
 * server-carried `platform: true` (sent by the platform path's status post)
 * marks the status post.
 *
 * Temp PLANNOTATOR_DATA_DIR per test; AI off; no browser.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyReviewOutcome } from './review-outcome.ts';
import { startReviewServer } from './server/serverReview.ts';

const ENV_KEYS = ['PLANNOTATOR_AI', 'PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_PORT', 'PLANNOTATOR_REMOTE', 'PLANNOTATOR_BROWSER'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const tempDirs: string[] = [];

const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';

function sandbox(): void {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.PLANNOTATOR_AI = 'disabled';
  process.env.PLANNOTATOR_REMOTE = '0';
  process.env.PLANNOTATOR_BROWSER = '/usr/bin/true';
  delete process.env.PLANNOTATOR_PORT;
  const dataDir = mkdtempSync(join(tmpdir(), 'plannotator-pi-review-outcome-'));
  tempDirs.push(dataDir);
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function decide(body: Record<string, unknown>) {
  sandbox();
  const server = await startReviewServer({
    rawPatch: PATCH,
    gitRef: 'HEAD',
    htmlContent: '<!doctype html><html><body>review</body></html>',
  });
  try {
    const res = await fetch(`${server.url}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.ok).toBe(true);
    return await server.waitForDecision();
  } finally {
    server.stop();
  }
}

describe('Pi review delivery', () => {
  test.each([
    ['PR description comments', '## PR description\n\n> Adds the parser\n\nExplain the fallback.'],
    ['PR comment notes', '## PR comments\n\n> @alice: looks risky\n\nAgree, split this.'],
    ['VS Code editor comments', '# Editor Annotations\n\n## src/a.ts:3\n\nRename this.'],
  ])('feedback made only of %s is delivered with the suffix', async (_label, feedback) => {
    const decision = await decide({ approved: false, feedback, annotations: [] });
    expect('platform' in decision).toBe(false);
    expect(classifyReviewOutcome(decision)).toEqual({ kind: 'feedback', appendDeniedSuffix: true });
  });

  test('the marked platform status post is delivered verbatim', async () => {
    const decision = await decide({
      approved: false,
      feedback: 'Pull request reviewed on GitHub: https://github.com/o/r/pull/1',
      annotations: [],
      platform: true,
    });
    expect(decision.platform).toBe(true);
    expect(classifyReviewOutcome(decision)).toEqual({ kind: 'feedback', appendDeniedSuffix: false });
  });

  test('an empty submit stays a quiet close', async () => {
    const decision = await decide({ approved: false, feedback: '', annotations: [] });
    expect(classifyReviewOutcome(decision)).toEqual({ kind: 'no-feedback' });
  });
});
