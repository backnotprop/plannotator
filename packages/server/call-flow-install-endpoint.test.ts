import { afterEach, describe, expect, mock, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallFlowInstallStage, CallFlowNodePreflight, CallFlowRuntimeInstallResult } from '@plannotator/shared/call-flow';

// The base data dir must be pinned BEFORE the server modules load: config.ts
// freezes its config path at import time. Runtime-dir resolution reads the
// env live, so tests still get per-test runtime isolation below.
const baseDataDir = mkdtempSync(join(tmpdir(), 'plannotator-call-flow-install-'));
process.env.PLANNOTATOR_DATA_DIR = baseDataDir;
const originalPort = process.env.PLANNOTATOR_PORT;
const originalPath = process.env.PATH;
const tempDirs: string[] = [baseDataDir];

// ---------------------------------------------------------------------------
// Test seams: both runtimes' call-flow modules are mocked so the endpoint
// tests exercise the coordinator + endpoint wiring against a controllable
// installCallFlowRuntime / preflightCallFlowNode. The real ~800 MB install
// must never run in tests. Everything else in the modules stays real.
// ---------------------------------------------------------------------------
let installCalls = 0;
let installImpl: (onStage: (stage: CallFlowInstallStage) => void) => Promise<CallFlowRuntimeInstallResult> =
  async () => {
    throw new Error('installImpl not configured for this test');
  };
let preflightImpl: () => Promise<CallFlowNodePreflight> = async () => ({ ok: true });

const recordedInstall = (onStage: (stage: CallFlowInstallStage) => void = () => {}) => {
  installCalls++;
  return installImpl(onStage);
};

const actualShared = { ...(await import('@plannotator/shared/call-flow')) };
const sharedMock = () => ({
  ...actualShared,
  installCallFlowRuntime: recordedInstall,
  preflightCallFlowNode: () => preflightImpl(),
});
mock.module('@plannotator/shared/call-flow', sharedMock);
mock.module('../shared/call-flow.ts', sharedMock);

const actualPi = { ...(await import('../../apps/pi-extension/generated/call-flow.ts')) };
mock.module('../../apps/pi-extension/generated/call-flow.ts', () => ({
  ...actualPi,
  installCallFlowRuntime: recordedInstall,
  preflightCallFlowNode: () => preflightImpl(),
}));

const { startReviewServer: startBunReviewServer } = await import('./review');
const { startReviewServer: startPiReviewServer } = await import('../../apps/pi-extension/server');
const {
  CALLDIFF_COMMIT,
  CALLDIFF_GRAMMAR_SPECS,
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
  writeFileSync(join(packageRoot, 'dist', 'index.js'), 'export const runDiff = () => {};\n');
  writeFileSync(join(runtimeDir, '.calldiff-revision'), `${CALLDIFF_COMMIT}\n`);
  const lockSource = join(import.meta.dir, '..', 'shared', 'call-flow-runtime', 'package-lock.json');
  writeFileSync(join(runtimeDir, 'package-lock.json'), readFileSync(lockSource));
  for (const spec of CALLDIFF_GRAMMAR_SPECS) {
    const name = spec.startsWith('@') ? spec.slice(0, spec.indexOf('@', 1)) : spec.slice(0, spec.lastIndexOf('@'));
    mkdirSync(join(runtimeDir, 'node_modules', ...name.split('/')), { recursive: true });
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
  process.env.PLANNOTATOR_DATA_DIR = baseDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  installCalls = 0;
  installImpl = async () => {
    throw new Error('installImpl not configured for this test');
  };
  preflightImpl = async () => ({ ok: true });
});

process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('Call flow install endpoints', () => {
  for (const [runtime, startServer] of [
    ['Bun', startBunReviewServer],
    ['Pi', startPiReviewServer],
  ] as const) {
    const boot = async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-call-flow-rt-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      return await startServer({
        rawPatch: '',
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
          fetch(`${server.url}/api/call-flow/install`, { method: 'POST', headers: { Origin: sameOrigin } })
            .then((response) => response.json() as Promise<InstallStatusBody>),
          fetch(`${server.url}/api/call-flow/install`, { method: 'POST' })
            .then((response) => response.json() as Promise<InstallStatusBody>),
        ]);
        expect(first).toEqual({ state: 'running', stage: 'downloading' });
        expect(second).toEqual({ state: 'running', stage: 'downloading' });
        expect(installCalls).toBe(1);

        emitStage?.('installing-deps');
        expect(await getInstallStatus(server.url)).toEqual({ state: 'running', stage: 'installing-deps' });
        emitStage?.('building');
        expect(await getInstallStatus(server.url)).toEqual({ state: 'running', stage: 'building' });

        // A third POST while running still joins instead of restarting.
        const third = await fetch(`${server.url}/api/call-flow/install`, { method: 'POST' })
          .then((response) => response.json() as Promise<InstallStatusBody>);
        expect(third.state).toBe('running');
        expect(installCalls).toBe(1);

        gate.resolve({ ok: true, status: 'installed', runtimeDir: '/tmp/rt', message: 'installed' });
        expect(await waitForInstallState(server.url, 'done')).toEqual({ state: 'done' });
      } finally {
        gate.resolve({ ok: true, status: 'installed', runtimeDir: '/tmp/rt', message: 'installed' });
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
        const status = await fetch(`${server.url}/api/call-flow/install`, { method: 'POST' })
          .then((response) => response.json() as Promise<InstallStatusBody>);
        expect(status).toEqual({
          state: 'error',
          reason: 'node-unavailable',
          error: 'Call flow requires Node.js 22 or newer, which was not found on PATH.',
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
        await fetch(`${server.url}/api/call-flow/install`, { method: 'POST' });
        expect(await waitForInstallState(server.url, 'error')).toEqual({ state: 'error', error: 'npm ci failed' });

        installImpl = async () => ({ ok: true, status: 'installed', runtimeDir: '/tmp/rt', message: 'installed' });
        const retried = await fetch(`${server.url}/api/call-flow/install`, { method: 'POST' })
          .then((response) => response.json() as Promise<InstallStatusBody>);
        expect(retried).toEqual({ state: 'running', stage: 'downloading' });
        expect(await waitForInstallState(server.url, 'done')).toEqual({ state: 'done' });
        expect(installCalls).toBe(2);
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
          return { ok: true, status: 'installed', runtimeDir: getCallFlowManagedRuntimeDir(), message: 'installed' };
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

          await fetch(`${server.url}/api/call-flow/install`, { method: 'POST' });
          await waitForInstallState(server.url, 'done');

          // Without probe-cache invalidation this re-advertisement would
          // still read the cached unavailable resolution for up to 30s.
          const after = await fetch(`${server.url}/api/review-analysis`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }).then((response) => response.json()) as { callFlow?: { state: string; available: boolean } };
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
