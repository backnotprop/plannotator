import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallFlowInstallStage, CallFlowNodePreflight, CallFlowRuntimeInstallResult } from '@plannotator/shared/call-flow';

// PLANNOTATOR_DATA_DIR is only changed inside tests and restored after each: module-eval overrides would leak into other files (Bun runs the suite in one process).
const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPort = process.env.PLANNOTATOR_PORT;
const originalPath = process.env.PATH;
const tempDirs: string[] = [];

// Both review servers take the coordinator's install and Node preflight through the test-only `callFlowInstall` option, so no real install runs and nothing is replaced module-wide.
let installCalls = 0;
let installedTargets: string[] = [];
let installImpl: (onStage: (stage: CallFlowInstallStage) => void) => Promise<CallFlowRuntimeInstallResult> =
  async () => {
    throw new Error('installImpl not configured for this test');
  };
let preflightImpl: () => Promise<CallFlowNodePreflight> = async () => ({ ok: true });

const recordedInstall = (target: string, onStage: (stage: CallFlowInstallStage) => void = () => {}) => {
  installCalls++;
  installedTargets.push(target);
  return installImpl(onStage);
};
const callFlowInstall = {
  install: recordedInstall,
  preflight: () => preflightImpl(),
};

const { startReviewServer: startBunReviewServer } = await import('./review');
const { startReviewServer: startPiReviewServer } = await import('../../apps/pi-extension/server');

// Best-effort config hygiene: the POSTs persist { callFlow: true } through the frozen config module, which when run alone is the developer's real config.json; snapshot it and restore it after the suite.
const { getPlannotatorDataDir } = await import('@plannotator/shared/data-dir');
const realConfigPath = join(getPlannotatorDataDir(), 'config.json');
let realConfigSnapshot: Buffer | null = null;
try {
  realConfigSnapshot = readFileSync(realConfigPath);
} catch {
  realConfigSnapshot = null;
}
const {
  CALLDIFF_COMMIT,
  CALLDIFF_VERSION,
  getCallFlowManagedRuntimeDir,
} = await import('@plannotator/shared/call-flow');

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface InstallStatusBody {
  state: string;
  stage?: string;
  languageIds?: string[];
  currentLanguageId?: string;
  error?: string;
  reason?: string;
}

async function getInstallStatus(serverUrl: string): Promise<InstallStatusBody> {
  return await fetch(`${serverUrl}/api/call-flow/install-status`).then(
    (response) => response.json() as Promise<InstallStatusBody>,
  );
}

async function waitForInstallState(serverUrl: string, state: string): Promise<InstallStatusBody> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const status = await getInstallStatus(serverUrl);
    if (status.state === state) return status;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for install state ${state}`);
}

function materializeFakeRuntime(): void {
  const runtimeDir = getCallFlowManagedRuntimeDir();
  const packageRoot = join(runtimeDir, 'node_modules', 'calldiff');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'calldiff', version: CALLDIFF_VERSION }));
  writeFileSync(join(packageRoot, 'dist', 'run.js'), 'export const runDiff = () => {};\n');
  writeFileSync(join(runtimeDir, '.calldiff-revision'), `${CALLDIFF_COMMIT}\n`);
  const lockSource = join(import.meta.dir, '..', 'shared', 'call-flow-runtime', 'package-lock.json');
  writeFileSync(join(runtimeDir, 'package-lock.json'), readFileSync(lockSource));
  for (const [name, version] of [
    ['tree-sitter', '0.25.1'],
    ['tree-sitter-javascript', '0.25.0'],
    ['tree-sitter-typescript', '0.23.2'],
  ] as const) {
    const dependencyRoot = join(runtimeDir, 'node_modules', name);
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(join(dependencyRoot, 'package.json'), JSON.stringify({ name, version }));
  }
}

function installFakeNode(): void {
  const binDir = makeTempDir('plannotator-call-flow-fake-node-');
  const nodePath = join(binDir, 'node');
  writeFileSync(nodePath, '#!/usr/bin/env bash\necho v24.0.0\n', 'utf8');
  chmodSync(nodePath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
}

afterEach(() => {
  // Restore every process-global these tests touched (delete when originally unset), so later files see the environment they would see standalone.
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  installCalls = 0;
  installedTargets = [];
  installImpl = async () => {
    throw new Error('installImpl not configured for this test');
  };
  preflightImpl = async () => ({ ok: true });
});

afterAll(() => {
  // Undo the config writes the advert tests persisted: put the original config.json bytes back, or remove the file when there was none.
  try {
    if (realConfigSnapshot === null) rmSync(realConfigPath, { force: true });
    else writeFileSync(realConfigPath, realConfigSnapshot);
  } catch {
    // Best effort: an unwritable config dir must not fail the suite.
  }
});

process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('Call flow install endpoints', () => {
  for (const [runtime, startServer] of [
    ['Bun', startBunReviewServer],
    ['Pi', startPiReviewServer],
  ] as const) {
    const boot = async (options: { rawPatch?: string; coreInstalled?: boolean } = {}) => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-call-flow-rt-');
      if (options.coreInstalled) materializeFakeRuntime();
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      return await startServer({
        rawPatch: options.rawPatch ?? '',
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
        callFlowInstall,
      });
    };

    test(`${runtime} starts idle and rejects a cross-origin install POST before any work`, async () => {
      const server = await boot();
      try {
        expect(await getInstallStatus(server.url)).toEqual({ state: 'idle' });

        const crossOrigin = await fetch(`${server.url}/api/call-flow/install`, {
          method: 'POST',
          headers: { Origin: 'https://evil.example' },
        });
        expect(crossOrigin.status).toBe(403);
        expect(installCalls).toBe(0);
        expect(await getInstallStatus(server.url)).toEqual({ state: 'idle' });
      } finally {
        server.stop();
      }
    });

    test(`${runtime} rejects malformed install JSON without starting work`, async () => {
      const server = await boot();
      try {
        const response = await fetch(`${server.url}/api/call-flow/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not-json',
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid call-flow install request' });
        expect(installCalls).toBe(0);
        expect(await getInstallStatus(server.url)).toEqual({ state: 'idle' });
      } finally {
        server.stop();
      }
    });

    test(`${runtime} single-flights concurrent POSTs and reports staged progress through done`, async () => {
      const server = await boot();
      const gate = deferred<CallFlowRuntimeInstallResult>();
      let emitStage: ((stage: CallFlowInstallStage) => void) | undefined;
      installImpl = (onStage) => {
        emitStage = onStage;
        return gate.promise;
      };
      try {
        const sameOrigin = new URL(server.url).origin;
        const [first, second] = await Promise.all([
          fetch(`${server.url}/api/call-flow/install`, { method: 'POST', headers: { Origin: sameOrigin, 'Content-Type': 'application/json' }, body: '{}' })
            .then((response) => response.json() as Promise<InstallStatusBody>),
          fetch(`${server.url}/api/call-flow/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then((response) => response.json() as Promise<InstallStatusBody>),
        ]);
        expect(first).toEqual({ state: 'running', stage: 'downloading', languageIds: ['javascript-typescript'] });
        expect(second).toEqual({ state: 'running', stage: 'downloading', languageIds: ['javascript-typescript'] });
        expect(installCalls).toBe(1);

        emitStage?.('installing-deps');
        expect(await getInstallStatus(server.url)).toEqual({ state: 'running', stage: 'installing-deps', languageIds: ['javascript-typescript'], currentLanguageId: 'javascript-typescript' });
        emitStage?.('building');
        expect(await getInstallStatus(server.url)).toEqual({ state: 'running', stage: 'building', languageIds: ['javascript-typescript'], currentLanguageId: 'javascript-typescript' });

        const third = await fetch(`${server.url}/api/call-flow/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((response) => response.json() as Promise<InstallStatusBody>);
        expect(third.state).toBe('running');
        expect(installCalls).toBe(1);

        gate.resolve({ ok: true, status: 'installed', runtimeDir: '/tmp/rt', languageId: 'javascript-typescript', message: 'installed' });
        expect(await waitForInstallState(server.url, 'done')).toEqual({ state: 'done', languageIds: ['javascript-typescript'] });
      } finally {
        gate.resolve({ ok: true, status: 'installed', runtimeDir: '/tmp/rt', languageId: 'javascript-typescript', message: 'installed' });
        server.stop();
      }
    });

    test(`${runtime} reports a missing Node as a distinct immediate error and never installs`, async () => {
      const server = await boot();
      preflightImpl = async () => ({
        ok: false,
        reason: 'node-unavailable',
        message: 'Call flow needs Node.js 22.18 or newer, which was not found on PATH.',
      });
      try {
        const status = await fetch(`${server.url}/api/call-flow/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((response) => response.json() as Promise<InstallStatusBody>);
        expect(status).toEqual({
          state: 'error',
          reason: 'node-unavailable',
          error: 'Call flow needs Node.js 22.18 or newer, which was not found on PATH.',
          languageIds: ['javascript-typescript'],
        });
        expect(installCalls).toBe(0);
        expect(await getInstallStatus(server.url)).toMatchObject({ state: 'error', reason: 'node-unavailable' });
      } finally {
        server.stop();
      }
    });

    test(`${runtime} persists an install failure as error and retries on the next POST`, async () => {
      const server = await boot();
      installImpl = async () => ({ ok: false, status: 'failed', runtimeDir: '/tmp/rt', message: 'npm ci failed' });
      try {
        await fetch(`${server.url}/api/call-flow/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        expect(await waitForInstallState(server.url, 'error')).toEqual({
          state: 'error',
          error: 'npm ci failed',
          languageIds: ['javascript-typescript'],
          currentLanguageId: 'javascript-typescript',
        });

        installImpl = async () => ({ ok: true, status: 'installed', runtimeDir: '/tmp/rt', languageId: 'javascript-typescript', message: 'installed' });
        const retried = await fetch(`${server.url}/api/call-flow/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((response) => response.json() as Promise<InstallStatusBody>);
        expect(retried).toEqual({ state: 'running', stage: 'downloading', languageIds: ['javascript-typescript'] });
        expect(await waitForInstallState(server.url, 'done')).toEqual({ state: 'done', languageIds: ['javascript-typescript'] });
        expect(installCalls).toBe(2);
      } finally {
        server.stop();
      }
    });

    test.skipIf(process.platform === 'win32')(`${runtime} derives the default pack target from changed files`, async () => {
      installFakeNode();
      const rawPatch = [
        'diff --git a/tool.py b/tool.py',
        '--- a/tool.py',
        '+++ b/tool.py',
        '@@ -1 +1 @@',
        '-pass',
        '+print("changed")',
      ].join('\n');
      const server = await boot({ rawPatch, coreInstalled: true });
      installImpl = async () => ({ ok: true, status: 'installed', runtimeDir: '/tmp/rt', languageId: 'python', message: 'installed' });
      try {
        const started = await fetch(`${server.url}/api/call-flow/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).then((response) => response.json()) as InstallStatusBody;
        expect(started).toMatchObject({ state: 'running', languageIds: ['python'] });
        expect(await waitForInstallState(server.url, 'done')).toMatchObject({ state: 'done', languageIds: ['python'] });
        expect(installedTargets).toEqual(['python']);
      } finally {
        server.stop();
      }
    });

    test.skipIf(process.platform === 'win32')(`${runtime} prepends only core to an explicit manual language request`, async () => {
      installFakeNode();
      const rawPatch = [
        'diff --git a/tool.py b/tool.py',
        '--- a/tool.py',
        '+++ b/tool.py',
        '@@ -1 +1 @@',
        '-pass',
        '+print("changed")',
      ].join('\n');
      const server = await boot({ rawPatch });
      installImpl = async (id) => ({ ok: true, status: 'installed', runtimeDir: '/tmp/rt', languageId: id, message: 'installed' });
      try {
        const started = await fetch(`${server.url}/api/call-flow/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ languageIds: ['ruby'] }),
        }).then((response) => response.json()) as InstallStatusBody;
        expect(started).toMatchObject({ state: 'running', languageIds: ['javascript-typescript', 'ruby'] });
        expect(await waitForInstallState(server.url, 'done')).toMatchObject({ state: 'done', languageIds: ['javascript-typescript', 'ruby'] });
        expect(installedTargets).toEqual(['javascript-typescript', 'ruby']);
      } finally {
        server.stop();
      }
    });

    test.skipIf(process.platform === 'win32')(
      `${runtime} flips the capability advert to available on done without a server restart`,
      async () => {
        installFakeNode();
        const server = await boot();
        installImpl = async () => {
          materializeFakeRuntime();
          return { ok: true, status: 'installed', runtimeDir: getCallFlowManagedRuntimeDir(), languageId: 'javascript-typescript', message: 'installed' };
        };
        try {
          // The runtime is not installed, so the advert is the runtime-missing flavor of unavailable; this response also primes the service's 30s runtime probe cache.
          const before = await fetch(`${server.url}/api/review-analysis`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callFlow: true }),
          }).then((response) => response.json()) as { callFlow?: { state: string; available: boolean } };
          expect(before.callFlow?.state).toBe('unavailable');

          await fetch(`${server.url}/api/call-flow/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          await waitForInstallState(server.url, 'done');

          // Without probe-cache invalidation this re-advertisement would still read the cached unavailable resolution for up to 30s.
          const after = await fetch(`${server.url}/api/review-analysis`)
            .then((response) => response.json()) as { callFlow?: { state: string; available: boolean } };
          expect(after.callFlow?.state).toBe('available');
          expect(after.callFlow?.available).toBe(true);
        } finally {
          server.stop();
        }
      },
      15_000,
    );
  }
});
