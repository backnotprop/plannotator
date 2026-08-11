import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallFlowInstallStage, CallFlowNodePreflight, CallFlowRuntimeInstallResult } from '@plannotator/shared/call-flow';

// PLANNOTATOR_DATA_DIR is only ever changed INSIDE tests (boot() below) and
// restored to its original value after each one. It must never be overridden
// at module-eval time: bun evaluates every test file's module before running
// tests in one shared process, and Pi's generated/storage.ts caches its data
// dir at import time. A module-eval override here makes storage's cached dir
// and later files' live getPlannotatorDataDir() calls disagree, which is
// exactly the Pi annotate-history / durable-submit CI failure this comment
// guards against. Config writes made by these tests target whatever dir the
// process's config module froze at first import; the snapshot/restore in
// afterAll below keeps those writes from leaking into a real config.json.
const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPort = process.env.PLANNOTATOR_PORT;
const originalPath = process.env.PATH;
const tempDirs: string[] = [];

// ---------------------------------------------------------------------------
// Test seams: both runtimes' call-flow modules are mocked so the endpoint
// tests exercise the coordinator + endpoint wiring against a controllable
// installCallFlowRuntime / preflightCallFlowNode. A real install
// must never run in tests. Everything else in the modules stays real.
//
// bun's mock.module is process-global with no restore, so these overrides
// outlive this file when CI runs the whole suite in one process. That is
// safe here by construction: only these two functions are replaced, nothing
// else in the repo's tests invokes installCallFlowRuntime (the throwing
// default doubles as a guard against any future test accidentally starting
// a real install), and preflight's default stays a harmless ok.
// ---------------------------------------------------------------------------
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

const actualShared = { ...(await import('@plannotator/shared/call-flow')) };
const sharedMock = () => ({
  ...actualShared,
  installCallFlowRuntime: (onStage: (stage: CallFlowInstallStage) => void) => recordedInstall('javascript-typescript', onStage),
  installCallFlowLanguagePack: (id: string, onStage: (stage: CallFlowInstallStage) => void) => recordedInstall(id, onStage),
  preflightCallFlowNode: () => preflightImpl(),
});
mock.module('@plannotator/shared/call-flow', sharedMock);
mock.module('../shared/call-flow.ts', sharedMock);

const actualPi = { ...(await import('../../apps/pi-extension/generated/call-flow.ts')) };
mock.module('../../apps/pi-extension/generated/call-flow.ts', () => ({
  ...actualPi,
  installCallFlowRuntime: (onStage: (stage: CallFlowInstallStage) => void) => recordedInstall('javascript-typescript', onStage),
  installCallFlowLanguagePack: (id: string, onStage: (stage: CallFlowInstallStage) => void) => recordedInstall(id, onStage),
  preflightCallFlowNode: () => preflightImpl(),
}));

const { startReviewServer: startBunReviewServer } = await import('./review');
const { startReviewServer: startPiReviewServer } = await import('../../apps/pi-extension/server');

// Best-effort config hygiene: the /api/review-analysis POSTs below persist
// { callFlow: true } through the process's frozen config module. When this
// file runs on its own, that is the developer's real config.json; snapshot
// it now (env is untouched at this point, so this is the same dir the config
// module freezes to in an isolated run) and restore it after the suite so a
// test run never flips a real setting.
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
} = actualShared;

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

/** Write a runtime layout the REAL resolveCallFlowRuntime accepts as installed. */
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

/** Put a fake `node` that reports v24.0.0 first on PATH (POSIX only). */
function installFakeNode(): void {
  const binDir = makeTempDir('plannotator-call-flow-fake-node-');
  const nodePath = join(binDir, 'node');
  writeFileSync(nodePath, '#!/usr/bin/env bash\necho v24.0.0\n', 'utf8');
  chmodSync(nodePath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
}

afterEach(() => {
  // Restore every process-global this file's tests touched (delete when a
  // variable was originally unset). Later test files in the same process
  // must observe exactly the environment they would see standalone.
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
  // Undo the config writes the advert tests persisted (see the snapshot
  // comment above): put the original config.json bytes back, or remove the
  // file when there was none.
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
        // A rejected cross-origin POST leaves the machine idle.
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

        // A third POST while running still joins instead of restarting.
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
        message: 'Call flow requires Node.js 22 or newer, which was not found on PATH.',
      });
      try {
        const status = await fetch(`${server.url}/api/call-flow/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((response) => response.json() as Promise<InstallStatusBody>);
        expect(status).toEqual({
          state: 'error',
          reason: 'node-unavailable',
          error: 'Call flow requires Node.js 22 or newer, which was not found on PATH.',
          languageIds: ['javascript-typescript'],
        });
        expect(installCalls).toBe(0);
        // The error persists on the status endpoint until the next POST.
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
          // Enable Call flow; the runtime is not installed yet, so the advert
          // is the runtime-missing flavor of unavailable, and this response
          // also primes the service's 30s runtime probe cache.
          const before = await fetch(`${server.url}/api/review-analysis`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callFlow: true }),
          }).then((response) => response.json()) as { callFlow?: { state: string; available: boolean } };
          expect(before.callFlow?.state).toBe('unavailable');

          await fetch(`${server.url}/api/call-flow/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          await waitForInstallState(server.url, 'done');

          // Without probe-cache invalidation this re-advertisement would
          // still read the cached unavailable resolution for up to 30s.
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
