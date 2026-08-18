import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewServer as startBunReviewServer } from './review';
import { startReviewServer as startPiReviewServer } from '../../apps/pi-extension/server';

// Config reads resolve the data dir lazily, so per-test PLANNOTATOR_DATA_DIR
// sandboxes genuinely isolate settings POSTs. Snapshot the real config anyway
// as a safety net: a regression back to a process-frozen config path must not
// corrupt the developer's real configuration.
const { getPlannotatorDataDir } = await import('@plannotator/shared/data-dir');
const realConfigPath = join(getPlannotatorDataDir(), 'config.json');
let realConfigSnapshot: Buffer | null = null;
try {
  realConfigSnapshot = readFileSync(realConfigPath);
} catch {
  realConfigSnapshot = null;
}

const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPort = process.env.PLANNOTATOR_PORT;
const originalPath = process.env.PATH;
const originalCallDiffPath = process.env.PLANNOTATOR_CALLDIFF_PATH;
const tempDirs: string[] = [];

function makeDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'plannotator-call-flow-endpoint-'));
  tempDirs.push(dataDir);
  return dataDir;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalCallDiffPath === undefined) delete process.env.PLANNOTATOR_CALLDIFF_PATH;
  else process.env.PLANNOTATOR_CALLDIFF_PATH = originalCallDiffPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  // Restore the exact bytes present before this suite, or restore absence
  // when no config existed. This mirrors call-flow-install-endpoint.test.ts.
  try {
    if (realConfigSnapshot === null) rmSync(realConfigPath, { force: true });
    else writeFileSync(realConfigPath, realConfigSnapshot);
  } catch {
    // Best effort: an unwritable config directory must not fail the suite.
  }
});

describe('Call flow endpoint capability guards', () => {
  for (const [runtime, startServer] of [
    ['Bun', startBunReviewServer],
    ['Pi', startPiReviewServer],
  ] as const) {
    test(`${runtime} returns the server-authored install disclosure while Call flow is disabled`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeDataDir();
      delete process.env.PLANNOTATOR_CALLDIFF_PATH;
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const server = await startServer({
        rawPatch: [
          'diff --git a/tool.py b/tool.py',
          '--- a/tool.py',
          '+++ b/tool.py',
          '@@ -1 +1 @@',
          '-pass',
          "+print('changed')",
        ].join('\n'),
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });

      try {
        const response = await fetch(`${server.url}/api/review-analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ semanticDiff: false, callFlow: false }),
        });
        const settings = await response.json() as {
          callFlow?: {
            enabled: boolean;
            state: string;
            installable?: boolean;
            consentPlan?: { languageIds: string[]; installSizeBytes: number };
          };
        };
        expect(settings.callFlow).toMatchObject({
          enabled: false,
          state: 'disabled',
          installable: true,
          consentPlan: {
            languageIds: ['javascript-typescript', 'python'],
            installSizeBytes: 6 * 1024 * 1024,
          },
        });
      } finally {
        server.stop();
      }
    });

    test(`${runtime} returns unsupported for All Files before runtime execution`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeDataDir();
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const server = await startServer({
        rawPatch: '',
        gitRef: 'All files',
        diffType: 'all',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });

      try {
        const initial = await fetch(`${server.url}/api/diff`).then((response) => response.json()) as {
          snapshotId: string;
        };
        const disabled = await fetch(`${server.url}/api/review-analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ semanticDiff: false, callFlow: false }),
        }).then((response) => response.json()) as {
          callFlow?: { state: string; reason?: string; consentPlan?: unknown };
        };
        expect(disabled.callFlow).toMatchObject({ state: 'disabled', reason: 'view-unsupported' });
        expect(disabled.callFlow?.consentPlan).toBeUndefined();

        const settings = await fetch(`${server.url}/api/review-analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ semanticDiff: false, callFlow: true }),
        }).then((response) => response.json()) as { callFlow?: { state: string } };
        expect(settings.callFlow?.state).toBe('unsupported');

        const direct = await fetch(
          `${server.url}/api/call-flow?snapshot=${encodeURIComponent(initial.snapshotId)}`,
        ).then((response) => response.json()) as { status: string; reason: string };
        expect(direct).toMatchObject({ status: 'unsupported', reason: 'view-unsupported' });
      } finally {
        server.stop();
      }
    });

    test.skipIf(process.platform === 'win32')(`${runtime} supersedes an older overlapping settings response`, async () => {
      const dataDir = makeDataDir();
      const binDir = mkdtempSync(join(tmpdir(), 'plannotator-call-flow-node-'));
      tempDirs.push(binDir);
      const startedPath = join(binDir, 'started');
      const releasePath = join(binDir, 'release');
      const nodePath = join(binDir, 'node');
      writeFileSync(nodePath, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `: > ${JSON.stringify(startedPath)}`,
        `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.02; done`,
        'echo v24.0.0',
        '',
      ].join('\n'), 'utf8');
      chmodSync(nodePath, 0o755);
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const server = await startServer({
        rawPatch: '',
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });

      try {
        const older = fetch(`${server.url}/api/review-analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ semanticDiff: false, callFlow: true }),
        });
        await waitForFile(startedPath);
        const current = await fetch(`${server.url}/api/review-analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ semanticDiff: false, callFlow: false }),
        }).then((response) => response.json()) as { callFlow?: { state: string } };
        expect(current.callFlow?.state).toBe('disabled');

        writeFileSync(releasePath, 'release\n', 'utf8');
        await expect(older.then((response) => response.json())).resolves.toEqual({ superseded: true });
      } finally {
        if (!existsSync(releasePath)) writeFileSync(releasePath, 'release\n', 'utf8');
        server.stop();
      }
    }, 10_000);

    test.skipIf(process.platform === 'win32')(`${runtime} read-only advert refresh begun during a settings mutation yields`, async () => {
      const dataDir = makeDataDir();
      const binDir = mkdtempSync(join(tmpdir(), 'plannotator-call-flow-read-node-'));
      tempDirs.push(binDir);
      const startedPath = join(binDir, 'started');
      const releasePath = join(binDir, 'release');
      const nodePath = join(binDir, 'node');
      writeFileSync(nodePath, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `: > ${JSON.stringify(startedPath)}`,
        `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.02; done`,
        'echo v24.0.0',
        '',
      ].join('\n'), 'utf8');
      chmodSync(nodePath, 0o755);
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const server = await startServer({
        rawPatch: '',
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });

      try {
        const mutation = fetch(`${server.url}/api/review-analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ semanticDiff: false, callFlow: true }),
        });
        await waitForFile(startedPath);
        const refresh = fetch(`${server.url}/api/review-analysis`);
        writeFileSync(releasePath, 'release\n', 'utf8');
        const [mutationBody, refreshBody] = await Promise.all([
          mutation.then((response) => response.json()) as Promise<{ superseded?: boolean; callFlow?: { enabled: boolean } }>,
          refresh.then((response) => response.json()) as Promise<{ superseded?: boolean; callFlow?: { enabled: boolean } }>,
        ]);
        expect(mutationBody.superseded).toBeUndefined();
        expect(mutationBody.callFlow?.enabled).toBe(true);
        expect(refreshBody).toEqual({ superseded: true });
      } finally {
        if (!existsSync(releasePath)) writeFileSync(releasePath, 'release\n', 'utf8');
        server.stop();
      }
    }, 10_000);

    test.skipIf(process.platform === 'win32')(`${runtime} stale read-only advert refresh yields to a newer settings mutation`, async () => {
      const dataDir = makeDataDir();
      // The read-only GET only probes the node runtime while Call flow is
      // enabled, so enable it in this test's own sandbox. (Before config
      // reads became lazy this worked by accident: earlier tests' settings
      // POSTs leaked callFlow=true through the process-frozen config path.)
      writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ reviewAnalysis: { callFlow: true } }), 'utf8');
      const binDir = mkdtempSync(join(tmpdir(), 'plannotator-call-flow-stale-read-node-'));
      tempDirs.push(binDir);
      const startedPath = join(binDir, 'started');
      const releasePath = join(binDir, 'release');
      const nodePath = join(binDir, 'node');
      writeFileSync(nodePath, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `: > ${JSON.stringify(startedPath)}`,
        `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.02; done`,
        'echo v24.0.0',
        '',
      ].join('\n'), 'utf8');
      chmodSync(nodePath, 0o755);
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const server = await startServer({
        rawPatch: '',
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });

      try {
        const refresh = fetch(`${server.url}/api/review-analysis`);
        await waitForFile(startedPath);
        const mutation = fetch(`${server.url}/api/review-analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ semanticDiff: false, callFlow: true }),
        });
        // Let the server accept the mutation and advance its epoch while the
        // older GET remains blocked in the shared runtime probe.
        await Bun.sleep(50);
        writeFileSync(releasePath, 'release\n', 'utf8');
        const [refreshBody, mutationBody] = await Promise.all([
          refresh.then((response) => response.json()) as Promise<{ superseded?: boolean }>,
          mutation.then((response) => response.json()) as Promise<{ superseded?: boolean; callFlow?: { enabled: boolean } }>,
        ]);
        expect(refreshBody).toEqual({ superseded: true });
        expect(mutationBody.superseded).toBeUndefined();
        expect(mutationBody.callFlow?.enabled).toBe(true);
      } finally {
        if (!existsSync(releasePath)) writeFileSync(releasePath, 'release\n', 'utf8');
        server.stop();
      }
    }, 10_000);
  }
});
